// CL-27 — the Projects view, the whole feature: a project set up from any
// ClickUp link (list, saved view, folder, space, task), lists told apart by
// their dependencies, where each task stands from the user's side (her
// queue, waiting on others, closed) and how the queue moves, the developer
// status field, the opening of a conversation for task linking, the search
// boxes, the numbers as filters, the settings the store keeps, and the
// branch names real repositories use. No network, no window.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseClickupLink, readableFieldValue, specUrlFrom, taskIdFromLink } from "../electron/lib/clickupClient.js";
import { chooseProjectLists } from "../electron/lib/listDiscovery.js";
import {
  PERSPECTIVES,
  automaticPerspective,
  detectDeveloperStatusField,
  developerStatusFieldOf,
  fallbackPath,
  perspectiveAt,
  perspectiveForStatus,
  perspectivePath,
  queueMoves,
  taskPerspective
} from "../electron/lib/perspective.js";
import { bucketForStatus, specStageForStatus, SPEC_STAGES } from "../electron/lib/statusBuckets.js";
import { burnDownHistory, dailyPace, pace } from "../electron/lib/projectStats.js";
import { openingTextFromTranscript } from "../electron/lib/transcriptOpening.js";
import { inspectRepository, taskIdFromBranch } from "../electron/lib/gitInspector.js";
import { createProjectBoardStore } from "../electron/projectBoards.js";
import {
  cardsForStat,
  dateInputToTime,
  emptyDeadlineReason,
  moveInList,
  searchCards,
  searchProjects,
  taskKickoffMessage,
  timeToDateInput
} from "../src/renderer/projectsView.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();

// ---- the link in "Add a project" ----------------------------------------------

test("a project link can be a task, a list, a saved view, a folder, a space or a bare id", () => {
  assert.deepEqual(parseClickupLink("https://app.clickup.com/t/abc123aa1"), { kind: "task", id: "abc123aa1", teamId: null });
  assert.deepEqual(parseClickupLink("https://app.clickup.com/t/999999/abc123aa1"), { kind: "task", id: "abc123aa1", teamId: null });
  assert.deepEqual(parseClickupLink("https://app.clickup.com/999999/v/li/901300000001"), { kind: "list", id: "901300000001", teamId: "999999" });
  assert.deepEqual(parseClickupLink("https://app.clickup.com/999999/v/l/6-901300000001-1"), { kind: "list", id: "901300000001", teamId: "999999" }, "a list's own view carries the list id");
  assert.deepEqual(parseClickupLink("https://app.clickup.com/999999/v/l/abcde-12345"), { kind: "view", id: "abcde-12345", teamId: "999999" }, "a saved view is asked about");
  assert.deepEqual(parseClickupLink("https://app.clickup.com/999999/v/b/abcde-12345?pr=1"), { kind: "view", id: "abcde-12345", teamId: "999999" });
  assert.deepEqual(parseClickupLink("https://app.clickup.com/999999/v/f/901300000009"), { kind: "folder", id: "901300000009", teamId: "999999" });
  assert.deepEqual(parseClickupLink("https://app.clickup.com/999999/v/s/901300000010"), { kind: "space", id: "901300000010", teamId: "999999" });
  assert.deepEqual(parseClickupLink("901300000001"), { kind: "list", id: "901300000001", teamId: null }, "digits only: a list");
  assert.deepEqual(parseClickupLink(" abc123aa1 "), { kind: "task", id: "abc123aa1", teamId: null }, "letters and digits: a task");
});

test("garbage, docs and custom ids are not project links", () => {
  for (const text of ["", "   ", "https://example.com/v/li/901", "https://app.clickup.com/999999/v/dc/doc-1/page-1", "CU-1234", "hello world", "12345"]) {
    assert.equal(parseClickupLink(text), null, text);
  }
  assert.equal(taskIdFromLink("https://app.clickup.com/999999/v/li/901300000001"), null, "a list link is not a task link");
  assert.equal(taskIdFromLink("https://app.clickup.com/t/abc123aa1"), "abc123aa1");
});

// ---- telling the lists of a folder or space apart --------------------------------

test("the build list is the one whose tasks depend on another list's tasks", () => {
  const lists = [
    { id: "100", name: "Specs", folderName: "Planning", tasks: [{ id: "p1", dependsOn: [] }, { id: "p2", dependsOn: [] }] },
    { id: "200", name: "Build", folderName: "Web", tasks: [{ id: "b1", dependsOn: ["p1"] }, { id: "b2", dependsOn: ["p2", "b1"] }] },
    { id: "300", name: "Bugs", folderName: "Web", tasks: [{ id: "x1", dependsOn: [] }] }
  ];
  const chosen = chooseProjectLists(lists);
  assert.equal(chosen.buildListId, "200");
  assert.equal(chosen.planningListId, "100");
  assert.equal(chosen.ambiguous, false);
  assert.deepEqual(chosen.candidates.map((candidate) => candidate.taskCount), [2, 2, 1]);
});

test("dependencies leaving the folder still name the build list; nothing at all asks the user", () => {
  const outside = chooseProjectLists([
    { id: "200", name: "Build", tasks: [{ id: "b1", dependsOn: ["elsewhere1"] }, { id: "b2", dependsOn: ["elsewhere2"] }] },
    { id: "300", name: "Bugs", tasks: [{ id: "x1", dependsOn: [] }] }
  ]);
  assert.deepEqual([outside.buildListId, outside.planningListId, outside.ambiguous], ["200", null, false]);
  const nothing = chooseProjectLists([
    { id: "200", name: "One", tasks: [] },
    { id: "300", name: "Two", tasks: [] }
  ]);
  assert.deepEqual([nothing.buildListId, nothing.ambiguous, nothing.candidates.length], [null, true, 2]);
  assert.equal(chooseProjectLists([{ id: "200", name: "Only", tasks: [] }]).buildListId, "200", "one list is the build list");
});

// ---- statuses that real workspaces use ----------------------------------------------

test("planning statuses that combine writing and review are drafts; a new status type counts as open", () => {
  assert.equal(specStageForStatus("functional writing/review", "custom"), SPEC_STAGES.draft);
  assert.equal(specStageForStatus("technical writing/review", "custom"), SPEC_STAGES.draft);
  assert.equal(specStageForStatus("design (figma)/review", "custom"), SPEC_STAGES.draft);
  assert.equal(specStageForStatus("final review", "custom"), SPEC_STAGES.review);
  assert.equal(specStageForStatus("conceptual", "open"), SPEC_STAGES.noSpec);
  assert.equal(specStageForStatus("document", "done"), SPEC_STAGES.approved);
  assert.equal(specStageForStatus("functional writing/review", "custom", { "Functional writing/review": "review" }), SPEC_STAGES.review, "the project decides");
  assert.equal(bucketForStatus("parked", "unstarted"), "open");
});

test("the spec link field is found by a name that starts with the setting", () => {
  const fields = [
    { name: "Mock/Spec links", type: "text", value: "Specs\n [Doc #abc] " },
    { name: "Spec URL (Automation)", type: "short_text", value: "https://app.clickup.com/999999/v/dc/doc-1/page-1" }
  ];
  assert.equal(specUrlFrom(fields), "https://app.clickup.com/999999/v/dc/doc-1/page-1");
  assert.equal(specUrlFrom(fields, "Mock/Spec links"), null, "a text that is not one link is not a link");
  assert.equal(specUrlFrom([{ name: "Spec URL", value: "https://exact.example/doc" }, { name: "Spec URL old", value: "https://other.example" }]), "https://exact.example/doc", "the exact name wins");
});

test("drop-down and label values read as the option names ClickUp shows", () => {
  const options = [{ id: "o1", name: "Backlog", orderindex: 0 }, { id: "o2", name: "Complete", orderindex: 1 }];
  assert.equal(readableFieldValue({ type: "drop_down", value: 1, type_config: { options } }), "Complete");
  assert.equal(readableFieldValue({ type: "drop_down", value: "o1", type_config: { options } }), "Backlog");
  assert.equal(readableFieldValue({ type: "labels", value: ["o1", "o2"], type_config: { options } }), "Backlog, Complete");
  assert.equal(readableFieldValue({ type: "short_text", value: "plain" }), "plain");
});

// ---- the user's side: queue, waiting, closed -------------------------------------

test("every status lands in the user's queue, waiting on others, or closed", () => {
  const place = (status, type = "custom") => automaticPerspective(status, type, bucketForStatus(status, type));
  assert.equal(place("Open", "open"), PERSPECTIVES.myQueue);
  assert.equal(place("pending review", "open"), PERSPECTIVES.myQueue);
  assert.equal(place("in progress"), PERSPECTIVES.myQueue);
  assert.equal(place("issues found"), PERSPECTIVES.myQueue, "it came back to the user");
  assert.equal(place("ready for prod"), PERSPECTIVES.myQueue, "the deploy is the user's again");
  assert.equal(place("feedback"), PERSPECTIVES.waiting);
  assert.equal(place("in staging"), PERSPECTIVES.waiting, "staging is not done — it waits on others");
  assert.equal(place("in qa"), PERSPECTIVES.waiting);
  assert.equal(place("release candidate"), PERSPECTIVES.waiting);
  assert.equal(place("in prod"), PERSPECTIVES.closed);
  assert.equal(place("Closed", "closed"), PERSPECTIVES.closed);
  assert.equal(place("document", "done"), PERSPECTIVES.closed);
  assert.equal(perspectiveForStatus("in staging", "custom", "inStaging", { "In Staging": "myQueue" }), PERSPECTIVES.myQueue, "the project decides");
});

test("the developer-status field is detected, shown, and can place a task", () => {
  const fields = [
    { name: "Product Phase", type: "drop_down" },
    { name: "QA Status", type: "drop_down" },
    { name: "Build Status", type: "drop_down" }
  ];
  assert.equal(detectDeveloperStatusField(fields), "Build Status", "a status that is not QA's");
  assert.equal(detectDeveloperStatusField([...fields, { name: "Dev state", type: "drop_down" }]), "Dev state", "a name that says dev wins");
  assert.equal(detectDeveloperStatusField([{ name: "Notes", type: "text" }]), null);
  assert.equal(developerStatusFieldOf({ developerStatusFieldName: "QA Status" }, fields), "QA Status", "the project's choice wins");

  const task = { status: "in progress", statusType: "custom", bucket: "inProgress", customFields: [{ name: "Build Status", type: "drop_down", value: "Staging Complete" }] };
  const plain = taskPerspective(task, { developerFieldName: "Build Status" });
  assert.deepEqual(plain, { perspective: PERSPECTIVES.myQueue, developerStatus: "Staging Complete", decidedBy: "status" });
  const mapped = taskPerspective(task, { developerFieldName: "Build Status", developerStatusMap: { "staging complete": "waiting" } });
  assert.deepEqual(mapped, { perspective: PERSPECTIVES.waiting, developerStatus: "Staging Complete", decidedBy: "developerStatus" });
});

test("a task's path through the queue comes from ClickUp's time in status; coming back re-enters it", () => {
  const history = [
    { status: "Open", type: "open", since: NOW - 20 * DAY },
    { status: "in progress", type: "custom", since: NOW - 15 * DAY },
    { status: "in staging", type: "custom", since: NOW - 10 * DAY },
    { status: "issues found", type: "custom", since: NOW - 6 * DAY },
    { status: "Closed", type: "closed", since: NOW - 2 * DAY }
  ];
  const path = perspectivePath(history, { bucketOf: (status, type) => bucketForStatus(status, type) });
  assert.deepEqual(path.map((step) => step.perspective), ["myQueue", "waiting", "myQueue", "closed"], "repeats merged");
  assert.equal(perspectiveAt(path, NOW - 8 * DAY), "waiting");
  assert.equal(perspectiveAt(path, NOW - 30 * DAY), null, "not there yet");
  const moves = queueMoves(path);
  assert.deepEqual(moves.left, [NOW - 10 * DAY, NOW - 2 * DAY], "handed off twice");
  assert.deepEqual(moves.returned, [NOW - 6 * DAY]);
});

test("without ClickUp's history the path comes from the moves this app saw, else the close date", () => {
  const task = { id: "t1", createdAt: NOW - 20 * DAY, closedAt: null };
  const observed = [
    { taskId: "t1", at: NOW - 3 * DAY, from: "myQueue", to: "waiting" },
    { taskId: "other", at: NOW - 3 * DAY, from: "myQueue", to: "closed" }
  ];
  assert.deepEqual(fallbackPath(task, "waiting", observed), [
    { at: NOW - 20 * DAY, perspective: "myQueue" },
    { at: NOW - 3 * DAY, perspective: "waiting" }
  ]);
  assert.deepEqual(fallbackPath({ ...task, closedAt: NOW - DAY }, "closed", []), [
    { at: NOW - 20 * DAY, perspective: "myQueue" },
    { at: NOW - DAY, perspective: "closed" }
  ]);
  assert.deepEqual(fallbackPath(task, "waiting", []), [{ at: NOW - 20 * DAY, perspective: "waiting" }], "nothing known: where it is now");
});

test("the numbers count the queue: hand-offs per week, the My queue line, needed per day", () => {
  const tasks = [
    // handed off 3 days ago, came back yesterday: in the queue again
    { perspective: "myQueue", createdAt: NOW - 30 * DAY, path: [{ at: NOW - 30 * DAY, perspective: "myQueue" }, { at: NOW - 3 * DAY, perspective: "waiting" }, { at: NOW - DAY, perspective: "myQueue" }] },
    // handed off today
    { perspective: "waiting", createdAt: NOW - 30 * DAY, path: [{ at: NOW - 30 * DAY, perspective: "myQueue" }, { at: NOW - 60 * 60 * 1000, perspective: "waiting" }] },
    // closed long ago
    { perspective: "closed", createdAt: NOW - 60 * DAY, path: [{ at: NOW - 60 * DAY, perspective: "myQueue" }, { at: NOW - 40 * DAY, perspective: "closed" }] },
    // new, never moved
    { perspective: "myQueue", createdAt: NOW - 2 * DAY, path: [{ at: NOW - 2 * DAY, perspective: "myQueue" }] }
  ];
  const result = pace(tasks, { now: NOW, lastDeadline: NOW + 14 * DAY });
  assert.deepEqual([result.inQueue, result.waiting, result.closed], [2, 1, 1]);
  assert.equal(result.actualPerWeek, 1, "two hand-offs in two weeks");
  assert.equal(result.neededPerWeek, 1, "two in the queue, two weeks left");
  const line = burnDownHistory(tasks, { now: NOW, weeks: 1 });
  assert.deepEqual(line.map((point) => point.open), [2, 2], "a week ago: two in the queue; now: two again");
  const daily = dailyPace(tasks, { now: NOW, deadline: { label: "Freeze", date: NOW + 7 * DAY } });
  assert.equal(daily.tasks, 2, "the queue, not everything that is not closed");
  assert.equal(daily.handedOffToday, 1);
});

// ---- the opening of a conversation -------------------------------------------------

test("the first user messages are read from a transcript's head, tool results skipped", () => {
  const lines = [
    JSON.stringify({ type: "summary", summary: "x" }),
    JSON.stringify({ type: "user", message: { content: "You are the builder. Read your definition." } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "CU-zzz999zz9" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Work on https://app.clickup.com/t/abc123aa1 please" }] } }),
    '{"type":"user","message":{"content":"cut in ha'
  ].join("\n");
  const text = openingTextFromTranscript(lines);
  assert.ok(text.includes("app.clickup.com/t/abc123aa1"));
  assert.ok(!text.includes("zzz999zz9"), "a tool result is not the user's text");
  assert.equal(openingTextFromTranscript(lines, { maximumUserMessages: 1 }), "You are the builder. Read your definition.");
  assert.equal(openingTextFromTranscript(""), "");
});

// ---- branches as real repositories name them ----------------------------------------

test("CU- branches in any case, with long suffixes or under a folder", () => {
  assert.equal(taskIdFromBranch("CU-abc123aa1-team-dashboard"), "abc123aa1");
  assert.equal(taskIdFromBranch("cu-abc123aa1"), "abc123aa1");
  assert.equal(taskIdFromBranch("Cu-abc123aa1"), "abc123aa1");
  assert.equal(taskIdFromBranch("someone/CU-abc123aa1-fix"), "abc123aa1");
  assert.equal(taskIdFromBranch("refs/remotes/origin/CU-abc123aa1_hotfix"), "abc123aa1");
  assert.equal(taskIdFromBranch("feature-abc123aa1"), null);
});

test("only the project's branches are inspected, and staging is read in one pass", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-branches-"));
  const git = (...gitArguments) => execFileSync("git", ["-C", folder, ...gitArguments], { stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(folder, "file.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  for (const branch of ["CU-abc123aa1-long-name", "cu-def456aa2", "CU-ghi789aa3"]) {
    git("branch", branch);
  }
  git("checkout", "-q", "CU-abc123aa1-long-name");
  fs.writeFileSync(path.join(folder, "file.txt"), "two\n");
  git("commit", "-q", "-am", "work");
  git("checkout", "-q", "main");
  git("branch", "staging", "CU-abc123aa1-long-name");
  // A remote named origin that is this repository itself.
  git("remote", "add", "origin", folder);
  git("fetch", "-q", "origin");
  const result = await inspectRepository(
    { name: "website", localPath: folder, baseBranch: "main", stagingBranch: "staging" },
    { taskIds: new Set(["abc123aa1", "def456aa2"]) }
  );
  assert.deepEqual(Object.keys(result.branchesByTask).sort(), ["abc123aa1", "def456aa2"], "ghi789aa3 is not this project's");
  const [branch] = result.branchesByTask.abc123aa1;
  assert.equal(branch.aheadOfBase, 1);
  assert.equal(branch.inStaging, true);
  assert.equal(result.branchesByTask.def456aa2[0].inStaging, false, "no commits of its own: just cut, not in staging");
});

// ---- the window's helpers ------------------------------------------------------------

test("searching projects finds them by name and by their tasks' names and ids", () => {
  const summaries = [
    { id: "one", name: "Website", tasks: [{ id: "abc123aa1", name: "Leaderboards" }, { id: "abc123aa2", name: "Menu" }] },
    { id: "two", name: "Mobile app", tasks: [{ id: "def456aa1", name: "Leaderboard number format" }] },
    { id: "three", name: "Docs", tasks: [] }
  ];
  assert.equal(searchProjects(summaries, "").length, 3);
  assert.deepEqual(searchProjects(summaries, "leader").map((entry) => [entry.id, entry.matchingTasks.length]), [["one", 1], ["two", 1]]);
  assert.deepEqual(searchProjects(summaries, "CU-abc123aa2").map((entry) => entry.id), ["one"]);
  assert.deepEqual(searchProjects(summaries, "docs").map((entry) => [entry.id, entry.matchingTasks.length]), [["three", 0]]);
  assert.deepEqual(searchProjects(summaries, "Mobíle").map((entry) => entry.id), ["two"], "accents do not matter");
});

test("searching cards looks at names, ids, statuses, people, specs and branches", () => {
  const cards = [
    { id: "abc123aa1", name: "Leaderboards", status: "in staging", assignees: [{ name: "Sam" }], branches: [{ name: "CU-abc123aa1" }], planning: { name: "Ranking spec" } },
    { id: "abc123aa2", name: "Menu", status: "Open", assignees: [], branches: [] }
  ];
  assert.deepEqual(searchCards(cards, "ranking").map((card) => card.id), ["abc123aa1"]);
  assert.deepEqual(searchCards(cards, "sam").map((card) => card.id), ["abc123aa1"]);
  assert.deepEqual(searchCards(cards, "cu-abc123aa2").map((card) => card.id), ["abc123aa2"]);
  assert.equal(searchCards(cards, "  ").length, 2);
});

test("a number on top is a filter: a bucket, a person, a place, the spec counters", () => {
  const spec = (stage) => ({ steps: ["noSpec", "session", "draft", "review", "approved"], index: ["noSpec", "session", "draft", "review", "approved"].indexOf(stage) });
  const snapshot = {
    cards: [
      { id: "b1", kind: "build", bucket: "inStaging", perspective: "waiting", assignees: [{ id: "7" }], planning: { id: "p1" }, spec: spec("approved"), pullRequests: [] },
      { id: "b2", kind: "build", bucket: "open", perspective: "myQueue", assignees: [], planning: { id: "p2" }, spec: spec("draft"), pullRequests: [{ state: "open", ci: "failing" }] },
      { id: "b3", kind: "build", bucket: "done", perspective: "closed", assignees: [{ id: "7" }], planning: null, spec: spec("approved"), pullRequests: [] },
      { id: "s1", kind: "spec", bucket: null, perspective: null, assignees: [], planning: { id: "s1" }, spec: spec("review"), pullRequests: [] }
    ]
  };
  const ids = (stat) => cardsForStat(snapshot, stat).map((card) => card.id);
  assert.deepEqual(ids({ kind: "bucket", bucket: "inStaging" }), ["b1"]);
  assert.deepEqual(ids({ kind: "person", personId: "7" }), ["b1"], "not the closed one");
  assert.deepEqual(ids({ kind: "person", personId: null }), ["b2"], "nobody");
  assert.deepEqual(ids({ kind: "perspective", perspective: "myQueue" }), ["b2"]);
  assert.deepEqual(ids({ kind: "specsToWrite" }), ["b2"]);
  assert.deepEqual(ids({ kind: "specsInReview" }), ["s1"]);
  assert.deepEqual(ids({ kind: "redCi" }), ["b2"]);
});

test("an empty deadline axis says honestly why", () => {
  assert.equal(emptyDeadlineReason({ dateSources: { dueDates: 0, milestones: 0, deadlinesSet: 0 } }).key, "projects.noDatesInClickup");
  assert.deepEqual(emptyDeadlineReason({ dateSources: { dueDates: 2, milestones: 0, deadlinesSet: 0 } }), {
    key: "projects.datesInClickup",
    values: { dueDates: 2, milestones: 0 }
  });
  assert.equal(emptyDeadlineReason({ dateSources: { dueDates: 0, milestones: 0, deadlinesSet: 1 } }).key, "projects.deadlinesWithoutDates");
});

test("dates typed in a field, Up next reordered, and a session's first message", () => {
  const time = dateInputToTime("2026-10-15");
  assert.equal(timeToDateInput(time), "2026-10-15");
  assert.equal(new Date(time).getHours(), 12, "noon, so no time zone moves the day");
  assert.equal(dateInputToTime("15/10/2026"), null);
  assert.deepEqual(moveInList(["a", "b", "c"], "c", -1), ["a", "c", "b"]);
  assert.deepEqual(moveInList(["a", "b", "c"], "a", -1), ["a", "b", "c"], "the first cannot go higher");
  const message = taskKickoffMessage({ id: "abc123aa1", name: "Leaderboards", url: "https://app.clickup.com/t/abc123aa1", kind: "build" });
  assert.ok(message.startsWith("https://app.clickup.com/t/abc123aa1"), "the link first, inside the short first prompt the list keeps");
});

// ---- what the store keeps ------------------------------------------------------------------

test("the store keeps the project link, focus rules, the user's side and the developer field", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-settings-"));
  const store = createProjectBoardStore({ storagePath: path.join(folder, "project-boards.json") });
  const board = store.addBoard({
    name: "Website",
    clickup: { buildListId: "901300000001", projectLink: "https://app.clickup.com/999999/v/li/901300000001" },
    focusRules: { recentSession: false, madeUp: true },
    perspectiveOverrides: { "in staging": "myQueue", "weird": "nowhere" },
    developerStatusFieldName: "Build Status",
    developerStatusMap: { Complete: "waiting", Other: "maybe" },
    deadlines: [
      { label: "Theme spec", source: "task", taskId: "abc123aa1" },
      { label: "No date", source: "manual" }
    ]
  });
  assert.equal(board.clickup.projectLink, "https://app.clickup.com/999999/v/li/901300000001");
  assert.deepEqual(board.focusRules, { myQueue: true, needsMe: true, recentSession: false, upNext: true, everythingOpen: false });
  assert.deepEqual(board.perspectiveOverrides, { "in staging": "myQueue" });
  assert.equal(board.developerStatusFieldName, "Build Status");
  assert.deepEqual(board.developerStatusMap, { Complete: "waiting" });
  assert.deepEqual(board.deadlines.map((deadline) => [deadline.label, deadline.date]), [["Theme spec", null]], "a deadline that follows a task needs no date of its own");
});

test("a whole snapshot: the user's side, the developer field, a deadline that follows a task", async () => {
  const { buildProjectSnapshot } = await import("../electron/lib/projectSnapshot.js");
  const { mapTask } = await import("../electron/lib/clickupClient.js");
  const raw = (id, status, type, extra = {}) =>
    mapTask({
      id,
      name: `Task ${id}`,
      status: { status, type },
      date_created: String(NOW - 20 * DAY),
      custom_fields: [{ name: "Build Status", type: "drop_down", value: extra.web === undefined ? 0 : extra.web, type_config: { options: [{ id: "a", name: "Backlog", orderindex: 0 }, { id: "b", name: "Staging Complete", orderindex: 1 }] } }],
      due_date: extra.due ? String(extra.due) : null
    });
  const buildTasks = [
    raw("abc123aa1", "in staging", "custom", { web: 1 }),
    raw("abc123aa2", "in progress", "custom", { web: 1 }),
    raw("abc123aa3", "Open", "open", { due: NOW + 10 * DAY })
  ];
  const snapshot = buildProjectSnapshot({
    board: {
      id: "website",
      name: "Website",
      developerStatusMap: { "Staging Complete": "waiting" },
      deadlines: [{ id: "d1", label: "Freeze", source: "task", taskId: "abc123aa3", date: null }]
    },
    buildTasks,
    statusHistory: {
      abc123aa1: [
        { status: "Open", type: "open", since: NOW - 20 * DAY },
        { status: "in staging", type: "custom", since: NOW - 2 * 60 * 60 * 1000 }
      ]
    },
    now: NOW
  });
  const card = (id) => snapshot.cards.find((entry) => entry.id === id);
  assert.equal(snapshot.developerStatusField, "Build Status", "detected");
  assert.equal(card("abc123aa1").developerStatus, "Staging Complete");
  assert.equal(card("abc123aa2").perspective, "waiting", "the developer field placed it");
  assert.deepEqual([snapshot.stats.inQueue, snapshot.stats.waiting, snapshot.stats.closed], [1, 2, 0]);
  assert.deepEqual(snapshot.filters.focus, ["abc123aa3"], "My focus is the queue");
  assert.equal(snapshot.timeline.next.label, "Freeze");
  assert.equal(snapshot.timeline.next.date, NOW + 10 * DAY, "the task's due date");
  assert.equal(snapshot.dailyPace.handedOffToday, 1, "from ClickUp's time in status");
  assert.equal(card("abc123aa1").build.handOffIndex, 4, "staging is where the user's part is handed off");
});

// ---- where the phases come from ------------------------------------------------------

test("phases and single dates are read from tasks; undated ones are counted, not drawn", async () => {
  const { datedItems } = await import("../electron/lib/deadlineSources.js");
  const { items, undated } = datedItems([
    { id: "p1", name: "Phase one", startDate: NOW - 20 * DAY, dueDate: NOW + 60 * DAY },
    { id: "m1", name: "Demo ready", startDate: NOW + 90 * DAY, dueDate: NOW + 90 * DAY, isMilestone: true },
    { id: "m2", name: "Code freeze", dueDate: NOW + 30 * DAY },
    { id: "u1", name: "Celebration" }
  ]);
  assert.equal(undated, 1);
  assert.deepEqual(items.map((item) => [item.taskId, item.kind]), [["p1", "span"], ["m2", "marker"], ["m1", "marker"]]);
  assert.equal(items[0].start, NOW - 20 * DAY);
  assert.equal(items[2].start, null, "a one-day phase is a single date");
});

test("the plan is the task a project's milestones hang under, named for the project", async () => {
  const { chooseDeadlineSource, cleanDeadlineSource, listCandidates, nameMatchesProject, roadmapCandidates } = await import("../electron/lib/deadlineSources.js");
  assert.equal(nameMatchesProject("Website", ["Website"]), true);
  assert.equal(nameMatchesProject("Website 2027", ["website"]), true);
  assert.equal(nameMatchesProject("Websites old", ["Website"]), false, "whole words");
  const dated = [{ id: "s1", name: "Phase one", startDate: NOW, dueDate: NOW + 10 * DAY }];
  const roadmaps = roadmapCandidates(
    [
      { task: { id: "r1", name: "Website", listName: "Products" }, subtasks: dated },
      { task: { id: "r2", name: "Mobile app", listName: "Products" }, subtasks: dated }
    ],
    ["Website"]
  );
  assert.deepEqual(roadmaps.map((candidate) => [candidate.id, candidate.matchesName, candidate.dated]), [["r1", true, 1], ["r2", false, 1]]);
  const lists = listCandidates([
    { id: "l1", name: "Roadmap", tasks: dated },
    { id: "l2", name: "Bugs", tasks: dated },
    { id: "l3", name: "Release timeline", tasks: [] }
  ]);
  assert.deepEqual(lists.map((candidate) => candidate.id), ["l1"], "a plan-like name with dated tasks");
  assert.equal(chooseDeadlineSource([...roadmaps, ...lists]).id, "r1", "the one named for the project wins");
  assert.equal(chooseDeadlineSource(lists).id, "l1", "the only candidate");
  assert.equal(chooseDeadlineSource([...lists, { kind: "list", id: "l9", name: "Timeline", dated: 2, matchesName: false }]), null, "two unnamed: the user picks");
  assert.deepEqual(cleanDeadlineSource({ mode: "task" }), { mode: "auto", id: null, name: null, includeManual: true }, "a task source needs its task");
  assert.deepEqual(cleanDeadlineSource({ mode: "manual", includeManual: false }), { mode: "manual", id: null, name: null, includeManual: false });
});

test("the axis draws phases as bars in lanes and merges single dates on the same day", async () => {
  const { deadlineTimeline } = await import("../electron/lib/projectStats.js");
  const { axisMilestones, phaseLanes } = await import("../src/renderer/projectsView.js");
  const timeline = deadlineTimeline(
    [
      { id: "a", label: "Specs", start: NOW - 30 * DAY, date: NOW - 5 * DAY },
      { id: "b", label: "Features web", start: NOW - 25 * DAY, date: NOW + 80 * DAY },
      { id: "c", label: "Alpha", start: NOW + 90 * DAY, date: NOW + 110 * DAY },
      { id: "d", label: "Demo ready", date: NOW + 150 * DAY },
      { id: "e", label: "Reports ready", date: NOW + 150 * DAY }
    ],
    { now: NOW }
  );
  assert.equal(timeline.next.label, "Features web", "the running phase's end is next");
  assert.equal(timeline.deadlines.find((deadline) => deadline.id === "b").running, true);
  const lanes = phaseLanes(timeline);
  assert.deepEqual(lanes.map((lane) => lane.map((phase) => phase.id)), [["a", "c"], ["b"]], "Alpha fits after Specs in the first lane");
  assert.equal(lanes[0][0].state, "done");
  const markers = axisMilestones(timeline);
  assert.deepEqual(markers.map((marker) => marker.label), ["Demo ready · Reports ready"]);
});

// ---- the side panel's zoom ------------------------------------------------------------------

test("the side panel's zoom: clamped, stepped like a browser, labelled only when not 100 %", async () => {
  const { applyZoomCommand, clampZoom, stepZoom, zoomLabel } = await import("../src/renderer/panelZoom.js");
  assert.equal(clampZoom(10), 3);
  assert.equal(clampZoom(0.1), 0.5);
  assert.equal(clampZoom("nonsense"), 1);
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(1.2, 1), 1.25, "between two steps: the next one up");
  assert.equal(stepZoom(3, 1), 3, "the top stays the top");
  assert.equal(zoomLabel(1), null);
  assert.equal(zoomLabel(1.25), "125 %");
  assert.equal(applyZoomCommand(1.25, "reset"), 1);
  assert.equal(applyZoomCommand(1.1, "in"), 1.25);
  assert.equal(applyZoomCommand(1.1, "out"), 1);
});

// ---- review fixes ------------------------------------------------------------------------------

test("a 429 waits for X-RateLimit-Reset (a minute at most) and tries once more", async () => {
  const { createClickupClient, rateLimitWait } = await import("../electron/lib/clickupClient.js");
  const header = (value) => ({ headers: { get: (name) => (name === "x-ratelimit-reset" ? value : null) } });
  assert.equal(rateLimitWait(header(String((NOW + 5000) / 1000)), NOW), 5000);
  assert.equal(rateLimitWait(header(null), NOW), 60000, "no header: a minute");
  assert.equal(rateLimitWait(header(String((NOW + 10 * 60000) / 1000)), NOW), 60000, "never longer than a minute");
  const waits = [];
  let calls = 0;
  const client = createClickupClient({
    token: "pk_test",
    minimumGapMilliseconds: 0,
    now: () => NOW,
    wait: async (milliseconds) => waits.push(milliseconds),
    fetchImplementation: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 429, headers: { get: () => String((NOW + 2000) / 1000) }, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ user: { id: 7, username: "Sam" } }) };
    }
  });
  const user = await client.getCurrentUser();
  assert.equal(user.name, "Sam");
  assert.equal(calls, 2);
  assert.deepEqual(waits.filter((milliseconds) => milliseconds > 0), [2000]);
  let always = 0;
  const stubborn = createClickupClient({
    token: "pk_test",
    minimumGapMilliseconds: 0,
    wait: async () => {},
    fetchImplementation: async () => {
      always += 1;
      return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
    }
  });
  await assert.rejects(stubborn.getCurrentUser(), (error) => error.kind === "rate-limited");
  assert.equal(always, 2, "only one retry");
});

test("a list longer than the pages read says so", async () => {
  const { createClickupClient } = await import("../electron/lib/clickupClient.js");
  const client = createClickupClient({
    token: "pk_test",
    minimumGapMilliseconds: 0,
    fetchImplementation: async () => ({ ok: true, status: 200, json: async () => ({ tasks: [{ id: "abc123aa1", status: {} }], last_page: false }) })
  });
  const tasks = await client.listTasks("901300000001", { maximumPages: 2 });
  assert.equal(tasks.length, 2);
  assert.equal(tasks.truncated, true);
  const done = createClickupClient({
    token: "pk_test",
    minimumGapMilliseconds: 0,
    fetchImplementation: async () => ({ ok: true, status: 200, json: async () => ({ tasks: [{ id: "abc123aa1", status: {} }], last_page: true }) })
  });
  assert.equal((await done.listTasks("901300000001")).truncated, false);
});

test("both pace figures use the next deadline, and under one a day it is said per week", async () => {
  const { dailyPaceText } = await import("../src/renderer/projectsView.js");
  const tasks = Array.from({ length: 4 }, (unused, index) => ({ perspective: "myQueue", createdAt: NOW - DAY, path: [{ at: NOW - DAY, perspective: "myQueue" }], id: `t${index}` }));
  const next = NOW + 14 * DAY;
  const result = pace(tasks, { now: NOW, deadline: next });
  assert.equal(result.neededPerWeek, 2, "four in two weeks, not over the last deadline");
  const daily = dailyPace(tasks, { now: NOW, deadline: { label: "Freeze", date: next } });
  const text = dailyPaceText(daily);
  assert.equal(text.key, "projects.paceLineWeekly");
  assert.equal(text.values.range, "2");
  const busy = dailyPaceText(dailyPace([...tasks, ...tasks, ...tasks, ...tasks], { now: NOW, deadline: { label: "Freeze", date: NOW + 7 * DAY } }));
  assert.equal(busy.key, "projects.paceLine", "three a day stays per day");
});

test("no token is not remembered: the Keychain is asked again, and a refused token is forgotten", async () => {
  const { createProjectDataService } = await import("../electron/projectData.js");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-token-"));
  const boardStore = createProjectBoardStore({ storagePath: path.join(folder, "project-boards.json") });
  const board = boardStore.addBoard({ name: "Website", clickup: { buildListId: "901300000001" } });
  let token = null;
  let reads = 0;
  let refuse = false;
  const service = createProjectDataService({
    boardStore,
    cacheDirectory: path.join(folder, "project-cache"),
    getSessions: async () => [],
    getAgents: () => ({ agents: [], sessionAgents: {} }),
    readToken: async () => {
      reads += 1;
      return token;
    },
    fetchImplementation: async (url) => {
      if (refuse) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      if (url.includes("/list/901300000001/task")) {
        return { ok: true, status: 200, json: async () => ({ tasks: [], last_page: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { id: 1, username: "Sam" } }) };
    },
    inspectRepositoryImplementation: async () => ({ available: true, branchesByTask: {} }),
    listPullRequestsImplementation: async () => ({ available: true, byTask: {} }),
    fixturePath: null,
    now: () => NOW
  });
  const without = await service.snapshot(board.id, { refresh: true });
  assert.equal(without.sources.clickup.error, "no-token");
  token = "pk_test";
  const withToken = await service.snapshot(board.id, { refresh: true });
  assert.equal(withToken.sources.clickup.ok, true, "the item added to the Keychain is found without a restart");
  const readsBefore = reads;
  refuse = true;
  const refused = await service.snapshot(board.id, { refresh: true });
  assert.equal(refused.sources.clickup.error, "unauthorized");
  refuse = false;
  await service.snapshot(board.id, { refresh: true });
  assert.ok(reads > readsBefore, "a refused token is read again");
});

test("a refresh that cannot read time in status or the deadlines keeps the last ones", async () => {
  const { createProjectDataService } = await import("../electron/projectData.js");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-keep-"));
  const cacheDirectory = path.join(folder, "project-cache");
  const boardStore = createProjectBoardStore({ storagePath: path.join(folder, "project-boards.json") });
  const board = boardStore.addBoard({
    name: "Website",
    clickupUserId: "1",
    clickup: { buildListId: "901300000001" },
    deadlineSource: { mode: "task", id: "r1", name: "Website" }
  });
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const kept = {
    buildTasks: [],
    planningTasks: [],
    refreshedAt: NOW - DAY,
    statusHistory: { abc123aa1: [{ status: "Open", type: "open", since: NOW - 9 * DAY }] },
    deadlineItems: [{ id: "clickup-p1", taskId: "p1", label: "Phase one", date: NOW + 10 * DAY, start: NOW - DAY, kind: "span", source: "clickup" }],
    deadlineUndated: 1,
    deadlineSource: { mode: "task", kind: "task", id: "r1", name: "Website" },
    deadlineDiscovery: { candidates: [], chosenId: null, at: NOW - 3 * DAY }
  };
  fs.writeFileSync(path.join(cacheDirectory, `${board.id}.json`), JSON.stringify(kept));
  const service = createProjectDataService({
    boardStore,
    cacheDirectory,
    getSessions: async () => [],
    getAgents: () => ({ agents: [], sessionAgents: {} }),
    readToken: async () => "pk_test",
    fetchImplementation: async (url) => {
      if (url.includes("/list/901300000001/task")) {
        return { ok: true, status: 200, json: async () => ({ tasks: [{ id: "abc123aa1", name: "Menu", status: { status: "Open", type: "open" } }], last_page: true }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    },
    inspectRepositoryImplementation: async () => ({ available: true, branchesByTask: {} }),
    listPullRequestsImplementation: async () => ({ available: true, byTask: {} }),
    fixturePath: null,
    now: () => NOW
  });
  const snapshot = await service.snapshot(board.id, { refresh: true });
  assert.equal(snapshot.sources.clickup.ok, true);
  assert.equal(snapshot.timeline.deadlines.length, 1, "the last phases stay on the axis");
  assert.equal(snapshot.dateSources.source.name, "Website");
  const saved = JSON.parse(fs.readFileSync(path.join(cacheDirectory, `${board.id}.json`), "utf8"));
  assert.deepEqual(saved.statusHistory, kept.statusHistory, "time in status kept");
  assert.equal(saved.deadlineItems.length, 1);
  assert.equal(saved.deadlineDiscovery.at, NOW, "the failed attempt is stamped");
});
