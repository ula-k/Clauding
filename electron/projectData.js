// Projects view: the service behind the window. For one project it reads
// ClickUp (through a cache on disk), the user's checkouts, GitHub and the
// Claude Code sessions, and hands buildProjectSnapshot everything it needs.
//
// Two files per project in <userData>/project-cache/:
//   <board id>.json           what ClickUp said (tasks, time in status,
//                             phases), merged refresh after refresh;
//   <board id>.snapshot.json  the whole computed view plus what git and
//                             GitHub said, so the view draws at once — on
//                             app start, offline — without any network.
// The window shows the last snapshot first and asks for a refresh in the
// background; refreshAll runs on app start and every ten minutes. A failed
// refresh keeps both files and says so (sources.clickup.ok = false, with
// the time of the data shown).
//
// A refresh asks ClickUp only for the tasks changed since the last one
// (date_updated_gt) and merges them into the copy; the whole lists are read
// again once an hour (deleted or moved tasks drop out then). Time in status
// is asked for the tasks whose status moved. ClickUp, git and GitHub are
// asked at the same time, and each phase's time goes to the log.
//
// Finding the lists: a project is set up from one ClickUp link — a list, a
// saved view, a folder or a space (resolveProjectLink), or one task of the
// project (the seed: the build list is the seed task's list). With a folder
// or a space every list in it is read once and the build list is the one
// whose tasks depend on another list's (lib/listDiscovery.js). The planning
// list (the tasks that carry the spec links) is found through ClickUp's
// dependencies: the list of a task a build task "depends on", when that is
// another list. Both are written back to the project once found, so this
// happens once; the settings sheet can change either by hand.
//
// CLAUDING_PROJECTS_FIXTURE=<file.json> replaces ClickUp, git, gh and the
// project list itself with the file's contents — screenshots and smoke
// tests never touch the user's ClickUp, repositories or project-boards.json.
// The file is either one project ({ board, buildTasks, planningTasks, … })
// or several ({ boards: { "<id>": { board, … } } }); `clickup` in a project
// replaces the ClickUp state (e.g. { "ok": false, "error": "no-token" }).
import fs from "node:fs";
import path from "node:path";
import { ClickupError, createClickupClient, mapComment, mapTask, parseClickupLink, readClickupToken } from "./lib/clickupClient.js";
import { chooseProjectLists } from "./lib/listDiscovery.js";
import { bucketForStatus, specStageForStatus } from "./lib/statusBuckets.js";
import { automaticPerspective, detectDeveloperStatusField } from "./lib/perspective.js";
import {
  MILESTONE_TYPE_ID,
  chooseDeadlineSource,
  cleanDeadlineSource,
  datedItems,
  listCandidates,
  planLikeLists,
  roadmapCandidates
} from "./lib/deadlineSources.js";
import { fetchRepository, inspectRepository } from "./lib/gitInspector.js";
import { listPullRequests } from "./lib/pullRequests.js";
import { buildProjectSnapshot, linkedTaskOfSession } from "./lib/projectSnapshot.js";
import { branchTaskMap, tasksFromBranches, usesClickup } from "./lib/gitTasks.js";
import { cleanBoard } from "./projectBoards.js";

const CACHE_FRESH_MILLISECONDS = 5 * 60 * 1000;
// A folder or space with more lists than this is not read list by list; the
// user picks the build list from the candidates instead.
const MAXIMUM_LISTS_TO_DISCOVER = 12;
// How many dependencies are tried when looking for the planning list.
const PLANNING_LOOKUPS = 3;
// Status changes this app saw between two refreshes (for tasks ClickUp gave
// no history for), newest kept.
const MAXIMUM_STATUS_MOVES = 2000;
// Where the phases are kept is looked for again once a day at most.
const DEADLINE_DISCOVERY_FRESH_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAXIMUM_ROADMAP_PARENTS = 12;
// The whole lists are read again at least this often; in between only the
// changed tasks are.
const FULL_LIST_EVERY_MILLISECONDS = 60 * 60 * 1000;
// "Changed since" reaches back this much further than the last read, so a
// task changed while it ran (or a clock a little off) is not missed.
const CHANGED_SINCE_OVERLAP_MILLISECONDS = 2 * 60 * 1000;

// The last copy of a list with the tasks ClickUp says changed since: a
// changed task replaces its old copy, a new one is added, and — when the
// project leaves closed tasks out — one that was closed meanwhile drops out.
export function mergeChangedTasks(previousTasks, changedTasks, { includeClosed = true } = {}) {
  const changedById = new Map(changedTasks.map((task) => [task.id, task]));
  const merged = previousTasks.map((task) => changedById.get(task.id) || task);
  const known = new Set(previousTasks.map((task) => task.id));
  merged.push(...changedTasks.filter((task) => !known.has(task.id)));
  return includeClosed ? merged : merged.filter((task) => task.statusType !== "closed");
}

// The tasks whose time in status has to be asked for: the ones not asked
// yet, and the ones whose status is not what it was at the last read.
export function tasksNeedingHistory(tasks, previousTasks, previousHistory) {
  const statusBefore = new Map((previousTasks || []).map((task) => [task.id, task.status]));
  return tasks.filter((task) => !(previousHistory && previousHistory[task.id]) || statusBefore.get(task.id) !== task.status);
}

function seconds(milliseconds) {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${Math.round(milliseconds)} ms`;
}

export class ProjectLinkError extends Error {
  constructor(key, values = {}) {
    super(key);
    this.name = "ProjectLinkError";
    // A key of the locale files (projects.linkError.*), so the window can
    // say it in the user's language.
    this.key = key;
    this.values = values;
  }
}

function readJsonQuietly(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

export function createProjectDataService({
  boardStore,
  cacheDirectory,
  getSessions,
  getAgents,
  readToken = readClickupToken,
  fetchImplementation = globalThis.fetch,
  inspectRepositoryImplementation = inspectRepository,
  listPullRequestsImplementation = listPullRequests,
  fetchRepositoryImplementation = fetchRepository,
  readSessionOpeningImplementation = () => null,
  fixturePath = process.env.CLAUDING_PROJECTS_FIXTURE || null,
  now = () => Date.now(),
  log = () => {},
  // Told about every background refresh: { boardId, refreshing: true } when
  // it starts, { boardId, refreshing: false, snapshot } when it ends.
  onRefresh = () => {}
}) {
  let clientPromise = null;
  const refreshesInFlight = new Map();
  const snapshotRefreshesInFlight = new Map();
  const fixture = fixturePath ? readJsonQuietly(fixturePath) : null;

  // The first user messages of each session, for task linking (read from
  // the head of the transcript once; see lib/transcriptOpening.js).
  const openingBySession = new Map();

  // The client is kept only while it has a token: with none, the Keychain
  // is asked again next time, so adding the item works without a restart.
  function client() {
    if (!clientPromise) {
      clientPromise = readToken().then((token) => {
        if (!token) {
          clientPromise = null;
        }
        return createClickupClient({ token, fetchImplementation });
      });
    }
    return clientPromise;
  }

  // A token ClickUp refused (or none) is forgotten, so the next refresh
  // reads the Keychain again.
  function forgetClientOn(error) {
    if (error && (error.kind === "no-token" || error.kind === "unauthorized")) {
      clientPromise = null;
    }
  }

  function cachePath(boardId) {
    return path.join(cacheDirectory, `${boardId}.json`);
  }

  function readCache(boardId) {
    const cached = readJsonQuietly(cachePath(boardId));
    if (!cached || !Array.isArray(cached.buildTasks)) {
      return null;
    }
    return cached;
  }

  function writeFileSafely(filePath, data) {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const temporaryPath = `${filePath}.writing`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data));
    fs.renameSync(temporaryPath, filePath);
  }

  function writeCache(boardId, data) {
    writeFileSafely(cachePath(boardId), data);
  }

  function storedSnapshotPath(boardId) {
    return path.join(cacheDirectory, `${boardId}.snapshot.json`);
  }

  // { savedAt, snapshot, repositoryResults, pullRequestResults } or null.
  function readStoredSnapshot(boardId) {
    const stored = readJsonQuietly(storedSnapshotPath(boardId));
    return stored && stored.snapshot ? stored : null;
  }

  function storeSnapshot(boardId, snapshotData, { repositoryResults, pullRequestResults }) {
    try {
      writeFileSafely(storedSnapshotPath(boardId), { savedAt: now(), snapshot: snapshotData, repositoryResults, pullRequestResults });
    } catch (error) {
      log(`[projects] could not keep the snapshot of ${boardId}: ${error.message}`);
    }
  }

  async function resolveLists(board, clickup) {
    const lists = { ...board.clickup };
    let changed = false;
    if (!lists.buildListId && lists.seedTaskId) {
      const seed = await clickup.getTask(lists.seedTaskId);
      lists.buildListId = seed.listId;
      lists.buildListName = seed.listName;
      changed = true;
    }
    return { lists, changed };
  }

  // One list: only what changed since the last read, merged into it, when
  // that copy is recent and complete; else the whole list.
  async function readList(clickup, listId, { includeClosed, previousTasks, previousPages, changedSince }) {
    if (previousTasks && Number.isFinite(changedSince)) {
      const changed = await clickup.listTasks(listId, { includeClosed: true, updatedAfter: changedSince });
      if (!changed.truncated) {
        const tasks = mergeChangedTasks(previousTasks, changed, { includeClosed });
        tasks.truncated = false;
        return { tasks, whole: false, changed: changed.length, pages: previousPages || 1 };
      }
    }
    const tasks = await clickup.listTasks(listId, { includeClosed, expectedPages: previousPages || 1 });
    return { tasks, whole: true, changed: tasks.length, pages: tasks.pagesRead || 1 };
  }

  async function fetchClickup(board, timings = {}) {
    const timed = async (name, work) => {
      const startedAt = Date.now();
      try {
        return await work;
      } finally {
        timings[name] = Date.now() - startedAt;
      }
    };
    const clickup = await client();
    const { lists, changed } = await resolveLists(board, clickup);
    if (!lists.buildListId) {
      throw new ClickupError("This project has no ClickUp list yet.", { kind: "no-list" });
    }
    // Every task and subtask, closed ones too unless the project turned
    // that off (Settings → General).
    const includeClosed = board.includeClosed !== false;
    const previous = readCache(board.id);
    const listedAt = now();
    // Only the changes, when the last copy is of the same lists, read the
    // same way, complete, and its whole lists were read within the hour.
    const previousLists = (previous && previous.lists) || {};
    const canMerge = Boolean(
      previous &&
        !previous.gitOnly &&
        Number.isFinite(previous.listedAt) &&
        Number.isFinite(previous.wholeListsAt) &&
        listedAt - previous.wholeListsAt < FULL_LIST_EVERY_MILLISECONDS &&
        (previous.includeClosed !== false) === includeClosed &&
        !(previous.truncated && (previous.truncated.buildTasks || previous.truncated.planningTasks))
    );
    const changedSince = canMerge ? previous.listedAt - CHANGED_SINCE_OVERLAP_MILLISECONDS : null;
    const previousPages = (previous && previous.pages) || {};
    const buildRead = timed(
      "buildList",
      readList(clickup, lists.buildListId, {
        includeClosed,
        previousTasks: canMerge && previousLists.buildListId === lists.buildListId ? previous.buildTasks : null,
        previousPages: previousPages.buildTasks,
        changedSince
      })
    );
    let planningChanged = false;
    const findPlanningList = async () => {
      if (lists.planningListId) {
        return;
      }
      const { tasks: buildTasks } = await buildRead;
      const dependencyIds = [...new Set(buildTasks.flatMap((task) => task.dependsOn).filter(Boolean))];
      const ownIds = new Set(buildTasks.map((task) => task.id));
      for (const dependencyId of dependencyIds.filter((candidate) => !ownIds.has(candidate)).slice(0, PLANNING_LOOKUPS)) {
        let planningTask;
        try {
          planningTask = await clickup.getTask(dependencyId);
        } catch (error) {
          continue;
        }
        if (planningTask.listId && planningTask.listId !== lists.buildListId) {
          lists.planningListId = planningTask.listId;
          lists.planningListName = planningTask.listName;
          planningChanged = true;
          break;
        }
      }
    };
    // The planning list is read alongside the build list when it is known.
    const planningRead = timed(
      "planningList",
      findPlanningList().then(() =>
        lists.planningListId
          ? readList(clickup, lists.planningListId, {
              includeClosed,
              previousTasks: canMerge && previousLists.planningListId === lists.planningListId ? previous.planningTasks : null,
              previousPages: previousPages.planningTasks,
              changedSince
            })
          : { tasks: [], whole: true, changed: 0, pages: 0 }
      )
    );
    // Waited on below, after the build list: a failed build list must not
    // leave this one failing unheard.
    planningRead.catch(() => {});
    // "Me" is the owner of the token until the settings say otherwise.
    const ownerRead = board.clickupUserId
      ? Promise.resolve(null)
      : clickup.getCurrentUser().catch((error) => {
          log(`[projects] could not ask ClickUp who the token belongs to: ${error.message}`);
          return null;
        });
    const build = await buildRead;
    const buildTasks = build.tasks;
    // When each build task entered each status: the queue's movement over
    // time. Optional — without it the moves this app saw are used. A failed
    // read keeps the last one instead of wiping it. Only the tasks whose
    // status moved are asked for.
    const historyRead = timed(
      "timeInStatus",
      (async () => {
        const kept = previous && previous.statusHistory ? previous.statusHistory : {};
        // Subtasks too: each one is a unit of work with its own hand-offs.
        const counted = board.countSubtasks === false ? buildTasks.filter((task) => !task.parentId) : buildTasks;
        const needed = tasksNeedingHistory(counted, previous && previous.buildTasks, kept);
        timings.timeInStatusTasks = needed.length;
        const history = {};
        for (const task of counted) {
          if (kept[task.id]) {
            history[task.id] = kept[task.id];
          }
        }
        if (needed.length === 0) {
          return history;
        }
        try {
          return { ...history, ...(await clickup.getStatusHistory(needed.map((task) => task.id))) };
        } catch (error) {
          log(`[projects] no time-in-status for ${board.name}: ${error.message}`);
          return kept;
        }
      })()
    );
    // Deadlines likewise: a failed read keeps the last phases and where they
    // came from, and stamps the attempt so it is not retried on every view.
    const deadlinesRead = timed(
      "deadlines",
      (async () => {
        const kept = {
          items: previous && Array.isArray(previous.deadlineItems) ? previous.deadlineItems : [],
          undated: previous ? previous.deadlineUndated || 0 : 0,
          source: previous ? previous.deadlineSource || null : null,
          discovery: previous ? previous.deadlineDiscovery || null : null
        };
        try {
          return await readDeadlines(clickup, board, lists, buildTasks, kept.discovery);
        } catch (error) {
          log(`[projects] deadlines for ${board.name} could not be read: ${error.message}`);
          return { ...kept, discovery: { candidates: [], chosenId: null, ...(kept.discovery || {}), at: now() } };
        }
      })()
    );
    const [planning, statusHistory, deadlines, owner] = await Promise.all([planningRead, historyRead, deadlinesRead, ownerRead]);
    const planningTasks = planning.tasks;
    const update = {};
    if (changed || planningChanged) {
      update.clickup = lists;
    }
    if (owner && owner.id) {
      update.clickupUserId = owner.id;
    }
    if (Object.keys(update).length > 0) {
      boardStore.updateBoard(board.id, update);
    }
    timings.buildListNote = build.whole ? `whole, ${build.pages} page${build.pages === 1 ? "" : "s"}` : `${build.changed} changed`;
    timings.planningListNote = planning.whole ? `whole, ${planning.pages} page${planning.pages === 1 ? "" : "s"}` : `${planning.changed} changed`;
    const refreshedAt = now();
    const statusMoves = observedMoves(previous, buildTasks, refreshedAt);
    return {
      buildTasks,
      planningTasks,
      includeClosed,
      // A list longer than the pages read: the counts are "at least".
      truncated: { buildTasks: Boolean(buildTasks.truncated), planningTasks: Boolean(planningTasks.truncated) },
      refreshedAt,
      listedAt,
      wholeListsAt: build.whole && planning.whole ? listedAt : previous ? previous.wholeListsAt : listedAt,
      pages: { buildTasks: build.pages, planningTasks: planning.pages },
      lists,
      statusHistory,
      statusMoves,
      deadlineItems: deadlines.items,
      deadlineUndated: deadlines.undated,
      deadlineSource: deadlines.source,
      deadlineDiscovery: deadlines.discovery
    };
  }

  // Where the phases and milestones of a project are kept (see
  // lib/deadlineSources.js): ClickUp's milestones across the workspace and
  // the tasks they hang under, and the plan-like lists of the project's
  // space. Remembered for a day.
  async function discoverDeadlineSources(clickup, board, lists, buildTasks) {
    const workspaceId = (buildTasks.find((task) => task.workspaceId) || {}).workspaceId || null;
    const spaceId = (buildTasks.find((task) => task.spaceId) || {}).spaceId || null;
    const projectNames = [board.name, ...(buildTasks[0] && buildTasks[0].folderName ? [buildTasks[0].folderName] : [])];
    const candidates = [];
    let milestonesTruncated = false;
    if (workspaceId) {
      const milestones = await clickup.listWorkspaceTasksOfTypes(workspaceId, [MILESTONE_TYPE_ID]);
      milestonesTruncated = Boolean(milestones.truncated);
      // The tasks milestones hang under, the ones with the latest dates
      // first (current projects before old ones); only a few are read.
      const latestByParent = new Map();
      for (const milestone of milestones) {
        if (milestone.parentId) {
          const latest = Math.max(milestone.dueDate || 0, milestone.startDate || 0, latestByParent.get(milestone.parentId) || 0);
          latestByParent.set(milestone.parentId, latest);
        }
      }
      const wanted = [...latestByParent.entries()]
        .sort((first, second) => second[1] - first[1])
        .slice(0, MAXIMUM_ROADMAP_PARENTS)
        .map(([parentId]) => parentId);
      const answers = await Promise.all(
        wanted.map((parentId) =>
          clickup.getTaskWithSubtasks(parentId).catch((error) => {
            log(`[projects] roadmap candidate ${parentId} could not be read: ${error.message}`);
            return null;
          })
        )
      );
      const read = answers.filter(Boolean);
      candidates.push(...roadmapCandidates(read, projectNames).filter((candidate) => candidate.matchesName));
    }
    if (spaceId) {
      const spaceLists = await listsOfSpace(clickup, spaceId);
      const withTasks = await Promise.all(
        planLikeLists(spaceLists).map(async (list) => ({ ...list, tasks: await clickup.listTasks(list.id, { maximumPages: 2 }) }))
      );
      candidates.push(...listCandidates(withTasks));
    }
    const chosen = chooseDeadlineSource(candidates);
    return { candidates, chosenId: chosen ? chosen.id : null, milestonesTruncated, at: now() };
  }

  async function readDeadlines(clickup, board, lists, buildTasks, previousDiscovery) {
    const setting = cleanDeadlineSource(board.deadlineSource);
    let discovery = previousDiscovery;
    if (setting.mode === "auto" && (!discovery || now() - discovery.at > DEADLINE_DISCOVERY_FRESH_MILLISECONDS)) {
      discovery = await discoverDeadlineSources(clickup, board, lists, buildTasks);
    }
    let target = null;
    if (setting.mode === "task" || setting.mode === "list") {
      target = { kind: setting.mode, id: setting.id, name: setting.name };
    } else if (setting.mode === "auto" && discovery && discovery.chosenId) {
      const chosen = discovery.candidates.find((candidate) => candidate.id === discovery.chosenId);
      target = chosen ? { kind: chosen.kind, id: chosen.id, name: chosen.name } : null;
    }
    if (!target) {
      return { items: [], undated: 0, source: { mode: setting.mode, kind: null, id: null, name: null }, discovery };
    }
    const tasks = target.kind === "task" ? (await clickup.getTaskWithSubtasks(target.id)).subtasks : await clickup.listTasks(target.id, { maximumPages: 3 });
    const { items, undated } = datedItems(tasks);
    return { items, undated, source: { mode: setting.mode, ...target }, discovery };
  }

  // Tasks whose status changed since the last copy: { taskId, fromStatus,
  // fromType, toStatus, toType, at }, added to the ones already kept.
  function observedMoves(previous, buildTasks, at) {
    const kept = previous && Array.isArray(previous.statusMoves) ? previous.statusMoves : [];
    if (!previous || !Array.isArray(previous.buildTasks)) {
      return kept;
    }
    const before = new Map(previous.buildTasks.map((task) => [task.id, task]));
    const moves = [];
    for (const task of buildTasks) {
      const old = before.get(task.id);
      if (old && old.status !== task.status) {
        moves.push({ taskId: task.id, fromStatus: old.status, fromType: old.statusType, toStatus: task.status, toType: task.statusType, at });
      }
    }
    return [...kept, ...moves].slice(-MAXIMUM_STATUS_MOVES);
  }

  // One refresh per project at a time; a second ↻ joins the first.
  function refreshClickup(board, timings = {}) {
    if (refreshesInFlight.has(board.id)) {
      return refreshesInFlight.get(board.id);
    }
    const running = fetchClickup(board, timings)
      .then((data) => {
        writeCache(board.id, data);
        return { data, error: null };
      })
      .catch((error) => {
        forgetClientOn(error);
        log(`[projects] ClickUp refresh for ${board.name} failed: ${error.kind || ""} ${error.message}`);
        return { data: null, error };
      })
      .finally(() => refreshesInFlight.delete(board.id));
    refreshesInFlight.set(board.id, running);
    return running;
  }

  async function clickupData(board, { refresh, timings = {} }) {
    const cached = readCache(board.id);
    // A cache read without the closed tasks cannot answer for a project
    // that now wants them (Settings → General).
    const sameClosed = cached && (cached.includeClosed !== false) === (board.includeClosed !== false);
    const fresh = cached && sameClosed && now() - cached.refreshedAt < CACHE_FRESH_MILLISECONDS;
    if (cached && fresh && !refresh) {
      return { data: cached, clickup: { ok: true, error: null, refreshedAt: cached.refreshedAt, fromCache: true } };
    }
    const { data, error } = await refreshClickup(board, timings);
    if (data) {
      return { data, clickup: { ok: true, error: null, refreshedAt: data.refreshedAt, fromCache: false } };
    }
    return {
      data: cached || { buildTasks: [], planningTasks: [], refreshedAt: null },
      clickup: {
        ok: false,
        error: error.kind || "http",
        message: error.message,
        status: error.status || null,
        call: error.call || null,
        refreshedAt: cached ? cached.refreshedAt : null,
        fromCache: true
      }
    };
  }

  // The fixture's projects, each with an id, a name and the fields the
  // store would have cleaned.
  function fixtureInputs() {
    if (!fixture) {
      return [];
    }
    const entries = fixture.boards ? Object.entries(fixture.boards) : [[(fixture.board && fixture.board.id) || "fixture", fixture]];
    return entries.map(([boardId, input]) => ({
      input,
      board: cleanBoard({ name: "Fixture", ...(input.board || {}), id: boardId })
    }));
  }

  function boardFor(boardId) {
    if (fixture) {
      const found = fixtureInputs().find((entry) => entry.board.id === boardId);
      if (!found) {
        throw new Error(`No project with id ${boardId}.`);
      }
      return found;
    }
    return { board: boardStore.getBoard(boardId), input: null };
  }

  function fixtureClickupState(input) {
    return { ok: true, error: null, refreshedAt: now(), fromCache: false, ...(input.clickup || {}) };
  }

  function fixtureSnapshot(board, input, { sessions, agentState }) {
    return buildProjectSnapshot({
      board,
      buildTasks: (input.buildTasks || []).map(mapTask),
      planningTasks: (input.planningTasks || []).map(mapTask),
      sessions: input.sessions || sessions,
      sessionAgents: input.sessionAgents || agentState.sessionAgents,
      agents: input.agents || agentState.agents,
      repositoryResults: input.repositoryResults || [],
      pullRequestResults: input.pullRequestResults || [],
      clickup: fixtureClickupState(input),
      now: input.now || now()
    });
  }

  // The view from ClickUp's copy (`raw`, see fetchClickup) and what git and
  // GitHub said — no network.
  function snapshotFromCopy(board, raw, { sessions, agentState, repositoryResults, pullRequestResults, clickup }) {
    const common = {
      board,
      buildTasks: raw.buildTasks,
      planningTasks: raw.planningTasks || [],
      statusMoves: raw.statusMoves || [],
      sessions,
      sessionAgents: agentState.sessionAgents,
      agents: agentState.agents,
      repositoryResults,
      pullRequestResults,
      transcriptTextBySession: openingTexts(sessions),
      clickup,
      now: now()
    };
    if (raw.gitOnly) {
      return buildProjectSnapshot({ ...common, mode: "git", branchTasks: branchTaskMap(raw.buildTasks, repositoryResults) });
    }
    return buildProjectSnapshot({
      ...common,
      statusHistory: raw.statusHistory || {},
      deadlineItems: raw.deadlineItems || [],
      deadlineInfo: { source: raw.deadlineSource || null, undated: raw.deadlineUndated || 0 },
      truncated: raw.truncated || null
    });
  }

  // snapshot(boardId, options):
  //   { cachedOnly: true }  the last stored snapshot as it was saved (null
  //                         when there is none) — a file read, nothing else;
  //   { local: true }       the view built again from the stored copies with
  //                         the sessions and settings of now — no network,
  //                         no git (null when nothing was ever read);
  //   { refresh: true }     ClickUp, git and GitHub asked again;
  //   {}                    ClickUp's copy when it is younger than five
  //                         minutes, else asked again; git and GitHub asked.
  async function snapshot(boardId, { refresh = false, fetchGit = false, cachedOnly = false, local = false } = {}) {
    const { board, input } = boardFor(boardId);
    if (cachedOnly && !fixture) {
      const stored = readStoredSnapshot(boardId);
      return stored ? stored.snapshot : null;
    }
    const agentState = getAgents();
    const sessions = await getSessions();
    if (fixture) {
      return fixtureSnapshot(board, input, { sessions, agentState });
    }
    if (local) {
      return localSnapshot(board, { sessions, agentState });
    }
    if (!usesClickup(board)) {
      return gitSnapshot(board, { sessions, agentState, fetchGit });
    }
    const startedAt = Date.now();
    const timings = {};
    const timedSince = (name, since) => {
      timings[name] = Date.now() - since;
    };
    // ClickUp's task ids tell git which of the (often hundreds of) CU-
    // branches belong to this project. Git starts at once with the ids of
    // the last copy, alongside ClickUp and GitHub; branches of tasks new
    // since then are looked at afterwards.
    const previous = readCache(board.id);
    const idsOf = (data) => new Set([...(data.buildTasks || []), ...(data.planningTasks || [])].map((task) => String(task.id).toLowerCase()));
    const knownIds = previous ? idsOf(previous) : new Set();
    const gitStartedAt = Date.now();
    const gitRead = Promise.all(
      board.repositories.map(async (repository) => {
        if (fetchGit) {
          try {
            await fetchRepositoryImplementation(repository);
          } catch (error) {
            log(`[projects] git fetch in ${repository.name} failed: ${error.message}`);
          }
        }
        return inspectRepositoryImplementation(repository, { taskIds: knownIds });
      })
    ).finally(() => timedSince("git", gitStartedAt));
    const pullRequestsStartedAt = Date.now();
    const pullRequestsRead = Promise.all(board.repositories.map((repository) => listPullRequestsImplementation(repository))).finally(() =>
      timedSince("pullRequests", pullRequestsStartedAt)
    );
    const clickupStartedAt = Date.now();
    const [{ data, clickup }, firstRepositoryResults, pullRequestResults] = await Promise.all([
      clickupData(board, { refresh, timings }).finally(() => timedSince("clickup", clickupStartedAt)),
      gitRead,
      pullRequestsRead
    ]);
    const newIds = new Set([...idsOf(data)].filter((taskId) => !knownIds.has(taskId)));
    let repositoryResults = firstRepositoryResults;
    if (newIds.size > 0) {
      const newStartedAt = Date.now();
      const extra = await Promise.all(board.repositories.map((repository) => inspectRepositoryImplementation(repository, { taskIds: newIds })));
      repositoryResults = firstRepositoryResults.map((result, index) => ({
        ...result,
        available: result.available || Boolean(extra[index] && extra[index].available),
        branchesByTask: { ...(result.branchesByTask || {}), ...((extra[index] && extra[index].branchesByTask) || {}) }
      }));
      timedSince("gitNewTasks", newStartedAt);
    }
    const buildStartedAt = Date.now();
    const result = snapshotFromCopy(boardStore.getBoard(boardId), data, { sessions, agentState, repositoryResults, pullRequestResults, clickup });
    timedSince("snapshot", buildStartedAt);
    if (clickup.ok || !readStoredSnapshot(boardId)) {
      storeSnapshot(boardId, result, { repositoryResults, pullRequestResults });
    }
    if (!clickup.fromCache || refresh) {
      log(
        `[projects] ${board.name} refreshed in ${seconds(Date.now() - startedAt)}: ClickUp ${seconds(timings.clickup || 0)} (build list ${seconds(timings.buildList || 0)}, ${timings.buildListNote || "cached"}; planning list ${seconds(timings.planningList || 0)}, ${timings.planningListNote || "cached"}; time in status ${seconds(timings.timeInStatus || 0)} for ${timings.timeInStatusTasks || 0} tasks; deadlines ${seconds(timings.deadlines || 0)}) · git ${seconds(timings.git || 0)}${fetchGit ? " with fetch" : ""}${timings.gitNewTasks ? ` + ${seconds(timings.gitNewTasks)} for ${newIds.size} new tasks` : ""} · pull requests ${seconds(timings.pullRequests || 0)} · view ${seconds(timings.snapshot || 0)}`
      );
    }
    return result;
  }

  // The view again from what is on disk, with the sessions and settings of
  // now: after a setting changed, and while the window stays open.
  function localSnapshot(board, { sessions, agentState }) {
    const raw = readCache(board.id);
    const stored = readStoredSnapshot(board.id);
    if (!raw) {
      return stored ? stored.snapshot : null;
    }
    const storedClickup = stored && stored.snapshot.sources && stored.snapshot.sources.clickup;
    const clickup = storedClickup
      ? { ...storedClickup, fromCache: true }
      : { ok: true, error: null, refreshedAt: raw.refreshedAt, fromCache: true, ...(raw.gitOnly ? { disabled: true } : {}) };
    const result = snapshotFromCopy(board, raw, {
      sessions,
      agentState,
      repositoryResults: (stored && stored.repositoryResults) || [],
      pullRequestResults: (stored && stored.pullRequestResults) || [],
      clickup
    });
    storeSnapshot(board.id, result, { repositoryResults: (stored && stored.repositoryResults) || [], pullRequestResults: (stored && stored.pullRequestResults) || [] });
    return result;
  }

  // A refresh the window does not wait on: one per project at a time (a
  // second request joins the first), announced through onRefresh when it
  // starts and when its snapshot is ready. Never throws: a failure keeps the
  // last snapshot on screen.
  function refreshInBackground(boardId, { fetchGit = false } = {}) {
    if (snapshotRefreshesInFlight.has(boardId)) {
      return snapshotRefreshesInFlight.get(boardId);
    }
    onRefresh({ boardId, refreshing: true });
    const running = snapshot(boardId, { refresh: true, fetchGit })
      .catch((error) => {
        log(`[projects] background refresh of ${boardId} failed: ${error.message}`);
        return null;
      })
      .then((result) => {
        snapshotRefreshesInFlight.delete(boardId);
        onRefresh({ boardId, refreshing: false, snapshot: result });
        return result;
      });
    snapshotRefreshesInFlight.set(boardId, running);
    return running;
  }

  // Every project, one after the other (they share ClickUp's rate limit):
  // on app start and every ten minutes (see main.js).
  async function refreshAll() {
    if (fixture) {
      return;
    }
    for (const board of boardStore.getState().boards) {
      await refreshInBackground(board.id);
    }
  }

  // A project without ClickUp: its feature branches are its tasks
  // (lib/gitTasks.js). The answer is cached like ClickUp's, so the project
  // list on the left has its numbers without running git again.
  async function gitSnapshot(board, { sessions, agentState, fetchGit }) {
    const startedAt = Date.now();
    const [repositoryResults, pullRequestResults] = await Promise.all([
      Promise.all(
        board.repositories.map(async (repository) => {
          if (fetchGit) {
            try {
              await fetchRepositoryImplementation(repository);
            } catch (error) {
              log(`[projects] git fetch in ${repository.name} failed: ${error.message}`);
            }
          }
          return inspectRepositoryImplementation(repository, { allBranches: true });
        })
      ),
      Promise.all(board.repositories.map((repository) => listPullRequestsImplementation(repository, { allBranches: true })))
    ]);
    const refreshedAt = now();
    const buildTasks = tasksFromBranches({ repositoryResults, pullRequestResults, now: refreshedAt });
    const previous = readCache(board.id);
    const statusMoves = observedMoves(previous, buildTasks, refreshedAt);
    const raw = { buildTasks, planningTasks: [], refreshedAt, statusMoves, gitOnly: true };
    try {
      writeCache(board.id, raw);
    } catch (error) {
      log(`[projects] could not cache ${board.name}: ${error.message}`);
    }
    const result = snapshotFromCopy(boardStore.getBoard(board.id), raw, {
      sessions,
      agentState,
      repositoryResults,
      pullRequestResults,
      clickup: { ok: true, error: null, refreshedAt, fromCache: false, disabled: true }
    });
    storeSnapshot(board.id, result, { repositoryResults, pullRequestResults });
    log(`[projects] ${board.name} (git only) refreshed in ${seconds(Date.now() - startedAt)}`);
    return result;
  }

  // The first user messages of every listed session, read once per session
  // (a conversation's opening does not change). Sessions whose transcript
  // cannot be read yet are asked again next time.
  function openingTexts(sessions) {
    const texts = {};
    for (const session of sessions || []) {
      let known = openingBySession.get(session.sessionId);
      if (!known) {
        const opening = readSessionOpeningImplementation(session.sessionId);
        if (opening && opening.text) {
          known = opening.text;
          openingBySession.set(session.sessionId, known);
        }
      }
      if (known) {
        texts[session.sessionId] = known;
      }
    }
    return texts;
  }

  // ---- setting a project up ------------------------------------------------

  async function listsOfFolder(clickup, folderId) {
    const folder = await clickup.getFolder(folderId);
    return folder.lists.map((list) => ({ ...list, folderName: folder.name }));
  }

  async function listsOfSpace(clickup, spaceId) {
    const [folders, folderless] = await Promise.all([clickup.listFolders(spaceId), clickup.listFolderlessLists(spaceId)]);
    return [
      ...folders.flatMap((folder) => folder.lists.map((list) => ({ ...list, folderName: folder.name }))),
      ...folderless
    ];
  }

  // Several lists → the build and planning list, read from the first page
  // of each list's tasks (dependencies are all that is needed).
  async function discoverAmong(clickup, lists) {
    if (lists.length === 0) {
      throw new ProjectLinkError("projects.linkError.noLists");
    }
    if (lists.length > MAXIMUM_LISTS_TO_DISCOVER) {
      return chooseProjectLists(lists.map((list) => ({ ...list, tasks: [] })));
    }
    const withTasks = [];
    for (const list of lists) {
      const tasks = await clickup.listTasks(list.id, { maximumPages: 1 });
      withTasks.push({ ...list, tasks });
    }
    return chooseProjectLists(withTasks);
  }

  // The link in the "Add a project" sheet (and the optional task link) →
  // the project's `clickup` settings, plus the lists to pick from when the
  // structure does not say which is which. ClickUp is only read.
  async function resolveProjectLink({ projectLink = null, taskLink = null } = {}) {
    const parsedProject = projectLink ? parseClickupLink(projectLink) : null;
    const parsedTask = taskLink ? parseClickupLink(taskLink) : null;
    if (projectLink && !parsedProject) {
      throw new ProjectLinkError("projects.linkError.notClickup");
    }
    if (taskLink && (!parsedTask || parsedTask.kind !== "task")) {
      throw new ProjectLinkError("projects.linkError.notTask");
    }
    if (!parsedProject && !parsedTask) {
      return { clickup: {}, ambiguous: false, candidates: [] };
    }
    if (fixture) {
      throw new ProjectLinkError("projects.fixtureReadOnly");
    }
    const clickup = await client();
    const settings = { projectLink: projectLink || null, seedTaskId: parsedTask ? parsedTask.id : null };
    let target = parsedProject || parsedTask;
    try {
      if (target.kind === "view") {
        const view = await clickup.getView(target.id);
        if (!view.parentKind) {
          throw new ProjectLinkError("projects.linkError.viewWithoutList");
        }
        target = { kind: view.parentKind, id: view.parentId };
      }
      if (target.kind === "task") {
        const seed = await clickup.getTask(target.id);
        settings.seedTaskId = target.id;
        settings.buildListId = seed.listId;
        settings.buildListName = seed.listName;
        return { clickup: settings, ambiguous: false, candidates: [] };
      }
      if (target.kind === "list") {
        const list = await clickup.getList(target.id);
        settings.buildListId = list.id;
        settings.buildListName = list.name;
        return { clickup: settings, ambiguous: false, candidates: [] };
      }
      const lists = target.kind === "folder" ? await listsOfFolder(clickup, target.id) : await listsOfSpace(clickup, target.id);
      const chosen = await discoverAmong(clickup, lists);
      const nameOf = (listId) => (chosen.candidates.find((candidate) => candidate.id === listId) || {}).name || null;
      // A task link given as well settles which list is the build list.
      if (parsedTask && parsedProject) {
        const seed = await clickup.getTask(parsedTask.id);
        settings.buildListId = seed.listId;
        settings.buildListName = seed.listName;
      } else if (chosen.buildListId) {
        settings.buildListId = chosen.buildListId;
        settings.buildListName = nameOf(chosen.buildListId);
      }
      if (chosen.planningListId && chosen.planningListId !== settings.buildListId) {
        settings.planningListId = chosen.planningListId;
        settings.planningListName = nameOf(chosen.planningListId);
      }
      return { clickup: settings, ambiguous: !settings.buildListId, candidates: chosen.candidates };
    } catch (error) {
      if (error instanceof ProjectLinkError) {
        throw error;
      }
      if (error.kind === "not-found") {
        throw new ProjectLinkError("projects.linkError.notFound");
      }
      if (error.kind === "no-token" || error.kind === "unauthorized") {
        throw new ProjectLinkError("projects.linkError.noToken");
      }
      throw new ProjectLinkError("projects.linkError.clickupFailed", { message: error.message });
    }
  }

  // What the settings sheet needs from ClickUp: the real status names of
  // both lists (with where each one lands now), the planning list's fields,
  // the people who can see the lists, who the token belongs to, and the
  // tasks that carry a date (a deadline can follow one).
  async function settingsData(boardId) {
    const { board, input } = boardFor(boardId);
    const cached = fixture ? { buildTasks: (input.buildTasks || []).map(mapTask), planningTasks: (input.planningTasks || []).map(mapTask) } : readCache(boardId) || { buildTasks: [], planningTasks: [] };
    const datedTasks = [...cached.buildTasks, ...cached.planningTasks]
      .filter((task) => task.dueDate || task.isMilestone)
      .map((task) => ({ id: task.id, name: task.name, dueDate: task.dueDate, isMilestone: Boolean(task.isMilestone) }));
    const statusesSeen = (tasks) => [...new Map(tasks.map((task) => [task.status.toLowerCase(), { name: task.status, type: task.statusType }])).values()];
    const buildFieldsSeen = [...new Map(cached.buildTasks.flatMap((task) => task.customFields || []).map((field) => [field.name, field])).values()];
    const answer = {
      buildStatuses: statusesSeen(cached.buildTasks),
      // Drop-down fields of the build list with their options (for the
      // developer-status setting); from the tasks until ClickUp answers.
      buildFields: buildFieldsSeen.map((field) => ({
        name: field.name,
        type: field.type,
        options: [...new Set(cached.buildTasks.map((task) => (task.customFields || []).find((candidate) => candidate.name === field.name)).filter(Boolean).map((candidate) => String(candidate.value)))]
      })),
      planningStatuses: statusesSeen(cached.planningTasks),
      planningFields: [...new Set(cached.planningTasks.flatMap((task) => (task.customFields || []).map((field) => field.name)))].map((name) => ({ name })),
      members: [...new Map([...cached.buildTasks, ...cached.planningTasks].flatMap((task) => task.assignees).map((person) => [person.id, person])).values()],
      currentUser: null,
      datedTasks,
      // Where the phases could come from, as found (and the one in use).
      deadlineCandidates: (!fixture && readCache(boardId) && readCache(boardId).deadlineDiscovery) ? readCache(boardId).deadlineDiscovery.candidates : [],
      deadlineChosenId: (!fixture && readCache(boardId) && readCache(boardId).deadlineDiscovery) ? readCache(boardId).deadlineDiscovery.chosenId : null,
      deadlineSearchTruncated: Boolean(!fixture && readCache(boardId) && readCache(boardId).deadlineDiscovery && readCache(boardId).deadlineDiscovery.milestonesTruncated),
      deadlineSourceInUse: !fixture && readCache(boardId) ? readCache(boardId).deadlineSource || null : null,
      error: null
    };
    if (!fixture && usesClickup(board)) {
      try {
        const clickup = await client();
        const lists = [board.clickup.buildListId, board.clickup.planningListId].filter(Boolean);
        const [listAnswers, currentUser] = await Promise.all([
          Promise.all(lists.map((listId) => clickup.getList(listId))),
          clickup.getCurrentUser()
        ]);
        answer.currentUser = currentUser;
        if (listAnswers[0]) {
          answer.buildStatuses = listAnswers[0].statuses.map((status) => ({ name: status.name, type: status.type }));
        }
        if (board.clickup.planningListId && listAnswers[1]) {
          answer.planningStatuses = listAnswers[1].statuses.map((status) => ({ name: status.name, type: status.type }));
        }
        if (board.clickup.buildListId) {
          answer.buildFields = await clickup.listFields(board.clickup.buildListId);
        }
        if (board.clickup.planningListId) {
          answer.planningFields = (await clickup.listFields(board.clickup.planningListId)).map((field) => ({ name: field.name, type: field.type }));
        }
        const memberLists = await Promise.all(lists.map((listId) => clickup.listMembers(listId)));
        const members = new Map(answer.members.map((person) => [person.id, person]));
        for (const person of memberLists.flat()) {
          members.set(person.id, person);
        }
        answer.members = [...members.values()];
      } catch (error) {
        answer.error = error.kind || "http";
      }
    }
    // Where each status lands without the project's own changes, so the
    // sheet can say "(automatic: In staging)".
    answer.buildStatuses = answer.buildStatuses.map((status) => {
      const bucket = bucketForStatus(status.name, status.type, board.statusOverrides || {});
      return {
        ...status,
        automatic: bucketForStatus(status.name, status.type, {}),
        automaticPerspective: automaticPerspective(status.name, status.type, bucket)
      };
    });
    answer.detectedDeveloperField = detectDeveloperStatusField(answer.buildFields || []);
    answer.planningStatuses = answer.planningStatuses.map((status) => ({ ...status, automatic: specStageForStatus(status.name, status.type, {}) }));
    answer.members.sort((first, second) => first.name.localeCompare(second.name));
    return answer;
  }

  // The settings sheet's list picker: workspaces → spaces → folders and lists.
  async function browse({ kind, id } = {}) {
    if (fixture) {
      return { items: [] };
    }
    const clickup = await client();
    if (!kind) {
      return { items: (await clickup.listWorkspaces()).map((team) => ({ kind: "workspace", id: team.id, name: team.name })) };
    }
    if (kind === "workspace") {
      return { items: (await clickup.listSpaces(id)).map((space) => ({ kind: "space", id: space.id, name: space.name })) };
    }
    if (kind === "space") {
      const [folders, folderless] = await Promise.all([clickup.listFolders(id), clickup.listFolderlessLists(id)]);
      return {
        items: [
          ...folders.map((folder) => ({ kind: "folder", id: folder.id, name: folder.name, lists: folder.lists })),
          ...folderless.map((list) => ({ kind: "list", id: list.id, name: list.name }))
        ]
      };
    }
    if (kind === "folder") {
      const folder = await clickup.getFolder(id);
      return { items: folder.lists.map((list) => ({ kind: "list", id: list.id, name: list.name })) };
    }
    return { items: [] };
  }

  // Every task and subtask of a project, for "Search projects and tasks".
  // A subtask carries its parent's name and the card it is listed on (its
  // top-level task), which is the card a click opens.
  function taskIndexOf(cached) {
    if (!cached) {
      return [];
    }
    const everything = [...(cached.buildTasks || []), ...(cached.planningTasks || [])];
    const byId = new Map(everything.map((task) => [task.id, task]));
    const cardOf = (task) => {
      let current = task;
      const seen = new Set();
      while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.parentId);
      }
      return current.id;
    };
    return everything.map((task) => {
      const parent = task.parentId ? byId.get(task.parentId) : null;
      return {
        id: task.id,
        name: task.name,
        customId: task.customId || null,
        source: task.source || "clickup",
        parentTitle: parent ? parent.name : null,
        cardId: cardOf(task)
      };
    });
  }

  // For the list on the left: from the cache only, never the network, so
  // the list draws at once. Projects never loaded yet have no summary.
  function summaries() {
    if (fixture) {
      return fixtureInputs().map(({ board, input }) => {
        const hasTasks = (input.buildTasks || []).length > 0 || (input.planningTasks || []).length > 0;
        const summary = hasTasks
          ? buildProjectSnapshot({
              board,
              buildTasks: (input.buildTasks || []).map(mapTask),
              planningTasks: (input.planningTasks || []).map(mapTask),
              now: input.now || now()
            }).summary
          : null;
        const tasks = taskIndexOf({ buildTasks: (input.buildTasks || []).map(mapTask), planningTasks: (input.planningTasks || []).map(mapTask) });
        return { id: board.id, name: board.name, color: board.color, group: board.group, summary, tasks };
      });
    }
    return boardStore.getState().boards.map((board) => {
      const cached = readCache(board.id);
      const summary = cached
        ? buildProjectSnapshot({
            board,
            mode: cached.gitOnly ? "git" : "clickup",
            buildTasks: cached.buildTasks,
            planningTasks: cached.planningTasks,
            statusHistory: cached.statusHistory || {},
            statusMoves: cached.statusMoves || [],
            deadlineItems: cached.deadlineItems || [],
            now: now()
          }).summary
        : null;
      return { id: board.id, name: board.name, color: board.color, group: board.group, summary, tasks: taskIndexOf(cached) };
    });
  }

  // The right panel's own ClickUp view (2.1): the task, its comments, and
  // nothing written anywhere.
  async function taskDetail(taskId) {
    if (fixture) {
      const everything = Object.values(fixture.boards || { only: fixture }).flatMap((input) => [
        ...(input.buildTasks || []),
        ...(input.planningTasks || [])
      ]);
      const raw = everything.find((task) => String(task.id) === String(taskId));
      return raw ? { task: mapTask(raw), comments: (raw.comments || []).map(mapComment) } : null;
    }
    const clickup = await client();
    try {
      const [task, comments] = await Promise.all([clickup.getTask(taskId), clickup.getTaskComments(taskId)]);
      return { task, comments };
    } catch (error) {
      // Said in the user's language by the window (projects.clickupError.*).
      forgetClientOn(error);
      return { task: null, comments: [], errorKind: error.kind || "http", status: error.status || null };
    }
  }

  // ---- for the setup agent (`clauding project inspect|add`, `clauding
  // integrations clickup status`) -----------------------------------------

  // Is there a token, and whose is it? The token itself never leaves here.
  async function clickupStatus() {
    if (fixture) {
      return { connected: false, reason: "fixture" };
    }
    let token = "";
    try {
      token = await readToken();
    } catch (error) {
      token = "";
    }
    if (!token) {
      return { connected: false, reason: "no-token" };
    }
    try {
      const clickup = await client();
      const [user, workspaces] = await Promise.all([clickup.getCurrentUser(), clickup.listWorkspaces()]);
      return { connected: true, user, workspaces, source: process.env.CLAUDING_CLICKUP_TOKEN ? "CLAUDING_CLICKUP_TOKEN" : "keychain" };
    } catch (error) {
      forgetClientOn(error);
      return { connected: false, reason: error.kind || "http", message: error.message };
    }
  }

  // Everything a project could be built from, for one ClickUp link: the
  // lists behind it with their REAL status names (and where each would land
  // automatically), their custom fields with the drop-down values, which
  // list looks like the build list and which the specs list, the people,
  // who the token belongs to, and where the phases and milestones could
  // come from. Read-only, like everything here.
  async function inspectProjectLink(link) {
    const parsed = parseClickupLink(link);
    if (!parsed) {
      throw new ProjectLinkError("projects.linkError.notClickup");
    }
    const resolved = await resolveProjectLink(parsed.kind === "task" ? { taskLink: link } : { projectLink: link });
    const clickup = await client();
    let target = parsed;
    if (target.kind === "view") {
      const view = await clickup.getView(target.id);
      target = { kind: view.parentKind, id: view.parentId, viewName: view.name };
    }
    let lists = [];
    if (target.kind === "task") {
      lists = [{ id: resolved.clickup.buildListId, name: resolved.clickup.buildListName }];
    } else if (target.kind === "list") {
      lists = [{ id: target.id, name: resolved.clickup.buildListName }];
    } else if (target.kind === "folder") {
      lists = await listsOfFolder(clickup, target.id);
    } else if (target.kind === "space") {
      lists = await listsOfSpace(clickup, target.id);
    }
    const described = [];
    let buildTasks = [];
    for (const list of lists.slice(0, MAXIMUM_LISTS_TO_DISCOVER)) {
      const [details, fields, tasks] = await Promise.all([
        clickup.getList(list.id),
        clickup.listFields(list.id).catch(() => []),
        clickup.listTasks(list.id, { maximumPages: 1 })
      ]);
      if (list.id === resolved.clickup.buildListId) {
        buildTasks = tasks;
      }
      const ownIds = new Set(tasks.map((task) => task.id));
      described.push({
        id: list.id,
        name: details.name || list.name,
        folderName: details.folderName || list.folderName || null,
        spaceId: details.spaceId,
        role: list.id === resolved.clickup.buildListId ? "build" : list.id === resolved.clickup.planningListId ? "specs" : null,
        tasksOnFirstPage: tasks.length,
        moreTasks: Boolean(tasks.truncated),
        tasksWithDueDate: tasks.filter((task) => task.dueDate).length,
        tasksDependingOnOtherLists: tasks.filter((task) => task.dependsOn.some((dependencyId) => !ownIds.has(dependencyId))).length,
        statuses: details.statuses.map((status) => {
          const bucket = bucketForStatus(status.name, status.type, {});
          return { name: status.name, type: status.type, automaticBucket: bucket, automaticPlace: automaticPerspective(status.name, status.type, bucket) };
        }),
        customFields: fields.map((field) => ({ name: field.name, type: field.type, options: field.options })),
        assignees: [...new Map(tasks.flatMap((task) => task.assignees).map((person) => [person.id, { id: person.id, name: person.name }])).values()]
      });
    }
    const buildList = described.find((list) => list.role === "build") || null;
    const planningList = described.find((list) => list.role === "specs") || null;
    const [currentUser, members] = await Promise.all([
      clickup.getCurrentUser().catch(() => null),
      buildList ? clickup.listMembers(buildList.id).catch(() => []) : Promise.resolve([])
    ]);
    let deadlineCandidates = [];
    if (buildList) {
      try {
        const found = await discoverDeadlineSources(clickup, { name: target.viewName || buildList.name }, resolved.clickup, buildTasks);
        deadlineCandidates = found.candidates.map((candidate) => ({ kind: candidate.kind, id: candidate.id, name: candidate.name, where: candidate.where || null, dated: candidate.dated, matchesName: Boolean(candidate.matchesName) }));
      } catch (error) {
        log(`[projects] inspect: deadline sources could not be read: ${error.message}`);
      }
    }
    return {
      link,
      linkKind: parsed.kind,
      resolvedKind: target.kind,
      suggestion: {
        buildListId: resolved.clickup.buildListId || null,
        buildListName: resolved.clickup.buildListName || null,
        planningListId: resolved.clickup.planningListId || null,
        planningListName: resolved.clickup.planningListName || null,
        ambiguous: Boolean(resolved.ambiguous)
      },
      lists: described,
      listsNotRead: Math.max(0, lists.length - MAXIMUM_LISTS_TO_DISCOVER),
      developerStatusField: buildList ? detectDeveloperStatusField(buildList.customFields) : null,
      specLinkFieldCandidates: planningList ? planningList.customFields.filter((field) => /spec|url|link|doc/i.test(field.name)).map((field) => field.name) : [],
      currentUser: currentUser ? { id: currentUser.id, name: currentUser.name, email: currentUser.email || null } : null,
      members: members.map((person) => ({ id: person.id, name: person.name, email: person.email || null })),
      deadlineCandidates
    };
  }

  // A project described by the setup agent (`clauding project add`), or
  // typed into the manual sheet: a ClickUp link is resolved to its lists
  // the same way the sheet does it; without one the project follows its
  // repositories only. Returns { board } | { candidates } | throws.
  async function addProjectFromDraft(draft) {
    if (fixture) {
      throw new ProjectLinkError("projects.fixtureReadOnly");
    }
    const { projectLink, taskLink, seedLink, ...rest } = draft || {};
    let clickup = { ...(rest.clickup || {}) };
    const link = projectLink || clickup.projectLink || null;
    if (!clickup.buildListId && (link || taskLink || seedLink)) {
      const resolved = await resolveProjectLink({ projectLink: link, taskLink: taskLink || seedLink || null });
      if (resolved.ambiguous) {
        return { candidates: resolved.candidates, clickup: resolved.clickup };
      }
      clickup = { ...resolved.clickup, ...clickup };
    }
    // Ids the agent took from `project inspect` come without their names;
    // the names are what the header chips show.
    if (link && !clickup.projectLink) {
      clickup.projectLink = link;
    }
    for (const [idKey, nameKey] of [["buildListId", "buildListName"], ["planningListId", "planningListName"]]) {
      if (clickup[idKey] && !clickup[nameKey]) {
        try {
          clickup[nameKey] = (await (await client()).getList(clickup[idKey])).name || null;
        } catch (error) {
          log(`[projects] could not read the name of list ${clickup[idKey]}: ${error.message}`);
        }
      }
    }
    return { board: boardStore.addBoard({ ...rest, clickup }) };
  }

  // The task a session is linked to in any project, from the views last
  // stored on disk (never the network): what the Clauding mod's status line
  // shows. → { id, customId, name, boardId } or null.
  function linkedTaskForSession(sessionId) {
    if (!sessionId || fixture) {
      return null;
    }
    for (const board of boardStore.getState().boards) {
      const stored = readStoredSnapshot(board.id);
      const task = stored ? linkedTaskOfSession(stored.snapshot, sessionId) : null;
      if (task) {
        return { ...task, boardId: board.id };
      }
    }
    return null;
  }

  return {
    snapshot,
    linkedTaskForSession,
    refreshInBackground,
    refreshAll,
    summaries,
    taskDetail,
    resolveProjectLink,
    inspectProjectLink,
    addProjectFromDraft,
    clickupStatus,
    settingsData,
    browse,
    // True while CLAUDING_PROJECTS_FIXTURE is in charge: the window then
    // draws the fixture's projects and never writes project-boards.json.
    usesFixture: Boolean(fixture),
    // After the user fixes the Keychain item: read the token again.
    forgetToken() {
      clientPromise = null;
    }
  };
}
