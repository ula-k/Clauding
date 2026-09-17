// CL-21, CL-22 — picking several sessions out of the list, what a bulk
// action would then do (src/renderer/selectionPlan.js), and the colour a
// session's name is drawn in (src/renderer/sessionColors.js).
//
// All of it is pure functions: no window, no React, no Electron. The rules
// a click follows and the colour a session gets are decided here and only
// read by the components.
import test from "node:test";
import assert from "node:assert/strict";
import {
  bulkSessionPlan,
  confirmationTitles,
  selectionPlan,
  selectionWithin
} from "../src/renderer/selectionPlan.js";
import { SESSION_COLOR_TOKENS as STORED_COLOR_TOKENS } from "../electron/sessionGroups.js";
import {
  SESSION_COLOR_TOKENS,
  automaticSessionColor,
  hasChosenColor,
  sessionColorToken
} from "../src/renderer/sessionColors.js";

const ORDER = ["one", "two", "three", "four", "five"];
const NOTHING_PICKED = { sessionIds: [], anchorId: null };

test("a plain click is one row, and it is the click that opens a terminal", () => {
  const plan = selectionPlan({ sessionIds: ["one", "two"], anchorId: "one" }, { kind: "single", sessionId: "four" });
  assert.deepEqual(plan.sessionIds, ["four"]);
  assert.equal(plan.anchorId, "four");
  assert.equal(plan.openSessionId, "four");
});

test("a modifier click never opens a terminal", () => {
  const toggled = selectionPlan(NOTHING_PICKED, { kind: "toggle", sessionId: "two" });
  assert.equal(toggled.openSessionId, null);
  const ranged = selectionPlan({ sessionIds: ["one"], anchorId: "one" }, { kind: "range", sessionId: "three", orderedIds: ORDER });
  assert.equal(ranged.openSessionId, null);
});

test("⌘-click adds a row and takes it out again", () => {
  const added = selectionPlan({ sessionIds: ["one"], anchorId: "one" }, { kind: "toggle", sessionId: "three" });
  assert.deepEqual(added.sessionIds, ["one", "three"]);
  assert.equal(added.anchorId, "three");

  const removed = selectionPlan(added, { kind: "toggle", sessionId: "one" });
  assert.deepEqual(removed.sessionIds, ["three"]);
  // The anchor stays on the row that was clicked, even when the click took
  // it out: a Shift-click after it measures from there.
  assert.equal(removed.anchorId, "one");
});

test("Shift-click takes the range from the anchor, in the order on screen", () => {
  const picked = selectionPlan({ sessionIds: ["two"], anchorId: "two" }, { kind: "range", sessionId: "four", orderedIds: ORDER });
  assert.deepEqual(picked.sessionIds, ["two", "three", "four"]);
  assert.equal(picked.anchorId, "two");
});

test("a range upwards is the same range", () => {
  const picked = selectionPlan({ sessionIds: ["four"], anchorId: "four" }, { kind: "range", sessionId: "two", orderedIds: ORDER });
  assert.deepEqual(picked.sessionIds, ["two", "three", "four"]);
});

test("a second Shift-click replaces the range instead of leaving rows behind", () => {
  const first = selectionPlan({ sessionIds: ["one"], anchorId: "one" }, { kind: "range", sessionId: "five", orderedIds: ORDER });
  assert.deepEqual(first.sessionIds, ORDER);
  const second = selectionPlan(first, { kind: "range", sessionId: "two", orderedIds: ORDER });
  assert.deepEqual(second.sessionIds, ["one", "two"]);
});

test("Shift-click with no anchor yet is simply that one row", () => {
  const picked = selectionPlan(NOTHING_PICKED, { kind: "range", sessionId: "three", orderedIds: ORDER });
  assert.deepEqual(picked.sessionIds, ["three"]);
  assert.equal(picked.anchorId, "three");
});

test("a row that is not on screen any more cannot be ranged to", () => {
  const before = { sessionIds: ["two"], anchorId: "two" };
  const picked = selectionPlan(before, { kind: "range", sessionId: "gone", orderedIds: ORDER });
  assert.deepEqual(picked.sessionIds, ["two"]);
});

test("⌘A picks out every row on screen and Escape clears everything", () => {
  const all = selectionPlan({ sessionIds: ["two"], anchorId: "two" }, { kind: "all", orderedIds: ORDER });
  assert.deepEqual(all.sessionIds, ORDER);
  assert.equal(all.openSessionId, null);
  const cleared = selectionPlan(all, { kind: "clear" });
  assert.deepEqual(cleared.sessionIds, []);
  assert.equal(cleared.anchorId, null);
});

test("a selection is kept to the rows the list still draws", () => {
  assert.deepEqual(selectionWithin(["one", "gone", "four"], ORDER), ["one", "four"]);
});

// ---- what a bulk action would do -------------------------------------

function sessionNamed(sessionId, extra = {}) {
  return { sessionId, title: `Session ${sessionId}`, ...extra };
}

const RUNNING_ELSEWHERE = { liveStatus: { source: "registry" } };

test("hiding works on everything, including a session running elsewhere", () => {
  const sessions = [sessionNamed("one"), sessionNamed("two", RUNNING_ELSEWHERE)];
  const plan = bulkSessionPlan({ sessionIds: ["one", "two"], sessions, operation: "hide" });
  assert.deepEqual(plan.affected.map((entry) => entry.sessionId), ["one", "two"]);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.count, 2);
});

test("deleting leaves a session running outside the app alone, and names it", () => {
  const sessions = [sessionNamed("one"), sessionNamed("two", RUNNING_ELSEWHERE), sessionNamed("three")];
  const plan = bulkSessionPlan({ sessionIds: ["one", "two", "three"], sessions, operation: "delete" });
  assert.deepEqual(plan.affected.map((entry) => entry.sessionId), ["one", "three"]);
  assert.deepEqual(plan.skipped, [{ sessionId: "two", title: "Session two" }]);
  assert.equal(plan.count, 2);
});

test("a session of the app's own terminals is deleted like any other", () => {
  const sessions = [sessionNamed("one", { liveStatus: { source: "app" } })];
  const plan = bulkSessionPlan({ sessionIds: ["one"], sessions, operation: "delete" });
  assert.equal(plan.count, 1);
});

test("an id the list does not know is dropped from the plan", () => {
  const plan = bulkSessionPlan({ sessionIds: ["gone"], sessions: [sessionNamed("one")], operation: "delete" });
  assert.equal(plan.count, 0);
  assert.deepEqual(plan.skipped, []);
});

test("the confirmation names the first five and counts the rest", () => {
  const sessions = ORDER.concat(["six", "seven"]).map((sessionId) => sessionNamed(sessionId));
  const plan = bulkSessionPlan({ sessionIds: sessions.map((session) => session.sessionId), sessions, operation: "delete" });
  assert.equal(plan.count, 7);
  assert.deepEqual(confirmationTitles(plan.affected), [
    "Session one",
    "Session two",
    "Session three",
    "Session four",
    "Session five"
  ]);
});

// ---- the colour a session's name is drawn in -------------------------

test("the automatic colour of a session never changes", () => {
  const sessionId = "6f1f9d1e-0a2b-4c3d-8e5f-1234567890ab";
  const first = automaticSessionColor(sessionId);
  assert.ok(SESSION_COLOR_TOKENS.includes(first));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(automaticSessionColor(sessionId), first);
  }
});

test("the automatic colours spread over the whole palette", () => {
  const seen = new Set();
  for (let index = 0; index < 400; index += 1) {
    seen.add(automaticSessionColor(`session-${index}-2f8a`));
  }
  assert.equal(seen.size, SESSION_COLOR_TOKENS.length, "every swatch is used by some session");
});

test("a colour picked by hand wins over the automatic one", () => {
  const colors = { one: "--project-color-7" };
  assert.equal(sessionColorToken("one", colors), "--project-color-7");
  assert.equal(hasChosenColor("one", colors), true);
  assert.equal(sessionColorToken("two", colors), automaticSessionColor("two"));
  assert.equal(hasChosenColor("two", colors), false);
});

test("a stored colour that is not in the palette falls back to the automatic one", () => {
  const colors = { one: "#ff0000" };
  assert.equal(sessionColorToken("one", colors), automaticSessionColor("one"));
  assert.equal(hasChosenColor("one", colors), false);
});

test("a session with no id at all still gets a colour", () => {
  assert.ok(SESSION_COLOR_TOKENS.includes(sessionColorToken("", {})));
  assert.ok(SESSION_COLOR_TOKENS.includes(automaticSessionColor(null)));
});

test("the palette the renderer draws is the palette the store accepts", () => {
  // Two copies on purpose (the renderer does not import from the Electron
  // side), so this is the test that keeps them the same list.
  assert.deepEqual(SESSION_COLOR_TOKENS, STORED_COLOR_TOKENS);
});
