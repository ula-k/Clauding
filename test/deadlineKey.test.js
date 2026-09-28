// The deadline axis: which date "Next" counts to (pinned > end of the phase
// Today is in > nearest ahead), hidden items, and where a phase's name goes.
import test from "node:test";
import assert from "node:assert/strict";
import { chooseNextTarget, deadlineTimeline } from "../electron/lib/projectStats.js";
import { cleanBoard } from "../electron/projectBoards.js";
import { keyAxisMarker, phaseLabelPlacement, phaseLanes } from "../src/renderer/projectsView.js";

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

test("a phase's name goes outside a bar too short for it, never cut off", () => {
  const text = "Initial Features Web · Sep 1 → Dec 23";
  assert.equal(phaseLabelPlacement({ startAt: 0, at: 0.9 }, 800, text), "inside");
  assert.equal(phaseLabelPlacement({ startAt: 0.1, at: 0.2 }, 800, text), "right");
  assert.equal(phaseLabelPlacement({ startAt: 0.8, at: 0.9 }, 800, text), "left");
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
  const labelOf = (phase, outside) => (outside ? `${phase.label} → Aug 31` : `${phase.label} · Jul 6 → Aug 31`);
  assert.equal(phaseLanes(timeline).length, 1, "the bars alone fit in one lane");
  const lanes = phaseLanes(timeline, { axisWidth: 400, labelOf });
  assert.equal(lanes.length, 2);
  assert.equal(lanes[0][0].placement, "right");
  assert.equal(phaseLanes(timeline, { axisWidth: 1400, labelOf }).length, 1, "wide enough: both names inside, one lane");
});
