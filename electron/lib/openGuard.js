// Whether opening a terminal that resumes a session may spawn a `claude`.
//
// Why this exists: after an app restart the same session was resumed twice
// at once — two `claude --resume <id>` in the same minute, each with its own
// prompt file, both writing into one transcript. Nothing between the click
// and the spawn asked whether that conversation already had a process. Now
// every resume goes through this one decision first:
//
//   "show"     one of the app's own terminals already runs it: that terminal
//              is shown instead of a second one being started
//   "restart"  the app's terminal for it is a kept pane whose `claude` ended:
//              that pane is started again (the same as Enter in it)
//   "refuse"   a live `claude` outside the app has it (the CLI's registry
//              says so): nothing is started, the window shows its
//              "running elsewhere" note
//   "spawn"    nobody has it: go ahead
//
// A fork is never refused or redirected — it gets a session id of its own,
// which is the whole point of it. A terminal the app is hanging up on
// purpose (the restart behind "Assign to agent" and "Extra claude flags…")
// does not count as the owner either: its replacement is exactly what is
// being opened.
//
// Pure on purpose: electron/terminals.js hands in its records and the
// registry entries, and test/openGuard.test.js checks the decision.

// `records` are the app's terminal records (terminalId, sessionId, pid,
// exited, closingOnPurpose); `registryEntries` the CLI's
// ~/.claude/sessions/<pid>.json entries as { sessionId, pid, alive }.
export function resumeOpenDecision({ sessionId, forkSession = false, records = [], registryEntries = [] }) {
  if (!sessionId || forkSession) {
    return { action: "spawn" };
  }
  const owner = records.find((record) => record.sessionId === sessionId && !record.closingOnPurpose);
  if (owner) {
    return { action: owner.exited ? "restart" : "show", terminalId: owner.terminalId };
  }
  const ownProcessIds = new Set(records.map((record) => record.pid).filter(Boolean));
  const elsewhere = registryEntries.find(
    (entry) => entry.sessionId === sessionId && entry.alive && !ownProcessIds.has(entry.pid)
  );
  if (elsewhere) {
    return { action: "refuse", reason: "running-elsewhere", pid: elsewhere.pid };
  }
  return { action: "spawn" };
}
