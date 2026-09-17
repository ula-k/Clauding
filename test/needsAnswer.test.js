// CL-23 — when a session says NEEDS ANSWER (electron/lib/needsAnswer.js).
//
// A background job says it is blocked and that is that; an ordinary
// interactive session cannot, so the end of its transcript decides. Every
// test here hands the module a piece of JSONL as a string: no files, no
// Electron, no `claude`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPLICIT_ASK_PHRASES,
  NEEDS_ANSWER_MAX_AGE_MILLISECONDS,
  createNeedsAnswerCache,
  isRecentEnoughToAsk,
  lastAssistantTurn,
  needsAnswerFromTail,
  parseTranscriptTail,
  textAsksSomething
} from "../electron/lib/needsAnswer.js";

function assistantLine(text) {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function assistantToolUse(name = "Bash") {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input: { command: "ls" } }] }
  });
}

function toolResultLine(text = "ok") {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: text }] }
  });
}

function userLine(text) {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

test("a tail that starts mid-line is read from the first whole line", () => {
  const tail = ['ge": {"content": "cut in half"}}', assistantLine("Finished."), ""].join("\n");
  const entries = parseTranscriptTail(tail);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "assistant");
});

test("a question at the end of the last message needs an answer", () => {
  const tail = [userLine("do it"), assistantLine("I can do it two ways.\n\nWhich one do you want?")].join("\n");
  assert.equal(needsAnswerFromTail(tail), true);
});

test("a question mark inside closing punctuation still counts", () => {
  assert.equal(textAsksSomething("**Shall I push it?**"), true);
  assert.equal(textAsksSomething("Ready. (Should I?)"), true);
});

test("a needs input: line needs an answer wherever it sits", () => {
  const tail = assistantLine("NEEDS INPUT: which staging database should this run against\n\nThe rest is done.");
  assert.equal(needsAnswerFromTail(tail), true);
});

test("needs input near the end of the message counts too", () => {
  const long = `${"Work done. ".repeat(80)}\nStill needs input from you before the next step.`;
  assert.equal(needsAnswerFromTail(assistantLine(long)), true);
});

test("needs input far above the end of a long message does not", () => {
  const long = `It needs input files in place.\n${"Then everything else was done. ".repeat(40)}\nAll finished.`;
  assert.equal(needsAnswerFromTail(assistantLine(long)), false);
});

test("an explicit ask needs an answer, in either language", () => {
  assert.equal(needsAnswerFromTail(assistantLine("Czekam na Twoją decyzję.")), true);
  assert.equal(needsAnswerFromTail(assistantLine("I'll hold here, waiting for your go-ahead.")), true);
  assert.equal(needsAnswerFromTail(assistantLine("Ready when you are — say the word.")), true);
  assert.ok(EXPLICIT_ASK_PHRASES.length <= 8, "the phrase list stays short");
});

test("a plain statement does not need an answer", () => {
  const tail = [userLine("run the tests"), assistantLine("All 312 tests pass and the build is green.")].join("\n");
  assert.equal(needsAnswerFromTail(tail), false);
});

test("a tool call nobody answered is a pending permission prompt", () => {
  const tail = [userLine("list the folder"), assistantLine("Listing it."), assistantToolUse()].join("\n");
  assert.equal(needsAnswerFromTail(tail), true);
});

test("a tool call that came back is not", () => {
  const tail = [userLine("list the folder"), assistantToolUse(), toolResultLine("two files")].join("\n");
  assert.equal(needsAnswerFromTail(tail), false);
});

test("a tool call answered and followed by a plain report is not", () => {
  const tail = [assistantToolUse(), toolResultLine(), assistantLine("Two files, both empty.")].join("\n");
  assert.equal(needsAnswerFromTail(tail), false);
});

test("a busy session never needs an answer, whatever it last said", () => {
  assert.equal(needsAnswerFromTail(assistantLine("Which one do you want?"), { busy: true }), false);
});

test("a transcript with nothing from the assistant in its tail needs nothing", () => {
  assert.equal(needsAnswerFromTail([userLine("hello"), userLine("still there?")].join("\n")), false);
  assert.equal(needsAnswerFromTail(""), false);
});

test("bookkeeping lines are skipped, the last real message decides", () => {
  const tail = [
    assistantLine("Which branch should it go on?"),
    JSON.stringify({ type: "assistant", isMeta: true, message: { content: [{ type: "text", text: "ignored" }] } }),
    JSON.stringify({ type: "ai-title", title: "Something" }),
    JSON.stringify({ type: "file-history-snapshot" })
  ].join("\n");
  assert.equal(needsAnswerFromTail(tail), true);
});

test("the last assistant turn is the one that counts, not an earlier question", () => {
  const tail = [
    assistantLine("Shall I delete it?"),
    userLine("yes"),
    assistantLine("Deleted. Nothing else to do here.")
  ].join("\n");
  const turn = lastAssistantTurn(parseTranscriptTail(tail));
  assert.equal(turn.text, "Deleted. Nothing else to do here.");
  assert.equal(needsAnswerFromTail(tail), false);
});

test("the answer is worked out once per transcript state", () => {
  let reads = 0;
  const cache = createNeedsAnswerCache({
    readTail: () => {
      reads += 1;
      return assistantLine("Which one do you want?");
    }
  });
  const shape = { filePath: "/transcripts/one.jsonl", stamp: "100:20" };
  assert.equal(cache.lookup("one", shape), true);
  assert.equal(cache.lookup("one", shape), true);
  assert.equal(reads, 1, "the same file state is not read twice");

  // The session wrote something: the answer is worked out again.
  assert.equal(cache.lookup("one", { ...shape, stamp: "200:40" }), true);
  assert.equal(reads, 2);
});

test("a busy session is answered without reading anything, and forgotten", () => {
  let reads = 0;
  const cache = createNeedsAnswerCache({
    readTail: () => {
      reads += 1;
      return assistantLine("Which one?");
    }
  });
  const shape = { filePath: "/transcripts/one.jsonl", stamp: "100:20" };
  assert.equal(cache.lookup("one", shape), true);
  assert.equal(cache.lookup("one", { ...shape, busy: true }), false);
  assert.equal(cache.count(), 0, "the old answer is dropped when the session goes busy");
  assert.equal(reads, 1);
});

test("a session with no transcript yet is answered without reading anything", () => {
  let reads = 0;
  const cache = createNeedsAnswerCache({
    readTail: () => {
      reads += 1;
      return "";
    }
  });
  assert.equal(cache.lookup("one", { filePath: null, stamp: null }), false);
  assert.equal(reads, 0);
});

test("forgetting a session drops its answer", () => {
  const cache = createNeedsAnswerCache({ readTail: () => assistantLine("Which one?") });
  cache.lookup("one", { filePath: "/one.jsonl", stamp: "1:1" });
  assert.equal(cache.count(), 1);
  cache.forget("one");
  assert.equal(cache.count(), 0);
});

// ---- how old a conversation may be ---------------------------------------
//
// The badge does not need a live process: an app restart kills every
// terminal and the question in the transcript is no less unanswered for it.
// What does count is age — three days, so an old conversation that happened
// to end with a question mark does not light the list up for ever.

test("a transcript touched moments ago is asked the question", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  assert.equal(isRecentEnoughToAsk(now - 60 * 1000, now), true);
  assert.equal(isRecentEnoughToAsk(now - NEEDS_ANSWER_MAX_AGE_MILLISECONDS + 1000, now), true);
});

test("a transcript older than three days is never flagged", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  assert.equal(isRecentEnoughToAsk(now - NEEDS_ANSWER_MAX_AGE_MILLISECONDS - 1000, now), false);
  assert.equal(isRecentEnoughToAsk(now - 30 * 24 * 60 * 60 * 1000, now), false);
});

test("a missing or nonsensical modification time is not recent", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  assert.equal(isRecentEnoughToAsk(null, now), false);
  assert.equal(isRecentEnoughToAsk(0, now), false);
  assert.equal(isRecentEnoughToAsk("not a time", now), false);
});

test("a time in the future (a clock that jumped) still counts as recent", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  assert.equal(isRecentEnoughToAsk(now + 60 * 60 * 1000, now), true);
});

test("the tail decides on its own, with no process anywhere in it", () => {
  // The same transcript, read after the session that wrote it is long gone:
  // the question is still the last thing said, so the answer is still yes.
  const tail = [assistantLine("Shall I delete the old branch?")].join("\n");
  assert.equal(needsAnswerFromTail(tail), true);
  assert.equal(needsAnswerFromTail(tail, { busy: true }), false, "a busy session is still writing");
});
