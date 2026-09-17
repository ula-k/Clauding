// What a click on the session list means, and what a bulk action would do —
// both as pure functions, so the rules can be read (and tested) without a
// window.
//
// The selection itself is { sessionIds, anchorId }: the rows that are picked
// out, and the row a Shift-click measures its range from. The list has one
// visible order (the rows as they are drawn, groups one after another), and
// that order is handed in: a range is a range of what is on screen, never of
// something folded away in a collapsed group.

// A plain click selects one row and opens its terminal, which is what
// clicking the list has always done. A modifier click only changes the
// selection — it must never spawn a `claude`, because picking five rows out
// would then start five conversations.
//
// `action`:
//   { kind: "single", sessionId }                 a plain click
//   { kind: "toggle", sessionId }                 ⌘-click
//   { kind: "range",  sessionId, orderedIds }     Shift-click
//   { kind: "all",    orderedIds }                ⌘A
//   { kind: "clear" }                             Escape
//
// Returns { sessionIds, anchorId, openSessionId }, where `openSessionId` is
// the session whose terminal the click asks for, or null.
export function selectionPlan(current, action) {
  const selected = Array.isArray(current && current.sessionIds) ? current.sessionIds.slice() : [];
  const anchorId = (current && current.anchorId) || null;
  const kind = action && action.kind;
  const sessionId = (action && action.sessionId) || null;
  const orderedIds = (action && action.orderedIds) || [];

  if (kind === "clear") {
    return { sessionIds: [], anchorId: null, openSessionId: null };
  }

  if (kind === "all") {
    return {
      sessionIds: orderedIds.slice(),
      anchorId: anchorId && orderedIds.includes(anchorId) ? anchorId : orderedIds[0] || null,
      openSessionId: null
    };
  }

  if (!sessionId) {
    return { sessionIds: selected, anchorId, openSessionId: null };
  }

  if (kind === "toggle") {
    const already = selected.includes(sessionId);
    const sessionIds = already ? selected.filter((entry) => entry !== sessionId) : selected.concat([sessionId]);
    // Taking a row out of the selection leaves the anchor on the row that
    // was clicked all the same: a Shift-click after it measures from there,
    // which is what every list does.
    return { sessionIds, anchorId: sessionId, openSessionId: null };
  }

  if (kind === "range") {
    const from = orderedIds.indexOf(anchorId);
    const to = orderedIds.indexOf(sessionId);
    if (to === -1) {
      return { sessionIds: selected, anchorId, openSessionId: null };
    }
    // No anchor yet (the first click of all was a Shift-click): the range is
    // that one row, and it becomes the anchor.
    if (from === -1) {
      return { sessionIds: [sessionId], anchorId: sessionId, openSessionId: null };
    }
    const first = Math.min(from, to);
    const last = Math.max(from, to);
    // A range replaces whatever was picked before, so dragging the Shift
    // key back and forth over the list grows and shrinks one block instead
    // of leaving rows behind.
    return { sessionIds: orderedIds.slice(first, last + 1), anchorId, openSessionId: null };
  }

  return { sessionIds: [sessionId], anchorId: sessionId, openSessionId: sessionId };
}

// The rows of a selection that survive the visible order: the selection is
// kept as the user made it, but the list has moved on (a session was
// deleted, a search narrowed the rows), so anything that is not on screen
// any more is dropped.
export function selectionWithin(sessionIds, orderedIds) {
  const known = new Set(orderedIds || []);
  return (sessionIds || []).filter((sessionId) => known.has(sessionId));
}

// What "Hide 3 sessions" or "Delete 3 sessions…" would really do.
//
// Hiding stops a session of ours and puts it away, and that works on
// anything. Deleting does not: a session running in a terminal or a job
// outside the app is not ours to end, so it is left alone — and named in the
// confirmation, because a silently skipped row looks like a bug.
//
// `sessions` is the rows the list holds; anything the selection names that
// the list does not know is dropped.
export function bulkSessionPlan({ sessionIds, sessions, operation }) {
  const byId = new Map((sessions || []).map((session) => [session.sessionId, session]));
  const affected = [];
  const skipped = [];
  for (const sessionId of sessionIds || []) {
    const session = byId.get(sessionId);
    if (!session) {
      continue;
    }
    const runsElsewhere = Boolean(session.liveStatus && session.liveStatus.source !== "app");
    if (operation === "delete" && runsElsewhere) {
      skipped.push({ sessionId, title: session.title || "" });
      continue;
    }
    affected.push({ sessionId, title: session.title || "" });
  }
  return { affected, skipped, count: affected.length };
}

// The first few titles a confirmation prints, so it says what is about to go
// without turning into a list of forty lines.
export const CONFIRMATION_TITLE_LIMIT = 5;

export function confirmationTitles(affected, limit = CONFIRMATION_TITLE_LIMIT) {
  return (affected || []).slice(0, limit).map((entry) => entry.title);
}
