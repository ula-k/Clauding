// What to do with a terminal whose `claude` has ended: keep the pane with
// everything the CLI printed, or forget the terminal the way the app always
// did.
//
// Why this exists: a flag the CLI does not accept makes it print one line and
// exit inside a second. The record used to be deleted the moment that
// happened, which took the pane and the row with it — so a rejected flag
// looked exactly like "the new session does not open", with the CLI's own
// explanation ("--channels entries must be tagged: plugin:telegram") on
// screen for a few frames at most. Keeping the pane turns that into an error
// the user can read and a terminal they can start again.
//
// Pure on purpose: electron/terminals.js hands in the numbers and the dry
// test (test/exitPlan.test.js) checks the decision without a pty.

// Under this, an exit is "it ended in the first seconds": the CLI never got
// far enough for the user to have asked for it.
export const EARLY_EXIT_MILLISECONDS = 5000;

// `code` is the process exit code, `uptimeMs` how long the pty lived, and
// `hadPrompt` whether the CLI ever reached its prompt (its registry entry
// said "idle" at least once, so at least one turn was possible).
//
// Everything is kept except a clean goodbye: exit code 0, after the CLI had
// been at its prompt, and not in the opening seconds. That is `/exit` and
// nothing else.
export function exitPlan({ code = null, uptimeMs = 0, hadPrompt = false } = {}) {
  // `null` is not a quiet zero here: a pty that never reported a code is a
  // failure, not a goodbye. (Number(null) is 0, which is why this is spelled
  // out rather than left to Number.isFinite.)
  const reported = code === null || code === undefined || code === "" ? null : Number(code);
  const exitCode = Number.isFinite(reported) ? reported : null;
  const lifetime = Number.isFinite(Number(uptimeMs)) ? Number(uptimeMs) : 0;
  if (exitCode !== 0) {
    return { keep: true, reason: "the exit code is not zero" };
  }
  if (lifetime < EARLY_EXIT_MILLISECONDS) {
    return { keep: true, reason: "it ended in the first seconds" };
  }
  if (!hadPrompt) {
    return { keep: true, reason: "it never reached its prompt" };
  }
  return { keep: false, reason: "a clean exit" };
}

// The dim lines appended under whatever the CLI left on screen. Written by
// the main process straight into the terminal's output, so they sit with the
// CLI's own last words instead of in a box of their own — which is also why
// they are in English like everything else the main process prints.
// 2;37m is the terminal's "dim, white" so the two lines read as a note
// rather than as more CLI output.
export function exitNoticeText(exitCode) {
  const dim = "[2;37m";
  const plain = "[0m";
  const code = Number.isFinite(Number(exitCode)) ? Number(exitCode) : "unknown";
  return `\r\n${dim}claude exited with code ${code}${plain}\r\n${dim}Press Enter to start again${plain}\r\n`;
}
