// The Projects tab draws from its last snapshot first and refreshes behind
// it: the stored snapshot is shown at once, a refresh replaces it, a failed
// refresh keeps it; a refresh asks ClickUp only for what changed; the
// ClickUp client lets a few requests wait for answers at once. Dry: ClickUp,
// git and GitHub are fakes, the cache is a temporary folder.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClickupClient, mapTask } from "../electron/lib/clickupClient.js";
import { createProjectDataService, mergeChangedTasks, tasksNeedingHistory } from "../electron/projectData.js";
import { createProjectBoardStore } from "../electron/projectBoards.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();
const BUILD_LIST = { id: "901300000001", name: "Web build list" };

function rawTask(id, name, status = "in progress", overrides = {}) {
  return {
    id,
    name,
    url: `https://app.clickup.com/t/${id}`,
    status: { status, type: status === "closed" ? "closed" : "custom" },
    assignees: [],
    date_created: String(NOW - 20 * DAY),
    date_updated: String(NOW - DAY),
    list: BUILD_LIST,
    dependencies: [],
    custom_fields: [],
    ...overrides
  };
}

// A fake ClickUp with one build list; `tasks` can be changed between
// refreshes, `online` switched off. Every URL asked for is kept.
function fakeClickup() {
  const fake = {
    online: true,
    tasks: [rawTask("tsk00001", "Search page"), rawTask("tsk00002", "Checkout")],
    calls: [],
    async fetch(url) {
      fake.calls.push(url);
      if (!fake.online) {
        throw new Error("offline");
      }
      const address = new URL(url);
      if (address.pathname.endsWith(`/list/${BUILD_LIST.id}/task`)) {
        const since = Number(address.searchParams.get("date_updated_gt"));
        const tasks = since ? fake.tasks.filter((task) => Number(task.date_updated) > since) : fake.tasks;
        return { ok: true, status: 200, json: async () => ({ tasks, last_page: true }) };
      }
      if (address.pathname.endsWith("/task/bulk_time_in_status/task_ids")) {
        const ids = address.searchParams.getAll("task_ids");
        const body = Object.fromEntries(ids.map((taskId) => [taskId, { status_history: [{ status: "open", type: "open", total_time: { since: String(NOW - 5 * DAY) } }] }]));
        return { ok: true, status: 200, json: async () => body };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
  };
  return fake;
}

function serviceWith(fake, { clock, refreshes = [] } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-projectcache-"));
  const boardStore = createProjectBoardStore({ storagePath: path.join(folder, "project-boards.json") });
  const board = boardStore.addBoard({ name: "Website", clickup: { buildListId: BUILD_LIST.id, buildListName: BUILD_LIST.name }, clickupUserId: "42" });
  const service = createProjectDataService({
    boardStore,
    cacheDirectory: path.join(folder, "project-cache"),
    getSessions: async () => [],
    getAgents: () => ({ agents: [], sessionAgents: {} }),
    readToken: async () => "pk_test",
    fetchImplementation: fake.fetch,
    inspectRepositoryImplementation: async () => ({ available: true, branchesByTask: {} }),
    listPullRequestsImplementation: async () => ({ available: true, byTask: {} }),
    fixturePath: null,
    now: () => clock.time,
    onRefresh: (state) => refreshes.push(state)
  });
  return { service, board, boardStore, folder };
}

test("the stored snapshot is there at once, a background refresh replaces it, a failed one keeps it", async () => {
  const fake = fakeClickup();
  const clock = { time: NOW };
  const refreshes = [];
  const { service, board, boardStore } = serviceWith(fake, { clock, refreshes });

  assert.equal(await service.snapshot(board.id, { cachedOnly: true }), null, "never read: nothing to show yet");
  assert.equal(await service.snapshot(board.id, { local: true }), null);

  const first = await service.refreshInBackground(board.id);
  assert.equal(first.cards.length, 2);
  assert.deepEqual(refreshes.map((state) => state.refreshing), [true, false], "the window hears when it starts and ends");
  assert.equal(refreshes[1].snapshot.cards.length, 2, "the end carries the new snapshot");

  // The stale snapshot is shown without a single request.
  const before = fake.calls.length;
  const stored = await service.snapshot(board.id, { cachedOnly: true });
  assert.equal(stored.cards.length, 2);
  assert.equal(stored.sources.clickup.refreshedAt, NOW);
  // A setting changed: drawn again from disk, still no request.
  boardStore.updateBoard(board.id, { upNext: ["tsk00002"] });
  const local = await service.snapshot(board.id, { local: true });
  assert.deepEqual(local.filters.upNext, ["tsk00002"]);
  assert.equal(fake.calls.length, before, "no network for the stored or the rebuilt snapshot");

  // ClickUp has a new task: the refresh replaces the stored snapshot.
  clock.time = NOW + 10 * 60 * 1000;
  fake.tasks.push(rawTask("tsk00003", "Receipts", "in progress", { date_updated: String(clock.time - 1000) }));
  const second = await service.refreshInBackground(board.id);
  assert.equal(second.cards.length, 3);
  assert.equal((await service.snapshot(board.id, { cachedOnly: true })).cards.length, 3);

  // Offline: the refresh says so, the stored snapshot stays as it was.
  fake.online = false;
  clock.time += 10 * 60 * 1000;
  const failed = await service.refreshInBackground(board.id);
  assert.equal(failed.sources.clickup.ok, false);
  assert.equal(failed.cards.length, 3, "the last tasks are still drawn");
  const kept = await service.snapshot(board.id, { cachedOnly: true });
  assert.equal(kept.sources.clickup.ok, true, "the good snapshot is not overwritten by the failed one");
  assert.equal(kept.cards.length, 3);
});

test("two refreshes at once are one", async () => {
  const fake = fakeClickup();
  const { service, board } = serviceWith(fake, { clock: { time: NOW } });
  const [first, second] = await Promise.all([service.refreshInBackground(board.id), service.refreshInBackground(board.id)]);
  assert.equal(first, second);
  assert.equal(fake.calls.filter((url) => url.includes("/list/")).length, 1);
});

test("a refresh asks only for the changed tasks, and time in status only for moved ones; the whole list once an hour", async () => {
  const fake = fakeClickup();
  const clock = { time: NOW };
  const { service, board } = serviceWith(fake, { clock });
  await service.refreshInBackground(board.id);
  const historyCalls = () => fake.calls.filter((url) => url.includes("bulk_time_in_status"));
  assert.equal(historyCalls().length, 1);

  // Five minutes later one task moved.
  clock.time = NOW + 5 * 60 * 1000;
  fake.tasks[1] = rawTask("tsk00002", "Checkout", "in staging", { date_updated: String(clock.time - 1000) });
  fake.calls.length = 0;
  const merged = await service.refreshInBackground(board.id);
  const listCall = new URL(fake.calls.find((url) => url.includes("/list/")));
  assert.equal(Number(listCall.searchParams.get("date_updated_gt")), NOW - 2 * 60 * 1000, "since the last read, with a little overlap");
  assert.equal(listCall.searchParams.get("include_closed"), "true", "a task closed meanwhile must be seen");
  assert.equal(merged.cards.length, 2, "the unchanged task is kept from the copy");
  assert.deepEqual(historyCalls().map((url) => new URL(url).searchParams.getAll("task_ids")), [["tsk00002"]]);

  // Nothing moved: no time-in-status request at all.
  clock.time += 5 * 60 * 1000;
  fake.calls.length = 0;
  await service.refreshInBackground(board.id);
  assert.equal(historyCalls().length, 0);

  // An hour after the last whole read the whole list is read again.
  clock.time = NOW + 61 * 60 * 1000;
  fake.calls.length = 0;
  await service.refreshInBackground(board.id);
  assert.equal(new URL(fake.calls.find((url) => url.includes("/list/"))).searchParams.get("date_updated_gt"), null);
});

test("changed tasks merge into the copy; a task closed meanwhile drops out when closed ones are left out", () => {
  const previous = [rawTask("tsk00001", "Search page"), rawTask("tsk00002", "Checkout")].map(mapTask);
  const changed = [rawTask("tsk00002", "Checkout", "closed"), rawTask("tsk00003", "Receipts")].map(mapTask);
  assert.deepEqual(mergeChangedTasks(previous, changed).map((task) => [task.id, task.status]), [["tsk00001", "in progress"], ["tsk00002", "closed"], ["tsk00003", "in progress"]]);
  assert.deepEqual(mergeChangedTasks(previous, changed, { includeClosed: false }).map((task) => task.id), ["tsk00001", "tsk00003"]);
  const history = { tsk00001: [], tsk00002: [] };
  const now = [rawTask("tsk00001", "Search page"), rawTask("tsk00002", "Checkout", "in staging"), rawTask("tsk00003", "Receipts")].map(mapTask);
  assert.deepEqual(tasksNeedingHistory(now, previous, history).map((task) => task.id), ["tsk00002", "tsk00003"]);
});

test("the client lets up to four requests wait for answers at once, and pages it expects are asked together", async () => {
  let inFlight = 0;
  let most = 0;
  const answers = [];
  const client = createClickupClient({
    token: "pk_test",
    minimumGapMilliseconds: 0,
    fetchImplementation: async (url) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => answers.push(resolve));
      inFlight -= 1;
      const page = Number(new URL(url).searchParams.get("page"));
      return { ok: true, status: 200, json: async () => ({ tasks: [{ id: `tsk${page}`, status: {} }], last_page: page === 2 }) };
    }
  });
  const reading = Promise.all(Array.from({ length: 6 }, (unused, index) => client.getTask(`tsk0000${index}`).catch(() => null)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inFlight, 4, "four at once, the rest wait their turn");
  while (answers.length > 0 || inFlight > 0) {
    const answer = answers.shift();
    if (answer) {
      answer();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await reading;
  assert.equal(most, 4);

  const listing = client.listTasks(BUILD_LIST.id, { expectedPages: 3 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inFlight, 3, "the three pages of the last full read are asked together");
  answers.splice(0).forEach((answer) => answer());
  const tasks = await listing;
  assert.equal(tasks.length, 3);
  assert.equal(tasks.truncated, false);
});
