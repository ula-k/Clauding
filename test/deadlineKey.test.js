// The deadline axis: which date "Next" counts to (pinned > end of the phase
// Today is in > nearest ahead), hidden items, and where a phase's name goes.
import test from "node:test";
import assert from "node:assert/strict";
import { chooseNextTarget, deadlineTimeline } from "../electron/lib/projectStats.js";
import { cleanBoard } from "../electron/projectBoards.js";
import { axisMilestones, keyAxisMarker, phaseLabelOptions, phaseLanes } from "../src/renderer/projectsView.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-01T12:00:00Z");
const web = { id: "clickup-web", label: "Initial Features Web", start: Date.parse("2026-09-01T12:00:00Z"), date: Date.parse("2026-12-23T12:00:00Z"), source: "clickup" };
const mobile = { ...web, id: "clickup-mobile", label: "Initial Features Mobile" };
const review = { id: "clickup-review", label: "Design review", date: now + 10 * DAY, source: "clickup" };
const launch = { id: "launch", label: "Launch", date: Date.parse("2027-02-01T12:00:00Z"), source: "manual" };

test("the end of the running phase is Next, not a nearer single date", () => {
  const timeline = deadlineTimeline([web, review, launch], { now });
  assert.equal(timeline.next.id, "clickup-web");
  assert.equal(timeline.next.reason, "phaseEnd");
  assert.equal(timeline.next.isPhaseEnd, true);
  assert.deepEqual(keyAxisMarker(timeline), { id: "clickup-web", at: timeline.next.at, label: "Initial Features Web", date: web.date, reason: "phaseEnd" });
});

test("a pinned key deadline wins over the running phase; a passed pin falls back", () => {
  const pinned = deadlineTimeline([web, review, launch], { now, keyDeadlineId: "launch" });
  assert.equal(pinned.next.id, "launch");
  assert.equal(pinned.next.reason, "pinned");
  assert.equal(keyAxisMarker(pinned), null, "a single date is its own diamond");
  const passed = deadlineTimeline([web, { ...launch, date: now - 5 * DAY }], { now, keyDeadlineId: "launch" });
  assert.equal(passed.next.id, "clickup-web");
});

test("with no phase running, Next is the nearest date ahead", () => {
  assert.equal(chooseNextTarget([{ ...review, passed: false }, { ...launch, passed: false }], { now }).id, "clickup-review");
  assert.equal(chooseNextTarget([], { now }), null);
  const later = deadlineTimeline([{ ...web, start: now + 3 * DAY }, launch], { now });
  assert.equal(later.next.id, "clickup-web");
  assert.equal(later.next.reason, "nearest");
});

test("hidden items are not drawn, are counted, and stay listed for the settings", () => {
  const timeline = deadlineTimeline([web, mobile, review], { now, hiddenIds: ["clickup-mobile"] });
  assert.deepEqual(timeline.deadlines.map((deadline) => deadline.id).sort(), ["clickup-review", "clickup-web"]);
  assert.equal(timeline.hiddenCount, 1);
  assert.deepEqual(timeline.items.map((item) => [item.id, item.hidden]), [["clickup-web", false], ["clickup-mobile", true], ["clickup-review", false]]);
  const allHidden = deadlineTimeline([review], { now, hiddenIds: ["clickup-review"] });
  assert.equal(allHidden.deadlines.length, 0);
  assert.equal(allHidden.hiddenCount, 1);
  assert.equal(allHidden.next, null);
});

test("two phases with the same dates get two lanes", () => {
  const lanes = phaseLanes(deadlineTimeline([web, mobile], { now }));
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes.map((lane) => lane[0].label).sort(), ["Initial Features Mobile", "Initial Features Web"]);
});

test("a phase's name goes inside its bar, else right after it, else shorter inside — never before the bar", () => {
  const names = () => ["Initial Features Web · Sep 1 → Dec 23", "Initial Features Web → Dec 23", "Initial Features Web"];
  const options = (phase) => phaseLabelOptions(phase, { axisWidth: 800, labelsOf: names });
  assert.deepEqual(options({ startAt: 0, at: 0.9 })[0].placement, "inside");
  assert.deepEqual(options({ startAt: 0.1, at: 0.2 })[0], { text: names()[0], placement: "right", reach: 0.2 + (6 + names()[0].length * 6.2) / 800 });
  const nearTheEnd = options({ startAt: 0.66, at: 0.92 });
  assert.deepEqual(nearTheEnd.map((option) => option.placement), ["inside", "inside", "right"], "no room after it: the shorter names go inside");
  assert.equal(nearTheEnd[0].text, "Initial Features Web → Dec 23");
  assert.ok(nearTheEnd.every((option) => option.placement !== "left"));
});

test("the board keeps the hidden list and the key deadline", () => {
  const board = cleanBoard({ name: "Website", deadlineHidden: ["clickup-mobile", "clickup-mobile", ""], keyDeadlineId: "clickup-web" });
  assert.deepEqual(board.deadlineHidden, ["clickup-mobile"]);
  assert.equal(board.keyDeadlineId, "clickup-web");
  assert.equal(cleanBoard({ name: "X" }).keyDeadlineId, null);
});

test("a name drawn next to a short bar takes room in its lane, so the next bar moves down", () => {
  const short = { id: "pre", label: "Initial Build pre-work", start: Date.parse("2026-07-06T12:00:00Z"), date: Date.parse("2026-08-31T12:00:00Z"), source: "clickup" };
  const timeline = deadlineTimeline([short, web], { now });
  const labelsOf = (phase) => [`${phase.label} · Jul 6 → Aug 31`, `${phase.label} → Aug 31`, phase.label];
  assert.equal(phaseLanes(timeline).length, 1, "the bars alone fit in one lane");
  const lanes = phaseLanes(timeline, { axisWidth: 400, labelsOf });
  assert.equal(lanes.length, 2);
  assert.equal(lanes[0][0].placement, "right");
  assert.equal(lanes[0][0].labelText, "Initial Build pre-work · Jul 6 → Aug 31", "in one piece");
  assert.equal(phaseLanes(timeline, { axisWidth: 1400, labelsOf }).length, 1, "wide enough: both names inside, one lane");
  assert.equal(phaseLanes(timeline, { axisWidth: 1400, labelsOf })[0][0].placement, "inside");
});

test("past phases are done, the current one runs, later ones are later", () => {
  const future = { id: "alpha", label: "Alpha", start: Date.parse("2027-01-04T12:00:00Z"), date: Date.parse("2027-01-26T12:00:00Z"), source: "clickup" };
  const past = { id: "specs", label: "Specs", start: Date.parse("2026-08-03T12:00:00Z"), date: Date.parse("2026-09-25T12:00:00Z"), source: "clickup" };
  const states = Object.fromEntries(phaseLanes(deadlineTimeline([past, web, future], { now })).flat().map((phase) => [phase.id, phase.state]));
  assert.deepEqual(states, { specs: "done", "clickup-web": "running", alpha: "later" });
});

test("diamonds closer than 24 px become one with a count; same-day dates always do", () => {
  const single = (id, day) => ({ id, label: id, date: Date.parse(`2027-${day}T12:00:00Z`), source: "clickup" });
  const timeline = deadlineTimeline([web, single("Dev ends", "04-02"), single("Builds start", "04-05"), single("Stores", "06-30")], { now });
  const apart = axisMilestones(timeline);
  assert.equal(apart.length, 3, "without the axis width only the same day merges");
  const merged = axisMilestones(timeline, { axisWidth: 600 });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].together, 2);
  assert.deepEqual(merged[0].members.map((member) => member.label), ["Dev ends", "Builds start"]);
  assert.equal(merged[0].lastDate, Date.parse("2027-04-05T12:00:00Z"));
  assert.ok(merged[0].at > apart[0].at && merged[0].at < apart[1].at, "the diamond sits between its dates");
});
