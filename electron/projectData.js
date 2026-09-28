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
// Finding the lists: a project can be set up from one task link (the seed).
// The build list is the seed task's list. The planning list (the tasks that
// carry the spec links) is found through ClickUp's dependencies: the list of
// the first task a build task "depends on", when that is another list. Both
// are written back to the project once found, so this happens once.
//
// CLAUDING_PROJECTS_FIXTURE=<file.json> replaces ClickUp, git, gh and the
// project list itself with the file's contents — screenshots and smoke
// tests never touch the user's ClickUp, repositories or project-boards.json.
// The file is either one project ({ board, buildTasks, planningTasks, … })
// or several ({ boards: { "<id>": { board, … } } }); `clickup` in a project
// replaces the ClickUp state (e.g. { "ok": false, "error": "no-token" }).
import fs from "node:fs";
import path from "node:path";
import { ClickupError, createClickupClient, mapComment, mapTask, readClickupToken } from "./lib/clickupClient.js";
import { fetchRepository, inspectRepository } from "./lib/gitInspector.js";
import { listPullRequests } from "./lib/pullRequests.js";
import { buildProjectSnapshot } from "./lib/projectSnapshot.js";
import { cleanBoard } from "./projectBoards.js";

const CACHE_FRESH_MILLISECONDS = 5 * 60 * 1000;

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
  fixturePath = process.env.CLAUDING_PROJECTS_FIXTURE || null,
  now = () => Date.now(),
  log = () => {}
}) {
  let clientPromise = null;
  const refreshesInFlight = new Map();
  const fixture = fixturePath ? readJsonQuietly(fixturePath) : null;

  function client() {
    if (!clientPromise) {
      clientPromise = readToken().then((token) => createClickupClient({ token, fetchImplementation }));
    }
    return clientPromise;
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
      const firstDependency = buildTasks.flatMap((task) => task.dependsOn).find(Boolean);
      if (firstDependency) {
        const planningTask = await clickup.getTask(firstDependency);
        if (planningTask.listId && planningTask.listId !== lists.buildListId) {
          lists.planningListId = planningTask.listId;
          lists.planningListName = planningTask.listName;
          planningChanged = true;
        }
      }
    }
    const planningTasks = lists.planningListId ? await clickup.listTasks(lists.planningListId) : [];
    if (changed || planningChanged) {
      boardStore.updateBoard(board.id, { clickup: lists });
    }
    return { buildTasks, planningTasks, refreshedAt: now(), lists };
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
    const [{ data, clickup }, repositoryResults, pullRequestResults] = await Promise.all([
      clickupData(board, { refresh }),
      Promise.all(board.repositories.map((repository) => inspectRepositoryImplementation(repository))),
      Promise.all(board.repositories.map((repository) => listPullRequestsImplementation(repository)))
    ]);
    return buildProjectSnapshot({
      board: boardStore.getBoard(boardId),
      buildTasks: data.buildTasks,
      planningTasks: data.planningTasks,
      sessions,
      sessionAgents: agentState.sessionAgents,
      agents: agentState.agents,
      repositoryResults,
      pullRequestResults,
      clickup,
      now: now()
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
        return { id: board.id, name: board.name, color: board.color, group: board.group, summary };
      });
    }
    return boardStore.getState().boards.map((board) => {
      const cached = readCache(board.id);
      const summary = cached
        ? buildProjectSnapshot({ board, buildTasks: cached.buildTasks, planningTasks: cached.planningTasks, now: now() }).summary
        : null;
      return { id: board.id, name: board.name, color: board.color, group: board.group, summary };
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
    const [task, comments] = await Promise.all([clickup.getTask(taskId), clickup.getTaskComments(taskId)]);
    return { task, comments };
  }

  return {
    snapshot,
    summaries,
    taskDetail,
    // True while CLAUDING_PROJECTS_FIXTURE is in charge: the window then
    // draws the fixture's projects and never writes project-boards.json.
    usesFixture: Boolean(fixture),
    // After the user fixes the Keychain item: read the token again.
    forgetToken() {
      clientPromise = null;
    }
  };
}
