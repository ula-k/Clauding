// Searching a conversation's JSONL transcript — the file the CLI writes at
// ~/.claude/projects/<project>/<sessionId>.jsonl, which holds everything the
// terminal ever printed and a good deal it did not.
//
// Pure on purpose: no Electron, no fs. Everything here takes the text of a
// transcript file and answers with plain objects, so test/transcriptSearch.js
// can read a fixture and check the parsing, the matching and the capping
// without a window. Who reads the file, and where it is, is sessions.js.
//
// What a transcript file holds, line by line (one JSON object per line):
//
//   type "user"       what was typed, and every tool_result coming back
//   type "assistant"  the model's text, its thinking, and every tool_use
//   everything else   bookkeeping the CLI keeps for itself — "system",
//                     "file-history-snapshot", "file-history-delta",
//                     "attachment", "queue-operation", "agent-name",
//                     "ai-title", "mode", "permission-mode", "last-prompt",
//                     "cost-state" and friends. None of it is conversation,
//                     so none of it is searched.

// One message can be enormous (a file read, a long tool result). The whole
// text of a hit travels to the window so clicking it can expand it, so it is
// capped — 20 kB is far more than anybody reads and small enough to send.
export const FULL_TEXT_LIMIT = 20 * 1024;

// How much of the message is shown around the first match in the snippet.
export const SNIPPET_MARGIN = 120;

// Roles, as the results view labels them. A tool result came back to the
// user turn but nobody typed it, so it is its own role rather than "user".
export const ROLES = { user: "user", assistant: "assistant", tool: "tool" };

function textOfToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const pieces = [];
  for (const block of content) {
    if (block && typeof block.text === "string") {
      pieces.push(block.text);
    }
  }
  return pieces.join("\n");
}

function stringifyToolInput(input) {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch (error) {
    return String(input);
  }
}

// One line of the file -> the pieces of conversation in it. A message with
// several blocks (rare, but a text block next to an image happens) becomes
// several entries, because each one is found and shown on its own.
function entriesFromLine(line, role) {
  const timestamp = typeof line.timestamp === "string" ? line.timestamp : null;
  const message = line.message || {};
  const content = message.content;

  if (typeof content === "string") {
    return content.trim() ? [{ role, kind: "text", timestamp, text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const entries = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      entries.push({ role, kind: "text", timestamp, text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      entries.push({ role, kind: "thinking", timestamp, text: block.thinking });
    } else if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      entries.push({
        role,
        kind: "tool_use",
        timestamp,
        toolName: name,
        text: `${name}\n${stringifyToolInput(block.input)}`
      });
    } else if (block.type === "tool_result") {
      const resultText = textOfToolResultContent(block.content);
      if (resultText.trim()) {
        entries.push({ role: ROLES.tool, kind: "tool_result", timestamp, text: resultText });
      }
    }
  }
  return entries;
}

// Every searchable piece of one transcript file, in the order it was written.
// `roleLabel` overrides the role on every entry, which is how a subagent's
// file comes back labelled "subagent (Explore)" instead of user/assistant.
export function collectTranscriptEntries(fileText, { roleLabel = null } = {}) {
  const entries = [];
  for (const rawLine of String(fileText || "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    let line;
    try {
      line = JSON.parse(trimmed);
    } catch (error) {
      // A half-written last line while the session is running: skip it.
      continue;
    }
    if (!line || (line.type !== "user" && line.type !== "assistant")) {
      continue;
    }
    if (line.isMeta === true) {
      continue;
    }
    const role = line.type === "user" ? ROLES.user : ROLES.assistant;
    for (const entry of entriesFromLine(line, role)) {
      entries.push(roleLabel ? { ...entry, role: roleLabel } : entry);
    }
  }
  return entries;
}

// Every place the query appears, case-insensitively. Plain text, never a
// regular expression: the user types a word, not a pattern, and a stray "("
// must not throw.
export function findMatches(text, query) {
  const haystack = String(text || "").toLowerCase();
  const needle = String(query || "").toLowerCase();
  if (!needle) {
    return [];
  }
  const matches = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return matches;
    }
    matches.push({ start: at, length: needle.length });
    from = at + needle.length;
  }
}

// The snippet: a window of ±margin characters around the **first** match,
// cut out of the message and handed over already split into the pieces the
// window paints — plain text and matched text alternating, so the renderer
// never has to put markup into a string.
export function buildSnippet(text, matches, margin = SNIPPET_MARGIN) {
  const whole = String(text || "");
  if (matches.length === 0) {
    return { segments: [{ text: whole.slice(0, margin * 2), match: false }], trimmedStart: false, trimmedEnd: whole.length > margin * 2 };
  }
  const first = matches[0];
  const windowStart = Math.max(0, first.start - margin);
  const windowEnd = Math.min(whole.length, first.start + first.length + margin);
  const segments = [];
  let cursor = windowStart;
  for (const match of matches) {
    if (match.start + match.length <= windowStart || match.start >= windowEnd) {
      continue;
    }
    const matchStart = Math.max(windowStart, match.start);
    const matchEnd = Math.min(windowEnd, match.start + match.length);
    if (matchStart > cursor) {
      segments.push({ text: whole.slice(cursor, matchStart), match: false });
    }
    segments.push({ text: whole.slice(matchStart, matchEnd), match: true });
    cursor = matchEnd;
  }
  if (cursor < windowEnd) {
    segments.push({ text: whole.slice(cursor, windowEnd), match: false });
  }
  return { segments, trimmedStart: windowStart > 0, trimmedEnd: windowEnd < whole.length };
}

function cappedText(text) {
  const whole = String(text || "");
  if (whole.length <= FULL_TEXT_LIMIT) {
    return { fullText: whole, truncated: false };
  }
  return { fullText: whole.slice(0, FULL_TEXT_LIMIT), truncated: true };
}

// The entries that contain the query, in transcript order, each one carrying
// what the results view draws: the badge, the time, the marked snippet and
// the whole (capped) message for when it is clicked open.
export function searchEntries(entries, query, { margin = SNIPPET_MARGIN, startIndex = 0 } = {}) {
  const hits = [];
  let totalMatches = 0;
  let index = startIndex;
  for (const entry of entries) {
    const matches = findMatches(entry.text, query);
    if (matches.length === 0) {
      continue;
    }
    totalMatches += matches.length;
    const capped = cappedText(entry.text);
    hits.push({
      index,
      role: entry.role,
      kind: entry.kind,
      toolName: entry.toolName || null,
      timestamp: entry.timestamp || null,
      matchCount: matches.length,
      snippet: buildSnippet(entry.text, matches, margin),
      fullText: capped.fullText,
      fullTextTruncated: capped.truncated
    });
    index += 1;
  }
  return { hits, totalMatches };
}

// The whole answer for one search: the session's own transcript first, then
// each subagent transcript under it, all numbered in one run so the find
// bar's ↑ / ↓ can simply step through `hits`.
//
// `files` is [{ text, roleLabel }] — sessions.js reads them, this decides
// what is in them.
export function searchTranscriptFiles(files, query, { margin = SNIPPET_MARGIN } = {}) {
  const trimmedQuery = String(query || "").trim();
  if (!trimmedQuery) {
    return { query: "", hits: [], totalMatches: 0 };
  }
  const hits = [];
  let totalMatches = 0;
  for (const file of files || []) {
    const entries = collectTranscriptEntries(file.text, { roleLabel: file.roleLabel || null });
    const found = searchEntries(entries, trimmedQuery, { margin, startIndex: hits.length });
    hits.push(...found.hits);
    totalMatches += found.totalMatches;
  }
  return { query: trimmedQuery, hits, totalMatches };
}
