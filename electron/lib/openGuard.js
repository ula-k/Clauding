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
//   "attach"   the live process is the CLI's own background daemon
//              (registry `"kind": "bg"`): a plain `claude --resume <id>`
//              attaches to it instead of starting a second writer, so that
//              is what is started (lib/continuedIn.js)
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
// ~/.claude/sessions/<pid>.json entries as { sessionId, pid, alive, kind }.
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
  if (elsewhere && elsewhere.kind === "bg") {
    return { action: "attach", pid: elsewhere.pid };
  }
  if (elsewhere) {
    return { action: "refuse", reason: "running-elsewhere", pid: elsewhere.pid };
  }
  return { action: "spawn" };
}

// One conversation can carry several ids: Claude Code sends a session to the
// background under a new id, and `claude --resume <old>` then runs and
// registers the new one (lib/continuedIn.js). The guard compares
// conversations, not spellings: every terminal record and registry entry
// whose id — or, for a terminal that was a plain resume, the id it was
// started with — leads through that chain to `sessionId` counts as having
// it. Without this, four `claude --resume <old>` were started for one
// conversation: each registered the new id, so none of them ever matched.
export function conversationGuardInput({ sessionId, forkSession = false, records = [], registryEntries = [], resolveContinuation = null }) {
  if (!sessionId || forkSession) {
    return { sessionId, forkSession, records, registryEntries: [] };
  }
  const resolved = (candidate) => (resolveContinuation && candidate ? resolveContinuation(candidate) || candidate : candidate);
  const sameConversation = (candidate) => Boolean(candidate) && (candidate === sessionId || resolved(candidate) === sessionId);
  const matchedRecords = records.map((record) => {
    const startedAsResume = !record.forkedFromSessionId && sameConversation(record.resumeSessionId);
    return sameConversation(record.sessionId) || startedAsResume ? { ...record, sessionId } : record;
  });
  const matchedEntries = registryEntries
    .filter((entry) => entry && sameConversation(entry.sessionId))
    .map((entry) => ({ ...entry, sessionId }));
  return { sessionId, forkSession, records: matchedRecords, registryEntries: matchedEntries };
}
