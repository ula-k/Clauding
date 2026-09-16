// What "Extra claude flags…" actually does, kept apart from the dialog that
// asks and from the App that carries it out — the same shape as
// assignmentPlan.js, for the same reason: the decision is a few lines that
// can be read and tested on their own.
//
// Nothing is written until the user has picked one of the positive choices.
// Cancel, Escape, a click outside the dialog: all of them are CANCEL, and
// CANCEL writes nothing and restarts nothing.

export const SAVE_AND_RESTART = "saveAndRestart";
export const SAVE_ONLY = "saveOnly";
export const CANCEL = "cancel";

// `sessionState` is { hasOpenTerminal }: whether this session is open in one
// of the app's terminals right now. Only such a session can be restarted —
// a session that is merely a row in the list, or one running in a terminal
// outside the app, has nothing to hang up, so the dialog never offers the
// restart and a stray "save and restart" choice degrades to a plain save
// instead of doing something surprising.
export function flagsChangePlan(choice, sessionState) {
  const hasOpenTerminal = Boolean(sessionState && sessionState.hasOpenTerminal);
  if (choice === SAVE_AND_RESTART) {
    return { writeFlags: true, restart: hasOpenTerminal };
  }
  if (choice === SAVE_ONLY) {
    return { writeFlags: true, restart: false };
  }
  return { writeFlags: false, restart: false };
}

// Saved flags that the `claude` on screen does not have yet: the command
// line was composed when that terminal started, so only the next resume the
// app runs for this session will carry them. That is the one case the
// dialog's note is about, and it is also true for a session with no
// terminal of ours at all — there the flags simply wait.
export function flagsApplyOnNextResume(choice, sessionState) {
  const plan = flagsChangePlan(choice, sessionState);
  return plan.writeFlags && !plan.restart;
}
