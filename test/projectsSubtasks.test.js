// CL-27 — every task and every subtask is a unit of work. A dry fixture with
// subtasks two levels deep and closed subtasks: the numbers count them all,
// the cards stay one per top-level task and list their subtasks, and the two
// project switches (count subtasks, include closed) turn each part off. No
// network, no ClickUp.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAXIMUM_TASK_PAGES, createClickupClient, mapTask } from "../electron/lib/clickupClient.js";
import { buildProjectSnapshot } from "../electron/lib/projectSnapshot.js";
import { cardsForFilter, cardsForStat, isNotStarted, needsLabel, searchCards, subtaskSummaryParts } from "../src/renderer/projectsView.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();
const USER_ID = "42";
const english = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "locales", "en.json"), "utf8")
);

function inEnglish({ key, values }) {
  return english[key].replace(/\{(\w+)\}/g, (whole, name) => String(values[name]));
}

const STATUS_TYPES = { Open: "open", Closed: "closed" };

function task(id, name, status, { parent = null, assignee = null } = {}) {
  return mapTask({
    id,
    name,
    url: `https://app.clickup.com/t/${id}`,
    status: { status, type: STATUS_TYPES[status] || "custom" },
    assignees: assignee ? [{ id: Number(assignee), username: assignee === USER_ID ? "Sam Rivera" : "Alex Doe" }] : [],
    date_created: String(NOW - 30 * DAY),
    date_updated: String(NOW - 2 * DAY),
    date_closed: status === "Closed" ? String(NOW - 3 * DAY) : null,
    parent,
    list: { id: "900000000001", name: "Web build list" },
    dependencies: [],
    custom_fields: []
  });
}

// Profile page      Open               (top level)
//   Avatar upload   Closed
//   Edit form       in progress  me
//     Validation    in staging         (second level)
//     Error states  Closed             (second level)
//   Copy review     feedback     me
// Search page       in staging         (top level, no subtasks)
// Settings page     Open               (top level, every subtask closed)
//   Theme switch    Closed
//   Language menu   in prod
function fixture(boardChanges = {}) {
  return {
    board: { id: "website", name: "Website", clickupUserId: USER_ID, clickup: {}, ...boardChanges },
    buildTasks: [
      task("tsk0001", "Profile page", "Open", { assignee: USER_ID }),
      task("tsk0001a", "Avatar upload", "Closed", { parent: "tsk0001", assignee: "7" }),
      task("tsk0001b", "Edit form", "in progress", { parent: "tsk0001", assignee: USER_ID }),
      task("tsk0001c", "Validation", "in staging", { parent: "tsk0001b", assignee: "7" }),
      task("tsk0001d", "Error states", "Closed", { parent: "tsk0001b" }),
      task("tsk0001e", "Copy review", "feedback", { parent: "tsk0001", assignee: USER_ID }),
      task("tsk0002", "Search page", "in staging", { assignee: "7" }),
      task("tsk0003", "Settings page", "Open"),
      task("tsk0003a", "Theme switch", "Closed", { parent: "tsk0003" }),
      task("tsk0003b", "Language menu", "in prod", { parent: "tsk0003" })
    ],
    planningTasks: [],
    now: NOW
  };
}

test("every task and subtask counts: buckets, my queue, waiting, closed, people", () => {
  const snapshot = buildProjectSnapshot(fixture());
  assert.deepEqual(snapshot.counting, { subtasks: true, closed: true });
  assert.equal(snapshot.stats.total, 10);
  assert.equal(snapshot.stats.topLevel, 3);
  assert.equal(snapshot.stats.subtasks, 7);
  assert.equal(snapshot.stats.buckets.open, 2);
  assert.equal(snapshot.stats.buckets.inProgress, 1);
  assert.equal(snapshot.stats.buckets.feedback, 1);
  assert.equal(snapshot.stats.buckets.inStaging, 2);
  assert.equal(snapshot.stats.buckets.done, 4, "three closed and one in prod");
  assert.equal(snapshot.stats.inQueue, 3, "Profile page, Edit form, Settings page");
  assert.equal(snapshot.stats.waiting, 3, "Validation, Copy review, Search page");
  assert.equal(snapshot.stats.closed, 4);
  assert.equal(snapshot.stats.pace.total, 10);
  assert.equal(snapshot.summary.inQueue, 3);
  // Who has what counts open subtasks too: me = Profile page, Edit form, Copy review.
  const me = snapshot.stats.people.find((person) => person.isUser);
  assert.equal(me.total, 3);
  const other = snapshot.stats.people.find((person) => person.id === "7");
  assert.equal(other.total, 2, "Validation and Search page; the closed Avatar upload is not counted");
});

test("cards stay one per top-level task and list every subtask, two levels deep", () => {
  const snapshot = buildProjectSnapshot(fixture());
  assert.deepEqual(snapshot.cards.map((card) => card.id), ["tsk0001", "tsk0002", "tsk0003"]);
  const profile = snapshot.cards.find((card) => card.id === "tsk0001");
  assert.deepEqual(
    profile.subtasks.map((subtask) => [subtask.name, subtask.depth, subtask.parentTitle]),
    [
      ["Avatar upload", 1, "Profile page"],
      ["Edit form", 1, "Profile page"],
      ["Validation", 2, "Edit form"],
      ["Error states", 2, "Edit form"],
      ["Copy review", 1, "Profile page"]
    ]
  );
  assert.equal(profile.subtaskCount, 5);
  assert.deepEqual(profile.subtaskSummary, { total: 5, myQueue: 1, waiting: 2, closed: 2 });
  assert.equal(subtaskSummaryParts(profile).map(inEnglish).join(" · "), "5 subtasks · 1 in my queue · 2 waiting · 2 closed");
  const settings = snapshot.cards.find((card) => card.id === "tsk0003");
  assert.equal(subtaskSummaryParts(settings).map(inEnglish).join(" · "), "2 subtasks · 2 closed");
  assert.deepEqual(subtaskSummaryParts(snapshot.cards.find((card) => card.id === "tsk0002")), []);
});

test("a subtask waiting on the user puts its card first, and names the subtask", () => {
  const snapshot = buildProjectSnapshot(fixture());
  const profile = snapshot.cards.find((card) => card.id === "tsk0001");
  assert.equal(profile.needs.kind, "feedback");
  assert.equal(profile.needs.subtaskName, "Copy review");
  assert.equal(needsLabel(profile.needs).subtaskName, "Copy review");
  assert.equal(snapshot.filters.focus[0], "tsk0001", "needs me first");
});

test("an open task whose subtasks are all closed does not look untouched", () => {
  const snapshot = buildProjectSnapshot(fixture());
  const settings = snapshot.cards.find((card) => card.id === "tsk0003");
  assert.equal(settings.bucket, "open");
  assert.equal(isNotStarted(settings), false);
  assert.equal(snapshot.filters.hiddenNotStarted, 0);
  assert.ok(cardsForFilter(snapshot, "build").cards.some((card) => card.id === "tsk0003"), "shown, not folded away");
});

test("the numbers on top and the search find cards through their subtasks", () => {
  const snapshot = buildProjectSnapshot(fixture());
  const ids = (cards) => cards.map((card) => card.id).sort();
  assert.deepEqual(ids(cardsForStat(snapshot, { kind: "perspective", perspective: "waiting" })), ["tsk0001", "tsk0002"]);
  assert.deepEqual(ids(cardsForStat(snapshot, { kind: "perspective", perspective: "closed" })), ["tsk0001", "tsk0003"]);
  assert.deepEqual(ids(cardsForStat(snapshot, { kind: "bucket", bucket: "inProgress" })), ["tsk0001"]);
  assert.deepEqual(ids(cardsForStat(snapshot, { kind: "person", personId: "7" })), ["tsk0001", "tsk0002"]);
  assert.deepEqual(ids(searchCards(snapshot.cards, "language menu")), ["tsk0003"]);
  assert.deepEqual(ids(searchCards(snapshot.cards, "CU-tsk0001c")), ["tsk0001"]);
});

test("switched off: subtasks do not count, closed tasks are left out, or both", () => {
  const topOnly = buildProjectSnapshot(fixture({ countSubtasks: false }));
  assert.equal(topOnly.stats.total, 3);
  assert.equal(topOnly.stats.subtasks, 0);
  assert.equal(topOnly.stats.inQueue, 2);
  assert.equal(topOnly.stats.waiting, 1);
  assert.equal(topOnly.stats.closed, 0);
  const profile = topOnly.cards.find((card) => card.id === "tsk0001");
  assert.equal(profile.subtasks.length, 5, "the card still lists them");
  assert.equal(profile.needs, null, "a subtask's feedback does not reach the card");
  assert.deepEqual(cardsForStat(topOnly, { kind: "perspective", perspective: "closed" }), []);

  const openOnly = buildProjectSnapshot(fixture({ includeClosed: false }));
  assert.equal(openOnly.stats.total, 7, "Avatar upload, Error states and Theme switch are left out");
  assert.equal(openOnly.stats.closed, 1, "in prod is closed for the user but not a closed status in ClickUp");
  assert.deepEqual(openOnly.cards.find((card) => card.id === "tsk0001").subtaskSummary, { total: 3, myQueue: 1, waiting: 2, closed: 0 });

  const neither = buildProjectSnapshot(fixture({ countSubtasks: false, includeClosed: false }));
  assert.deepEqual(neither.counting, { subtasks: false, closed: false });
  assert.equal(neither.stats.total, 3);
  assert.equal(neither.stats.closed, 0);
});

test("a subtask whose parent was not read becomes a card of its own", () => {
  const input = fixture({ includeClosed: false });
  input.buildTasks = [...input.buildTasks, task("tsk0004", "Old epic", "Closed"), task("tsk0004a", "Leftover", "Open", { parent: "tsk0004" })];
  const snapshot = buildProjectSnapshot(input);
  assert.ok(snapshot.cards.some((card) => card.id === "tsk0004a"));
  assert.ok(!snapshot.cards.some((card) => card.id === "tsk0004"));
});

test("the list call asks for subtasks and closed tasks, pages to the end, and says when it stopped early", async () => {
  const calls = [];
  const pages = (url) => Number(new URL(url).searchParams.get("page"));
  const client = createClickupClient({
    token: "pk_test",
    minimumGapMilliseconds: 0,
    fetchImplementation: async (url) => {
      calls.push(url);
      const page = pages(url);
      const body = { tasks: [{ id: `tsk${page}`, name: `Task ${page}`, status: { status: "Open", type: "open" } }], last_page: page === 2 };
      return { ok: true, status: 200, json: async () => body };
    }
  });
  const everything = await client.listTasks("900000000001");
  assert.equal(everything.length, 3);
  assert.equal(everything.truncated, false);
  const query = new URL(calls[0]).searchParams;
  assert.equal(query.get("subtasks"), "true");
  assert.equal(query.get("include_closed"), "true");
  assert.equal(query.get("include_markdown_description"), "false");
  assert.equal(MAXIMUM_TASK_PAGES, 200);

  calls.length = 0;
  const openOnly = await client.listTasks("900000000001", { includeClosed: false, maximumPages: 2 });
  assert.equal(new URL(calls[0]).searchParams.get("include_closed"), "false");
  assert.equal(openOnly.length, 2);
  assert.equal(openOnly.truncated, true, "more pages were left");
});

test("the project search on the left lists subtasks and opens their card; the switches are kept per project", async () => {
  const os = await import("node:os");
  const { createProjectDataService } = await import("../electron/projectData.js");
  const { createProjectBoardStore, cleanBoard } = await import("../electron/projectBoards.js");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-subtasks-"));
  const service = createProjectDataService({
    boardStore: createProjectBoardStore({ storagePath: path.join(folder, "project-boards.json") }),
    cacheDirectory: path.join(folder, "project-cache"),
    getSessions: async () => [],
    getAgents: () => ({ agents: [], sessionAgents: {} }),
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "projects", "website.json")
  });
  const website = service.summaries().find((summary) => summary.id === "website");
  const subtask = website.tasks.find((entry) => entry.id === "web0001a");
  assert.equal(subtask.cardId, "web0001");
  assert.equal(subtask.parentTitle, "User profile + edit modal");
  assert.equal(website.tasks.find((entry) => entry.id === "web0001").cardId, "web0001");

  const defaults = cleanBoard({ name: "Website" });
  assert.equal(defaults.countSubtasks, true);
  assert.equal(defaults.includeClosed, true);
  const turnedOff = cleanBoard({ name: "Website", countSubtasks: false, includeClosed: false });
  assert.equal(turnedOff.countSubtasks, false);
  assert.equal(turnedOff.includeClosed, false);
});
