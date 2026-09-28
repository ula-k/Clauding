// Projects view: the opening of a conversation, for linking a session to a
// ClickUp task when its title and the list's short first prompt say
// nothing. The session list only keeps the first ~200 characters of the
// first prompt; a builder or spec agent usually gets the task link further
// down (after its instructions), so the first few user messages are read
// from the start of the transcript file instead.
//
// Only the head of the file is read (OPENING_BYTES), never the whole
// conversation; the caller remembers the answer per transcript stamp.

export const OPENING_BYTES = 256 * 1024;
export const OPENING_USER_MESSAGES = 3;

function textOfContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

// The JSON lines of a transcript head → the text of its first user
// messages (tool results are not user text and are skipped). A line cut in
// half at the end of the head is ignored.
export function openingTextFromTranscript(headText, { maximumUserMessages = OPENING_USER_MESSAGES } = {}) {
  const parts = [];
  for (const line of String(headText || "").split("\n")) {
    if (parts.length >= maximumUserMessages) {
      break;
    }
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      continue;
    }
    if (entry.type !== "user" || !entry.message) {
      continue;
    }
    const text = textOfContent(entry.message.content).trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}
