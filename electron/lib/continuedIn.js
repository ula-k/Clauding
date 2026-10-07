// A session that goes on under another id.
//
// Claude Code can send a running session to the background (its own
// feature — `/bg`, ← on an empty prompt, Ctrl+Z or Ctrl+C twice in recent
// CLIs): the conversation is copied into a new session id that runs in the
// CLI's own daemon (registry entry `"kind": "bg"`), the terminal that had it
// becomes a client of that daemon, and the original transcript gets one last
// line:
//
//   {"type":"continued-in","sessionId":"<old>","continuedInSessionId":"<new>"}
//
// From then on everything is written into the new id. The SDK's
// listSessions() leaves the old one out (it is superseded), but every store
// of this app — the agent link, the group, the color, the tags, the flags,
// the panel tabs, the "was open" offer — was keyed by the old id, so the
// conversation vanished from the list while its agent sub-row pointed at a
// stale transcript, and a restart resumed that stale copy.
//
// The rule is the SDK's own: walking back from the end of the transcript, a
// `continued-in` line met before any user or assistant message means the
// session was continued elsewhere. A conversation that went on in the old
// file afterwards (somebody resumed it there) is its own session again.
//
// Pure: callers hand in the end of a transcript and a way to read others.

const CONTINUED_IN_MARKER = '"type":"continued-in"';
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

// The id this transcript tail says the session continued in, or null.
export function continuationFromTail(tailText) {
  const text = String(tailText || "");
  if (!text.includes(CONTINUED_IN_MARKER)) {
    return null;
  }
  const lines = text.split("\n");
  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const line = lines[lineIndex].trim();
    if (!line) {
      continue;
    }
    const isMarker = line.includes(CONTINUED_IN_MARKER);
    const isConversation = line.includes('"type":"user"') || line.includes('"type":"assistant"');
    if (!isMarker && !isConversation) {
      continue;
    }
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      // The first line of a tail is usually cut in half.
      continue;
    }
    if (entry && entry.type === "continued-in") {
      const target = typeof entry.continuedInSessionId === "string" ? entry.continuedInSessionId : "";
      return SESSION_ID_PATTERN.test(target) ? target : null;
    }
    if (entry && (entry.type === "user" || entry.type === "assistant")) {
      return null;
    }
  }
  return null;
}

// The id a session finally lives under, following one continuation after
// another (a session can be sent to the background more than once).
// `readContinuation(id)` answers with the next id or null; a target whose
// transcript does not exist is not followed (`transcriptExists`). Never
// loops, never goes further than `maximumSteps`.
export function followContinuations(sessionId, { readContinuation, transcriptExists = () => true, maximumSteps = 8 }) {
  let current = sessionId;
  const visited = new Set([sessionId]);
  for (let step = 0; step < maximumSteps; step += 1) {
    const next = readContinuation(current);
    if (!next || visited.has(next) || !transcriptExists(next)) {
      break;
    }
    visited.add(next);
    current = next;
  }
  return current;
}

// One keyed store (sessionId -> value) after `fromId` became `toId`: the old
// key's value moves over unless the new id already has one of its own, and
// the old key goes. A fresh object; the input is left alone.
export function carryKeyedValue(mapping, fromId, toId) {
  const source = mapping || {};
  if (!fromId || !toId || fromId === toId || !(fromId in source)) {
    return source;
  }
  const carried = { ...source };
  if (!(toId in carried)) {
    carried[toId] = carried[fromId];
  }
  delete carried[fromId];
  return carried;
}

// A list of ids after `fromId` became `toId`, without duplicates.
export function carryListedId(list, fromId, toId) {
  const source = Array.isArray(list) ? list : [];
  if (!fromId || !toId || fromId === toId || !source.includes(fromId)) {
    return source;
  }
  const carried = [];
  for (const entry of source) {
    const replaced = entry === fromId ? toId : entry;
    if (!carried.includes(replaced)) {
      carried.push(replaced);
    }
  }
  return carried;
}

// Whether the CLI's registry says this session is alive in its background
// daemon. Such a session is not "running elsewhere" in the sense of a second
// writer: `claude --resume <id>` attaches to it.
export function isAliveInBackground(registryEntries, sessionId) {
  return (registryEntries || []).some(
    (entry) => entry && entry.sessionId === sessionId && entry.alive !== false && entry.kind === "bg"
  );
}

// The command line that attaches to a background session. Nothing else rides
// along: the CLI refuses to attach when it is given flags that would change
// the running session (a system prompt, a permission mode, a model, a
// plugin folder…) and prints the attach command instead.
export function attachArguments(sessionId) {
  return ["--resume", sessionId];
}

// The session a terminal shows, from what the registry says about the
// terminal's own pid: the registered id, followed through any continued-in
// chain. `{ sessionId, carryFrom }`: `carryFrom` is the id the terminal was
// tracked under until now when the conversation moved on from it (a plain
// resume of an old id that registered its continuation), so the stores can
// follow; null for a first link or a fork's new id.
export function adoptedSessionId({ trackedSessionId = null, registeredSessionId, isFork = false, resolveContinuation = null }) {
  if (!registeredSessionId) {
    return { sessionId: trackedSessionId, carryFrom: null };
  }
  const resolved = (resolveContinuation ? resolveContinuation(registeredSessionId) : null) || registeredSessionId;
  if (resolved === trackedSessionId) {
    return { sessionId: trackedSessionId, carryFrom: null };
  }
  return { sessionId: resolved, carryFrom: trackedSessionId && !isFork ? trackedSessionId : null };
}
