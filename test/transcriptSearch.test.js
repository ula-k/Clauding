// CL-20 — "Find in conversation": the transcript JSONL is parsed and
// searched by electron/lib/transcriptSearch.js. Everything here runs against
// a fixture written as a string; no file is read, no window is opened and
// nothing under ~/.claude is touched.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FULL_TEXT_LIMIT,
  SNIPPET_MARGIN,
  buildSnippet,
  collectTranscriptEntries,
  findMatches,
  searchEntries,
  searchTranscriptFiles
} from "../electron/lib/transcriptSearch.js";

function line(object) {
  return JSON.stringify(object);
}

// A transcript with one of everything the parser has to know about, plus the
// bookkeeping lines it has to walk past.
const FIXTURE = [
  line({ type: "user", timestamp: "2026-09-17T10:00:00.000Z", message: { role: "user", content: "Find the lavender button please" } }),
  line({ type: "system", timestamp: "2026-09-17T10:00:01.000Z", subtype: "turn", content: "lavender bookkeeping" }),
  line({ type: "file-history-snapshot", timestamp: "2026-09-17T10:00:02.000Z", snapshot: { text: "lavender" } }),
  line({ type: "attachment", timestamp: "2026-09-17T10:00:03.000Z", attachment: { text: "lavender" } }),
  line({ type: "queue-operation", timestamp: "2026-09-17T10:00:04.000Z", operation: { text: "lavender" } }),
  line({
    type: "assistant",
    timestamp: "2026-09-17T10:00:05.000Z",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "The lavender token is in theme.css" }] }
  }),
  line({
    type: "assistant",
    timestamp: "2026-09-17T10:00:06.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Grep", input: { pattern: "lavender", path: "src/renderer" } }]
    }
  }),
  line({
    type: "user",
    timestamp: "2026-09-17T10:00:07.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: [{ type: "text", text: "theme.css: --accent is lavender" }, { type: "image", source: {} }] }]
    }
  }),
  line({
    type: "user",
    timestamp: "2026-09-17T10:00:08.000Z",
    message: { role: "user", content: [{ type: "tool_result", content: "plain string result, nothing of the sort" }] }
  }),
  line({
    type: "assistant",
    timestamp: "2026-09-17T10:00:09.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Lavender it is — LAVENDER twice, in fact." }] }
  }),
  line({ type: "user", timestamp: "2026-09-17T10:00:10.000Z", isMeta: true, message: { role: "user", content: "lavender meta line" } }),
  "",
  '{"type":"assistant","message":{"content":[{"type":"text","text":"half a lin'
].join("\n");

test("only the conversation is collected — the bookkeeping lines are walked past", () => {
  const entries = collectTranscriptEntries(FIXTURE);
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["text", "thinking", "tool_use", "tool_result", "tool_result", "text"]
  );
  assert.deepEqual(
    entries.map((entry) => entry.role),
    ["user", "assistant", "assistant", "tool", "tool", "assistant"]
  );
});

test("a half-written last line, an empty line and an isMeta line are all skipped", () => {
  const entries = collectTranscriptEntries(FIXTURE);
  assert.equal(entries.some((entry) => entry.text.includes("half a lin")), false);
  assert.equal(entries.some((entry) => entry.text.includes("meta line")), false);
});

test("a tool_use carries its name and its input as JSON", () => {
  const toolUse = collectTranscriptEntries(FIXTURE).find((entry) => entry.kind === "tool_use");
  assert.equal(toolUse.toolName, "Grep");
  assert.match(toolUse.text, /^Grep\n/);
  assert.match(toolUse.text, /"pattern": "lavender"/);
  assert.match(toolUse.text, /"path": "src\/renderer"/);
});

test("a tool_result reads both shapes: a plain string and a list of text blocks", () => {
  const results = collectTranscriptEntries(FIXTURE).filter((entry) => entry.kind === "tool_result");
  assert.equal(results[0].text, "theme.css: --accent is lavender");
  assert.equal(results[1].text, "plain string result, nothing of the sort");
});

test("the timestamp of each line comes along", () => {
  const entries = collectTranscriptEntries(FIXTURE);
  assert.equal(entries[0].timestamp, "2026-09-17T10:00:00.000Z");
  assert.equal(entries.at(-1).timestamp, "2026-09-17T10:00:09.000Z");
});

test("matching is case-insensitive and finds every occurrence in one message", () => {
  assert.deepEqual(findMatches("Lavender and lavender and LAVENDER", "lavender"), [
    { start: 0, length: 8 },
    { start: 13, length: 8 },
    { start: 26, length: 8 }
  ]);
  assert.deepEqual(findMatches("nothing here", "lavender"), []);
  assert.deepEqual(findMatches("anything", ""), []);
});

test("a query full of regular-expression punctuation is still plain text", () => {
  assert.deepEqual(findMatches("a (b) c", "(b)"), [{ start: 2, length: 3 }]);
  assert.deepEqual(findMatches("cost was $5.00", "$5.00"), [{ start: 9, length: 5 }]);
  assert.deepEqual(findMatches("nothing", "a.c"), []);
});

test("the snippet is a window around the first match, and says it was cut", () => {
  const filler = "x".repeat(400);
  const snippet = buildSnippet(`${filler}lavender${filler}`, findMatches(`${filler}lavender${filler}`, "lavender"), 10);
  assert.equal(snippet.trimmedStart, true);
  assert.equal(snippet.trimmedEnd, true);
  assert.deepEqual(snippet.segments, [
    { text: "xxxxxxxxxx", match: false },
    { text: "lavender", match: true },
    { text: "xxxxxxxxxx", match: false }
  ]);
});

test("a short message is not cut at either end", () => {
  const snippet = buildSnippet("say lavender", findMatches("say lavender", "lavender"), SNIPPET_MARGIN);
  assert.equal(snippet.trimmedStart, false);
  assert.equal(snippet.trimmedEnd, false);
  assert.equal(snippet.segments.map((piece) => piece.text).join(""), "say lavender");
});

test("every match inside the window is marked, not only the first", () => {
  const text = "lavender then lavender again";
  const snippet = buildSnippet(text, findMatches(text, "lavender"), SNIPPET_MARGIN);
  assert.deepEqual(
    snippet.segments.filter((piece) => piece.match).map((piece) => piece.text),
    ["lavender", "lavender"]
  );
});

test("a match far outside the window is counted but not drawn in the snippet", () => {
  const text = `lavender${"y".repeat(500)}lavender`;
  const snippet = buildSnippet(text, findMatches(text, "lavender"), 20);
  assert.equal(snippet.segments.filter((piece) => piece.match).length, 1);
});

test("the whole text of a hit is capped", () => {
  const huge = `${"z".repeat(FULL_TEXT_LIMIT * 2)}lavender`;
  const found = searchEntries([{ role: "user", kind: "text", timestamp: null, text: huge }], "lavender");
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].fullText.length, FULL_TEXT_LIMIT);
  assert.equal(found.hits[0].fullTextTruncated, true);
});

test("a message that fits is not marked as truncated", () => {
  const found = searchEntries([{ role: "user", kind: "text", timestamp: null, text: "lavender" }], "lavender");
  assert.equal(found.hits[0].fullTextTruncated, false);
  assert.equal(found.hits[0].fullText, "lavender");
});

test("a whole search over one file: the hits are in transcript order and numbered", () => {
  const found = searchTranscriptFiles([{ text: FIXTURE, roleLabel: null }], "lavender");
  assert.equal(found.query, "lavender");
  assert.deepEqual(
    found.hits.map((hit) => hit.kind),
    ["text", "thinking", "tool_use", "tool_result", "text"]
  );
  assert.deepEqual(
    found.hits.map((hit) => hit.index),
    [0, 1, 2, 3, 4]
  );
  assert.equal(found.hits.at(-1).matchCount, 2, "both Lavender and LAVENDER in the last message");
  assert.equal(found.totalMatches, 6);
});

test("an empty query finds nothing at all", () => {
  const found = searchTranscriptFiles([{ text: FIXTURE, roleLabel: null }], "   ");
  assert.deepEqual(found.hits, []);
  assert.equal(found.totalMatches, 0);
});

test("a subagent transcript is searched too, and labelled as one", () => {
  const subagent = line({
    type: "assistant",
    timestamp: "2026-09-17T10:05:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "the lavender token lives in theme.css" }] }
  });
  const found = searchTranscriptFiles(
    [
      { text: FIXTURE, roleLabel: null },
      { text: subagent, roleLabel: "subagent (Explore)" }
    ],
    "lavender"
  );
  assert.equal(found.hits.at(-1).role, "subagent (Explore)");
  assert.equal(found.hits.at(-1).index, found.hits.length - 1, "the numbering runs on across files");
});

test("a query that is nowhere in the transcript answers with no hits, not an error", () => {
  const found = searchTranscriptFiles([{ text: FIXTURE, roleLabel: null }], "chartreuse");
  assert.deepEqual(found.hits, []);
  assert.equal(found.totalMatches, 0);
});
