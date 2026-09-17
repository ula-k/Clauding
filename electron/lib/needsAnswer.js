// When does a session actually need an answer?
//
// A background job says so itself (`state: "blocked"`), but an ordinary
// interactive session does not: the CLI's registry entry only ever says
// `busy` or `idle`, and a session that has just asked a question sits there
// looking exactly like one that finished half an hour ago. That is the gap
// this closes — the row for a session that asked something gets the same
// **needs answer** badge a blocked job gets.
//
// The only thing that knows is the conversation itself, so the **tail** of
// the transcript is read (the last ~64 kB of
// ~/.claude/projects/<folder>/<sessionId>.jsonl, never the whole file) and
// the last thing the assistant said decides:
//
//   1. the assistant's last content block is a `tool_use` and no
//      `tool_result` came after it — the CLI is holding a permission
//      prompt, which is the most literal "needs you" there is;
//   2. the last message has a line that starts with `needs input:`, or says
//      "needs input" near its end — the convention the agents here follow;
//   3. its last non-empty line ends with a question mark;
//   4. it contains one of a short list of explicit asks ("waiting for
//      your…", "czekam na Twoją decyzję"…).
//
// A **busy** session never needs an answer: it is still writing, and
// whatever it said a minute ago is not a question yet.
//
// Everything here is pure: text in, a boolean out. The file reading, the
// cache stamp and the wiring live in electron/sessions.js.

// How much of the end of the transcript is read. A single message is rarely
// more than a few kB, so this holds the last several of them — and a
// half-written first line is simply dropped when it does not parse.
export const TAIL_BYTES = 64 * 1024;

// How far back from the end of a message "needs input" still counts as the
// session asking for something, rather than a word in the middle of a long
// explanation.
export const NEEDS_INPUT_WINDOW = 300;

// The short list, deliberately short: phrases that are an ask and nothing
// else, in the two languages this app is used in. Matching is
// case-insensitive.
export const EXPLICIT_ASK_PHRASES = [
  "czekam na twoją decyzję",
  "czekam na twoją odpowiedź",
  "waiting for your",
  "say the word",
  "daj znać, czy",
  "powiedz, czy"
];

// Every JSONL line that parses, in order. A tail begins in the middle of a
// line and a session may be writing the last one at this very moment, so a
// line that does not parse is skipped rather than being an error.
export function parseTranscriptTail(tailText) {
  const entries = [];
  for (const line of String(tailText || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed));
    } catch (error) {
      // A half-written line, or the cut at the start of the tail.
    }
  }
  return entries;
}

function contentBlocksOf(entry) {
  const message = entry && entry.message;
  if (!message) {
    return [];
  }
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  return Array.isArray(message.content) ? message.content : [];
}

function textOf(blocks) {
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function hasToolResult(blocks) {
  return blocks.some((block) => block && block.type === "tool_result");
}

// The last assistant message that actually said or did something, and
// whether a tool result came in after it.
export function lastAssistantTurn(entries) {
  let turn = null;
  let resultAfterwards = false;
  for (const entry of entries) {
    if (!entry || entry.isMeta) {
      continue;
    }
    const blocks = contentBlocksOf(entry);
    if (entry.type === "assistant") {
      const text = textOf(blocks);
      const endsWithToolUse = blocks.length > 0 && blocks[blocks.length - 1].type === "tool_use";
      if (!text && !endsWithToolUse) {
        continue;
      }
      turn = { text, endsWithToolUse };
      resultAfterwards = false;
      continue;
    }
    if (entry.type === "user" && turn && hasToolResult(blocks)) {
      resultAfterwards = true;
    }
  }
  return turn ? { ...turn, resultAfterwards } : null;
}

// Does this piece of text read as a question to the user?
export function textAsksSomething(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return false;
  }
  const lowerCase = text.toLowerCase();
  for (const line of lowerCase.split("\n")) {
    if (line.trim().startsWith("needs input:")) {
      return true;
    }
  }
  if (lowerCase.slice(-NEEDS_INPUT_WINDOW).includes("needs input")) {
    return true;
  }
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  // A question mark at the very end, with nothing but closing punctuation
  // after it ("…, czy tak?**").
  if (/\?[)\]*_"'`»”]*$/.test(lastLine)) {
    return true;
  }
  return EXPLICIT_ASK_PHRASES.some((phrase) => lowerCase.includes(phrase));
}

// The whole decision for one session, from the tail of its transcript.
// `busy` short-circuits it: a session that is still writing is not waiting
// for anybody.
export function needsAnswerFromTail(tailText, { busy = false } = {}) {
  if (busy) {
    return false;
  }
  const turn = lastAssistantTurn(parseTranscriptTail(tailText));
  if (!turn) {
    return false;
  }
  // A tool call nobody answered: the CLI is sitting on a permission prompt.
  if (turn.endsWithToolUse && !turn.resultAfterwards) {
    return true;
  }
  return textAsksSomething(turn.text);
}

// The answer is only worth working out again when the transcript has
// actually grown, so each session's answer is kept under a stamp of the
// file's size and modification time. `readTail` is handed in (it is the one
// impure part), which is also what lets the tests drive this with strings.
export function createNeedsAnswerCache({ readTail }) {
  const answers = new Map();

  return {
    // `stamp` is whatever identifies the state of the file — sessions.js
    // uses "<mtimeMs>:<size>". A session with no transcript yet, or with no
    // stamp, is answered `false` without reading anything.
    lookup(sessionId, { filePath = null, stamp = null, busy = false } = {}) {
      if (busy) {
        answers.delete(sessionId);
        return false;
      }
      if (!sessionId || !filePath || !stamp) {
        return false;
      }
      const remembered = answers.get(sessionId);
      if (remembered && remembered.stamp === stamp) {
        return remembered.value;
      }
      const value = needsAnswerFromTail(readTail(filePath), { busy: false });
      answers.set(sessionId, { stamp, value });
      return value;
    },
    forget(sessionId) {
      answers.delete(sessionId);
    },
    count() {
      return answers.size;
    }
  };
}
