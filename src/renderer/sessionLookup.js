// Opening a session by its id, from wherever the click came: a row in the
// Sessions list, an agent's sub-row in the Agents tab, a search hit, a card
// in a project, the session offered back after a restart.
//
// The window only holds the pages of the list it has loaded, plus the
// sessions linked to an agent and the ones it had to read by id before. A
// click on a session none of those hold used to end in nothing: the click
// looked the row up, did not find it, and quietly gave up — the middle
// column said "Pick a session" as if nothing had been clicked. Now such a
// click asks the main process for that one session and opens it, and when
// even that finds nothing the column says why.
//
// Pure functions: no window, no React, no Electron.

// The first row with this id in any of the lists, or null.
export function findKnownSession(sessionId, lists) {
  if (!sessionId) {
    return null;
  }
  for (const list of lists) {
    const found = (list || []).find((session) => session && session.sessionId === sessionId);
    if (found) {
      return found;
    }
  }
  return null;
}

// Where a click on `sessionId` goes, wherever it came from:
//   { kind: "terminal", terminal }  a terminal of the app already holds it
//   { kind: "known", session }      a loaded row (a page, or read by id before)
//   { kind: "linked", session }     a row the Agents tab read by id
//   { kind: "lookup" }              nothing here holds it: read it by id
// There is no "give up" answer: the last one always asks the main process,
// and only its answer can end in an error the column shows.
export function selectionRoute(sessionId, { terminals = [], loaded = [], linked = [] } = {}) {
  const terminal = terminals.find((record) => record && record.sessionId === sessionId) || null;
  if (terminal) {
    return { kind: "terminal", terminal };
  }
  const known = findKnownSession(sessionId, loaded);
  if (known) {
    return { kind: "known", session: known };
  }
  const linkedRow = findKnownSession(sessionId, [linked]);
  if (linkedRow) {
    return { kind: "linked", session: linkedRow };
  }
  return { kind: "lookup" };
}

// A page of the list added to what is already loaded: a row already there
// stays where it is (the first page carries every pinned session, and the
// same session can come round again on a later page).
export function mergeSessionPages(previous, incoming) {
  const seen = new Set(previous.map((session) => session.sessionId));
  const added = [];
  for (const session of incoming) {
    if (!seen.has(session.sessionId)) {
      seen.add(session.sessionId);
      added.push(session);
    }
  }
  return added.length === 0 ? previous : previous.concat(added);
}

// A row read by id is kept beside the list, newest reading wins.
export function rememberFetchedSession(fetched, session) {
  if (!session || !session.sessionId) {
    return fetched;
  }
  return fetched.filter((known) => known.sessionId !== session.sessionId).concat([session]);
}

// What a click does with a session row it has in hand:
//   "folder"     the folder is unknown or gone: the column asks for one
//   "elsewhere"  it runs in a terminal outside the app: a read-only note
//   "resume"     anything else: `claude --resume` in its folder — which,
//                for a session alive in Claude Code's background daemon
//                (registry kind "bg"), attaches to it (lib/openGuard.js)
export function openPlanForSession(session) {
  if (!session || !session.workingDirectory || session.folderMissing) {
    return "folder";
  }
  if (session.liveStatus && session.liveStatus.source !== "app" && session.liveStatus.kind !== "bg") {
    return "elsewhere";
  }
  return "resume";
}

// The locale key for a lookup that found nothing. `reason` is the word the
// main process answered with (electron/sessions.js, lookupSessionForOpen).
export function lookupFailureKey(reason) {
  if (reason === "not-found") {
    return "middle.sessionNotFound";
  }
  if (reason === "invalid-id") {
    return "middle.sessionInvalidId";
  }
  return "middle.sessionUnreadable";
}

// The first block of an id, enough to tell two sessions apart by eye.
export function shortSessionId(sessionId) {
  return String(sessionId || "").split("-")[0].slice(0, 8);
}

// sessionId -> short id for every session whose title another session also
// carries ("research" twice: one forked from the other keeps its title). The
// rows show it on hover, so two same-named rows can be told apart.
export function collidingTitleSuffixes(sessions) {
  const idsByTitle = new Map();
  for (const session of sessions) {
    const title = String(session.title || "").trim().toLowerCase();
    if (!title) {
      continue;
    }
    if (!idsByTitle.has(title)) {
      idsByTitle.set(title, new Set());
    }
    idsByTitle.get(title).add(session.sessionId);
  }
  const suffixes = new Map();
  for (const ids of idsByTitle.values()) {
    if (ids.size < 2) {
      continue;
    }
    for (const sessionId of ids) {
      suffixes.set(sessionId, shortSessionId(sessionId));
    }
  }
  return suffixes;
}
