// The first user message a terminal types for itself.
//
// "Harvest skills" and "Create agent from this conversation" fork the
// conversation and put the job into the fork's *system* prompt — but a
// system prompt never starts a turn: the CLI comes up at an empty prompt and
// waits for the user, so the fork looked as if it did nothing at all. The
// app therefore types the job in as the first message, exactly the way the
// smoke runs type theirs.
//
// Two rules make that safe, and both live here so the smoke runs and the app
// agree on them:
//
//   * the pty is only written to once the CLI is really at its prompt — the
//     session is registered, the registry says "idle", and nothing that
//     wants an answer of its own (the trust dialog, a permission question)
//     is on screen. Such a dialog is waited out, never answered;
//   * a long chunk counts as a *paste* for the CLI, and an Enter inside a
//     paste is only a newline, so the text and the Enter go separately.
//
// What the message says is decided in the renderer (src/renderer/metaPrompts.js).

// How long the app waits for the prompt before giving up and leaving the
// terminal alone (the header then asks the user to type something).
export const KICKOFF_TIMEOUT_MILLISECONDS = 60000;
export const KICKOFF_POLL_MILLISECONDS = 500;
// The prompt is drawn a moment before the CLI is really listening.
export const KICKOFF_SETTLE_MILLISECONDS = 1500;
// Between the pasted text and the Enter that sends it.
export const KICKOFF_ENTER_DELAY_MILLISECONDS = 600;
// How much of the recent output is searched for a dialog. Only the freshest
// part: a dialog that is up is redrawn constantly, while a resumed fork
// prints the whole inherited conversation into the same buffer, and a line
// of *that* must not be mistaken for a question on screen.
export const KICKOFF_OUTPUT_CHARACTERS = 2000;

// Everything the CLI can put on screen that is waiting for an answer of its
// own. Typing a message into one of these would answer it by accident.
const DIALOG_PHRASES = [
  "trust this folder",
  "do you trust",
  "do you want to proceed",
  "do you want to continue",
  "select login method",
  "press enter to continue"
];

// Is this pty input something a person typed? Not everything the renderer
// sends is typing: xterm.js answers the CLI's own queries (cursor position,
// device attributes, bracketed-paste and focus reports) through exactly the
// same channel, and a fresh terminal always exchanges a few of those. Those
// replies are escape sequences; typing is printable characters and Enter.
export function looksTypedByHand(data) {
  const withoutEscapes = String(data || "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b[[\]()#;?]*[0-9;]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "");
  return /[^\x00-\x1f\x7f]/.test(withoutEscapes) || withoutEscapes.includes("\r");
}

export function hasBlockingDialog(plainOutput) {
  const text = String(plainOutput || "").toLowerCase();
  return DIALOG_PHRASES.some((phrase) => text.includes(phrase));
}

// Is this terminal's CLI sitting at an empty prompt, ready for a message?
export function isPromptReady(record, plainOutput) {
  if (!record || record.exited) {
    return false;
  }
  return Boolean(record.sessionId) && record.registryStatus === "idle" && !hasBlockingDialog(plainOutput);
}
