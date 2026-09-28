// Projects view: the service behind the window. For one project it reads
// ClickUp (through a cache on disk), the user's checkouts, GitHub and the
// Claude Code sessions, and hands buildProjectSnapshot everything it needs.
//
// ClickUp answers are cached in <userData>/project-cache/<board id>.json:
// the view opens instantly with the last answer (also offline), refreshes
// in the background when the cache is older than five minutes, and on the
// user's ↻. A failed refresh keeps the cache and says so
// (sources.clickup.ok = false, with the time of the data shown).
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
import { buildProjectSnapshot } from "./lib/projectSnapshot.js";
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
  log = () => {}
}) {
  let clientPromise = null;
  const refreshesInFlight = new Map();
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

  function writeCache(boardId, data) {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const temporaryPath = `${cachePath(boardId)}.writing`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data));
    fs.renameSync(temporaryPath, cachePath(boardId));
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

  async function fetchClickup(board) {
    const clickup = await client();
    const { lists, changed } = await resolveLists(board, clickup);
    if (!lists.buildListId) {
      throw new ClickupError("This project has no ClickUp list yet.", { kind: "no-list" });
    }
    const buildTasks = await clickup.listTasks(lists.buildListId);
    let planningChanged = false;
    if (!lists.planningListId) {
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
    }
    const planningTasks = lists.planningListId ? await clickup.listTasks(lists.planningListId) : [];
    const update = {};
    if (changed || planningChanged) {
      update.clickup = lists;
    }
    // "Me" is the owner of the token until the settings say otherwise.
    if (!board.clickupUserId) {
      try {
        const owner = await clickup.getCurrentUser();
        if (owner.id) {
          update.clickupUserId = owner.id;
        }
      } catch (error) {
        log(`[projects] could not ask ClickUp who the token belongs to: ${error.message}`);
      }
    }
    if (Object.keys(update).length > 0) {
      boardStore.updateBoard(board.id, update);
    }
    const previous = readCache(board.id);
    // When each build task entered each status: the queue's movement over
    // time. Optional — without it the moves this app saw are used. A failed
    // read keeps the last one instead of wiping it.
    let statusHistory = previous && previous.statusHistory ? previous.statusHistory : {};
    try {
      statusHistory = await clickup.getStatusHistory(buildTasks.filter((task) => !task.parentId).map((task) => task.id));
    } catch (error) {
      log(`[projects] no time-in-status for ${board.name}: ${error.message}`);
    }
    const refreshedAt = now();
    const statusMoves = observedMoves(previous, buildTasks, refreshedAt);
    // Deadlines likewise: a failed read keeps the last phases and where they
    // came from, and stamps the attempt so it is not retried on every view.
    let deadlines = {
      items: previous && Array.isArray(previous.deadlineItems) ? previous.deadlineItems : [],
      undated: previous ? previous.deadlineUndated || 0 : 0,
      source: previous ? previous.deadlineSource || null : null,
      discovery: previous ? previous.deadlineDiscovery || null : null
    };
    try {
      deadlines = await readDeadlines(clickup, board, lists, buildTasks, deadlines.discovery);
    } catch (error) {
      log(`[projects] deadlines for ${board.name} could not be read: ${error.message}`);
      deadlines = { ...deadlines, discovery: { candidates: [], chosenId: null, ...(deadlines.discovery || {}), at: now() } };
    }
    return {
      buildTasks,
      planningTasks,
      // A list longer than the pages read: the counts are "at least".
      truncated: { buildTasks: Boolean(buildTasks.truncated), planningTasks: Boolean(planningTasks.truncated) },
      refreshedAt,
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
      const read = [];
      for (const parentId of wanted) {
        try {
          const answer = await clickup.getTaskWithSubtasks(parentId);
          read.push(answer);
        } catch (error) {
          log(`[projects] roadmap candidate ${parentId} could not be read: ${error.message}`);
        }
      }
      candidates.push(...roadmapCandidates(read, projectNames).filter((candidate) => candidate.matchesName));
    }
    if (spaceId) {
      const spaceLists = await listsOfSpace(clickup, spaceId);
      const withTasks = [];
      for (const list of planLikeLists(spaceLists)) {
        withTasks.push({ ...list, tasks: await clickup.listTasks(list.id, { maximumPages: 2 }) });
      }
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
  function refreshClickup(board) {
    if (refreshesInFlight.has(board.id)) {
      return refreshesInFlight.get(board.id);
    }
    const running = fetchClickup(board)
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

  async function clickupData(board, { refresh }) {
    const cached = readCache(board.id);
    const fresh = cached && now() - cached.refreshedAt < CACHE_FRESH_MILLISECONDS;
    if (cached && fresh && !refresh) {
      return { data: cached, clickup: { ok: true, error: null, refreshedAt: cached.refreshedAt, fromCache: true } };
    }
    const { data, error } = await refreshClickup(board);
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

  async function snapshot(boardId, { refresh = false, fetchGit = false } = {}) {
    const { board, input } = boardFor(boardId);
    const agentState = getAgents();
    const sessions = await getSessions();
    if (fixture) {
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
    if (fetchGit) {
      for (const repository of board.repositories) {
        try {
          await fetchRepositoryImplementation(repository);
        } catch (error) {
          log(`[projects] git fetch in ${repository.name} failed: ${error.message}`);
        }
      }
    }
    // ClickUp first: its task ids tell git which of the (often hundreds of)
    // CU- branches belong to this project.
    const [{ data, clickup }, pullRequestResults] = await Promise.all([
      clickupData(board, { refresh }),
      Promise.all(board.repositories.map((repository) => listPullRequestsImplementation(repository)))
    ]);
    const taskIds = new Set([...data.buildTasks, ...data.planningTasks].map((task) => String(task.id).toLowerCase()));
    const repositoryResults = await Promise.all(
      board.repositories.map((repository) => inspectRepositoryImplementation(repository, { taskIds }))
    );
    return buildProjectSnapshot({
      board: boardStore.getBoard(boardId),
      buildTasks: data.buildTasks,
      planningTasks: data.planningTasks,
      statusHistory: data.statusHistory || {},
      statusMoves: data.statusMoves || [],
      deadlineItems: data.deadlineItems || [],
      deadlineInfo: { source: data.deadlineSource || null, undated: data.deadlineUndated || 0 },
      truncated: data.truncated || null,
      sessions,
      sessionAgents: agentState.sessionAgents,
      agents: agentState.agents,
      repositoryResults,
      pullRequestResults,
      transcriptTextBySession: openingTexts(sessions),
      clickup,
      now: now()
    });
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
    if (!fixture) {
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

  // The top-level tasks of a project, for "Search projects and tasks".
  function taskIndexOf(cached) {
    if (!cached) {
      return [];
    }
    return [...(cached.buildTasks || []), ...(cached.planningTasks || [])]
      .filter((task) => !task.parentId)
      .map((task) => ({ id: task.id, name: task.name, customId: task.customId || null }));
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

  return {
    snapshot,
    summaries,
    taskDetail,
    resolveProjectLink,
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
