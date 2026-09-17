// What happens to a terminal whose `claude` ended: keep the pane with the
// CLI's own last words, or forget the terminal (electron/lib/exitPlan.js).
// Nothing is spawned; only the decision is checked.
import test from "node:test";
import assert from "node:assert/strict";
import { EARLY_EXIT_MILLISECONDS, exitNoticeText, exitPlan } from "../electron/lib/exitPlan.js";

test("a flag the CLI refuses keeps its pane", () => {
  // What `--channels plugin:telegram` (untagged) really does: one line of
  // explanation and exit 1, a second in. The pane used to vanish with it,
  // which is why "the session does not open" was all the user ever saw.
  const plan = exitPlan({ code: 1, uptimeMs: 700, hadPrompt: false });
  assert.equal(plan.keep, true);
  assert.match(plan.reason, /exit code/);
});

test("any non-zero exit keeps the pane, however long the session ran", () => {
  const plan = exitPlan({ code: 137, uptimeMs: 4 * 60 * 60 * 1000, hadPrompt: true });
  assert.equal(plan.keep, true);
});

test("a success in the opening seconds keeps the pane too", () => {
  const plan = exitPlan({ code: 0, uptimeMs: EARLY_EXIT_MILLISECONDS - 1, hadPrompt: false });
  assert.equal(plan.keep, true);
  assert.match(plan.reason, /first seconds/);
});

test("a success that never reached the prompt keeps the pane", () => {
  const plan = exitPlan({ code: 0, uptimeMs: 30000, hadPrompt: false });
  assert.equal(plan.keep, true);
  assert.match(plan.reason, /prompt/);
});

test("a clean /exit is the one case that removes the terminal", () => {
  const plan = exitPlan({ code: 0, uptimeMs: 30000, hadPrompt: true });
  assert.equal(plan.keep, false);
  assert.match(plan.reason, /clean/);
});

test("an exit code nobody reported is treated as a failure", () => {
  assert.equal(exitPlan({ code: null, uptimeMs: 30000, hadPrompt: true }).keep, true);
  assert.equal(exitPlan({}).keep, true);
  assert.equal(exitPlan().keep, true);
});

test("the note under a kept pane says the code and how to start again", () => {
  const notice = exitNoticeText(1);
  assert.match(notice, /claude exited with code 1/);
  assert.match(notice, /Press Enter to start again/);
  // Dim, so it reads as a note rather than as more CLI output.
  assert.ok(notice.includes("[2;37m"));
});
