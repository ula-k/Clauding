// What "Assign to agent" actually does, kept apart from the dialog that asks
// and from the App that carries it out — so the one thing that used to be
// wrong (the link was written *before* the question, and Cancel only skipped
// the restart) is a few lines that can be read and tested on their own.
//
// Nothing is written until the user has picked one of the positive choices.
// Cancel, Escape, a click outside the dialog: all of them are CANCEL, and
// CANCEL writes nothing and restarts nothing.

export const ASSIGN_AND_RESTART = "assignAndRestart";
export const ASSIGN_ONLY = "assignOnly";
export const REMOVE_ASSIGNMENT = "removeAssignment";
export const CANCEL = "cancel";

// `sessionState` is { hasOpenTerminal }: whether this session is open in one
// of the app's terminals right now. Only such a session can be restarted —
// a session that is merely a row in the list has nothing to hang up, so the
// dialog never offers the restart and a stray "assign and restart" choice
// degrades to the plain assignment instead of doing something surprising.
export function assignmentPlan(choice, sessionState) {
  const hasOpenTerminal = Boolean(sessionState && sessionState.hasOpenTerminal);
  if (choice === ASSIGN_AND_RESTART) {
    return { writeLink: true, restart: hasOpenTerminal };
  }
  if (choice === ASSIGN_ONLY || choice === REMOVE_ASSIGNMENT) {
    return { writeLink: true, restart: false };
  }
  return { writeLink: false, restart: false };
}

// "Assign only" on a session that is open in a terminal leaves that terminal
// running with the system prompt it started with: the definition is in
// agents.json, but the conversation on screen does not follow it yet. That
// is what the small hint next to the header chip says, and this is the one
// case that earns it.
export function definitionLoadsOnNextResume(choice, sessionState) {
  const plan = assignmentPlan(choice, sessionState);
  if (choice === REMOVE_ASSIGNMENT || !plan.writeLink || plan.restart) {
    return false;
  }
  return Boolean(sessionState && sessionState.hasOpenTerminal);
}
