// CL-19 — "Assign to agent" decides nothing until the dialog is answered
// (src/renderer/assignmentPlan.js). A dry test: no window, no IPC, no
// agents.json — only the mapping from the button that was pressed to the
// two things that may happen (write the link, restart the terminal).
import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGN_AND_RESTART,
  ASSIGN_ONLY,
  CANCEL,
  REMOVE_ASSIGNMENT,
  assignmentPlan,
  definitionLoadsOnNextResume
} from "../src/renderer/assignmentPlan.js";

const OPEN_IN_TERMINAL = { hasOpenTerminal: true };
const NOT_OPEN = { hasOpenTerminal: false };

test("Cancel writes nothing and restarts nothing — the bug this test is here for", () => {
  assert.deepEqual(assignmentPlan(CANCEL, OPEN_IN_TERMINAL), { writeLink: false, restart: false });
  assert.deepEqual(assignmentPlan(CANCEL, NOT_OPEN), { writeLink: false, restart: false });
});

test("Escape, a click outside, an unknown answer: all of them are Cancel", () => {
  for (const choice of [null, undefined, "", "somethingElse"]) {
    assert.deepEqual(assignmentPlan(choice, OPEN_IN_TERMINAL), { writeLink: false, restart: false });
  }
});

test("Assign only writes the link and leaves the terminal alone", () => {
  assert.deepEqual(assignmentPlan(ASSIGN_ONLY, OPEN_IN_TERMINAL), { writeLink: true, restart: false });
  assert.deepEqual(assignmentPlan(ASSIGN_ONLY, NOT_OPEN), { writeLink: true, restart: false });
});

test("Assign and restart writes the link and restarts the open terminal", () => {
  assert.deepEqual(assignmentPlan(ASSIGN_AND_RESTART, OPEN_IN_TERMINAL), { writeLink: true, restart: true });
});

test("there is nothing to restart when the session is not open in a terminal", () => {
  assert.deepEqual(assignmentPlan(ASSIGN_AND_RESTART, NOT_OPEN), { writeLink: true, restart: false });
});

test("a missing session state is read as 'not open in a terminal'", () => {
  assert.deepEqual(assignmentPlan(ASSIGN_AND_RESTART, undefined), { writeLink: true, restart: false });
  assert.deepEqual(assignmentPlan(ASSIGN_ONLY, null), { writeLink: true, restart: false });
});

test("removing an assignment writes the change and never restarts anything", () => {
  assert.deepEqual(assignmentPlan(REMOVE_ASSIGNMENT, OPEN_IN_TERMINAL), { writeLink: true, restart: false });
  assert.deepEqual(assignmentPlan(REMOVE_ASSIGNMENT, NOT_OPEN), { writeLink: true, restart: false });
});

test("only 'Assign only' on a running terminal earns the 'loads on next resume' hint", () => {
  assert.equal(definitionLoadsOnNextResume(ASSIGN_ONLY, OPEN_IN_TERMINAL), true);
  assert.equal(definitionLoadsOnNextResume(ASSIGN_ONLY, NOT_OPEN), false);
  assert.equal(definitionLoadsOnNextResume(ASSIGN_AND_RESTART, OPEN_IN_TERMINAL), false);
  assert.equal(definitionLoadsOnNextResume(REMOVE_ASSIGNMENT, OPEN_IN_TERMINAL), false);
  assert.equal(definitionLoadsOnNextResume(CANCEL, OPEN_IN_TERMINAL), false);
});

test("a plan is a fresh object every time, so a caller cannot spoil the next one", () => {
  const first = assignmentPlan(ASSIGN_ONLY, OPEN_IN_TERMINAL);
  first.restart = true;
  assert.deepEqual(assignmentPlan(ASSIGN_ONLY, OPEN_IN_TERMINAL), { writeLink: true, restart: false });
});
