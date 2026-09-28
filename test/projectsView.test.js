// CL-27 — the Projects view's own logic (src/renderer/projectsView.js): the
// list on the left, the filter chips and their counts, what a task card
// shows, and the words under the deadline axis — from a snapshot built out
// of the neutral fixture (test/fixtures/projects/website.json). No window,
// no network, no ClickUp.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  axisMilestones,
  bucketSegments,
  burnDownPoints,
  cardLinks,
  cardsForFilter,
  dailyPaceText,
  deadlineLabel,
  defaultSpecStage,
  filterChips,
  needsLabel,
  pipelineDots,
  projectListModel,
  sessionStateLabel,
  sourceState
} from "../src/renderer/projectsView.js";
import { createProjectDataService } from "../electron/projectData.js";
import { createProjectBoardStore } from "../electron/projectBoards.js";
import { specUrlFrom } from "../electron/lib/clickupClient.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "projects", "website.json");
const DAY = 24 * 60 * 60 * 1000;

function fixtureService() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-projectsview-"));
  return createProjectDataService({
    boardStore: createProjectBoardStore({ storagePath: path.join(folder, "project-boards.json") }),
    cacheDirectory: path.join(folder, "project-cache"),
    getSessions: async () => [],
    getAgents: () => ({ agents: [], sessionAgents: {} }),
    fixturePath
  });
}

test("the fixture supplies its own projects and never touches the store", async () => {
  const service = fixtureService();
  assert.equal(service.usesFixture, true);
  const summaries = service.summaries();
  assert.deepEqual(summaries.map((summary) => summary.id), ["website", "mobile-app", "docs-site"]);
  assert.equal(summaries[1].summary, null, "a project without tasks has no numbers yet");
  const noToken = await service.snapshot("mobile-app");
  assert.equal(sourceState(noToken).kind, "noToken");
});

test("the list: groups in order, a bar, the nearest deadline and the queue", () => {
  const groups = projectListModel(fixtureService().summaries());
  assert.deepEqual(groups.map((group) => group.name), ["Work", "Private"]);
  const [website, mobile] = groups[0].projects;
  // From the user's side: on her plate, waiting on others, closed.
  assert.equal(website.inQueue, 11);
  assert.equal(website.waiting, 4);
  assert.equal(website.closed, 4);
  assert.deepEqual(website.deadline, { key: "projects.deadlineInDays", values: { label: "Feature freeze", count: 18 }, soon: false });
  assert.ok(Math.abs(website.segments.reduce((sum, segment) => sum + segment.fraction, 0) - 1) < 1e-9);
  assert.equal(mobile.loaded, false);
  assert.equal(groups[1].projects[0].deadline.soon, true, "five days away is soon");
});

test("deadline wording: today, tomorrow, in N days, none", () => {
  assert.equal(deadlineLabel({ label: "Launch", daysLeft: 0 }).key, "projects.deadlineToday");
  assert.equal(deadlineLabel({ label: "Launch", daysLeft: 1 }).key, "projects.deadlineTomorrow");
  assert.equal(deadlineLabel({ label: "Launch", daysLeft: 9 }).values.count, 9);
  assert.equal(deadlineLabel(null).key, "projects.noDeadline");
});

test("bucket segments drop empty buckets and keep the drawing order", () => {
  const segments = bucketSegments({ open: 2, inProgress: 0, done: 2, other: 1 });
  assert.deepEqual(segments.map((segment) => segment.bucket), ["open", "done", "other"]);
  assert.deepEqual(bucketSegments({}), []);
});

test("filter chips carry the counts of the snapshot's lists", async () => {
  const snapshot = await fixtureService().snapshot("website");
  const chips = Object.fromEntries(filterChips(snapshot).map((chip) => [chip.id, chip.count]));
  assert.deepEqual(chips, { focus: 14, upNext: 3, specs: 10, build: 19, everything: 23 }, "My focus is the whole queue; Specs pipeline counts every stage");
  const focus = cardsForFilter(snapshot, "focus").cards;
  assert.ok(focus[0].needs, "needs me first");
  assert.deepEqual(cardsForFilter(snapshot, "upNext").cards.map((card) => card.id), ["web0008", "web0007", "web0010"], "pinned order kept");
  const build = cardsForFilter(snapshot, "build");
  assert.equal(build.cards.length + build.notStarted.length, 19);
  assert.ok(build.notStarted.length > 0 && build.notStarted.every((card) => card.bucket === "open" && card.sessions.length === 0));
});

test("a card's chips: task, spec, sessions, branches per repository, the PR", async () => {
  const snapshot = await fixtureService().snapshot("website");
  const card = (cardId) => snapshot.cards.find((entry) => entry.id === cardId);
  const profile = cardLinks(card("web0001")).map((link) => link.kind);
  assert.deepEqual(profile, ["clickup", "spec", "session", "session", "branch", "missing"]);
  assert.equal(cardLinks(card("web0001")).at(-1).reason, "notPushed");
  const home = cardLinks(card("web0004"));
  assert.deepEqual(home.filter((link) => link.kind === "branch").map((link) => link.repository), ["website", "mobile"]);
  assert.deepEqual(home.find((link) => link.kind === "pullRequest"), {
    kind: "pullRequest", repository: "website", number: 418, state: "open", ci: "pending", url: "https://github.com/acme/website/pull/418"
  });
  const newsletter = cardLinks(card("pln0006")).map((link) => link.kind);
  assert.deepEqual(newsletter, ["clickup", "spec", "session"]);
  const notStarted = cardLinks(card("pln0008"));
  assert.deepEqual(notStarted.filter((link) => link.kind === "missing").map((link) => link.reason), ["noSpecPage", "noSpecSession"]);
  assert.equal(cardLinks(card("web0003"), { pullRequestsAvailable: false }).some((link) => link.reason === "ghUnavailable"), false, "a known PR is still shown");
});

test("pipeline dots: done, now, wait, todo — and nothing before a build starts", () => {
  const steps = ["open", "builder", "branch", "pr"];
  assert.deepEqual(pipelineDots({ steps, index: 2, state: "now" }).map((dot) => dot.state), ["done", "done", "now", "todo"]);
  assert.deepEqual(pipelineDots({ steps, index: 1, state: "wait" }).map((dot) => dot.state), ["done", "wait", "todo", "todo"]);
  assert.deepEqual(pipelineDots({ steps, index: 3, state: "done" }).map((dot) => dot.state), ["done", "done", "done", "done"]);
  assert.deepEqual(pipelineDots({ steps, index: -1, state: "now" }).map((dot) => dot.state), ["todo", "todo", "todo", "todo"]);
});

test("what waits on the user becomes a translated sentence", () => {
  assert.deepEqual(needsLabel({ kind: "red-ci", number: 412 }), { key: "projects.needsRedCi", values: { title: "", number: 412, branch: "" } });
  assert.equal(needsLabel({ kind: "session-question", title: "checkout" }).values.title, "checkout");
  assert.equal(needsLabel(null), null);
});

test("session state: needs answer, working, idle for days", () => {
  const now = Date.now();
  assert.equal(sessionStateLabel({ needsAnswer: true }, now).key, "projects.sessionNeedsAnswer");
  assert.equal(sessionStateLabel({ statusGroup: "running" }, now).key, "projects.sessionWorking");
  assert.deepEqual(sessionStateLabel({ lastModified: now - 3 * DAY }, now), { key: "projects.sessionIdleDays", values: { count: 3 } });
});

test("the per-day line under the axis, and labels that would collide move down", async () => {
  const snapshot = await fixtureService().snapshot("website");
  const pace = dailyPaceText(snapshot.dailyPace);
  assert.equal(pace.key, "projects.paceLineWeekly", "under one a day it is said per week");
  assert.deepEqual(pace.values, { label: "Feature freeze", tasks: 11, days: 14, range: "4" }, "the queue, not everything open");
  assert.equal(pace.todayKey, "projects.handedOffTodayWeekly");
  assert.deepEqual(pace.todayDots, [true]);
  assert.equal(dailyPaceText(null), null);
  const milestones = axisMilestones(snapshot.timeline);
  assert.deepEqual(milestones.map((milestone) => milestone.state), ["done", "done", "next", "later", "later"]);
  assert.equal(milestones[1].row, 1, "Content ready sits too close to Specs v1");
  assert.equal(milestones[2].row, 0);
});

test("the spec pipeline opens on review when something waits there", async () => {
  const snapshot = await fixtureService().snapshot("website");
  assert.equal(defaultSpecStage(snapshot.specPipeline), "review");
  assert.equal(defaultSpecStage([{ stage: "noSpec", count: 0 }, { stage: "draft", count: 2 }]), "draft");
});

test("the burn-down line fits its box", () => {
  const points = burnDownPoints([{ open: 4 }, { open: 2 }, { open: 0 }], { width: 100, height: 20 }).split(" ");
  assert.equal(points.length, 3);
  assert.equal(points[0], "0,1");
  assert.equal(points[2], "100,19");
});

test("the header's state: offline keeps the time, errors name the call", () => {
  assert.equal(sourceState({ sources: { clickup: { ok: true, refreshedAt: 5 } } }).kind, "ok");
  assert.deepEqual(sourceState({ sources: { clickup: { ok: false, error: "network", refreshedAt: 7 } } }), { kind: "offline", refreshedAt: 7 });
  const failed = sourceState({ sources: { clickup: { ok: false, error: "http", message: "ClickUp answered 500.", call: "GET /v2/list/1/task" } } });
  assert.equal(failed.call, "GET /v2/list/1/task");
});

test("the spec link field is a board setting, matched without regard to case", () => {
  const fields = [{ name: "Design doc", type: "url", value: "https://example.com/doc" }, { name: "spec url", type: "url", value: "https://example.com/spec" }];
  assert.equal(specUrlFrom(fields), "https://example.com/spec");
  assert.equal(specUrlFrom(fields, "DESIGN DOC"), "https://example.com/doc");
  assert.equal(specUrlFrom(fields, "Missing"), null);
});
