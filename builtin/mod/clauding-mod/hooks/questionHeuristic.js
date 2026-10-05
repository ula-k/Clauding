// Does the last thing the assistant said read as a question to the user?
//
// One rule, two readers: the app (electron/lib/needsAnswer.js) asks it of
// the tail of a transcript, for sessions that run without the Clauding mod;
// the mod (register.mjs, next to this file) asks it of a turn's final answer
// the moment the turn ends. It lives here, inside the mod's folder, because a
// mod may only import files of its own plugin — the app imports it from here.
//
// Pure: text in, a boolean out. No Node, no DOM, nothing but the language.

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

// The rule, in order:
//   1. a line that starts with `needs input:`, or "needs input" near the end;
//   2. the last non-empty line ends with a question mark (closing
//      punctuation after it is fine: "…, czy tak?**");
//   3. one of the explicit asks above, anywhere in the text.
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
  if (/\?[)\]*_"'`»”]*$/.test(lastLine)) {
    return true;
  }
  return EXPLICIT_ASK_PHRASES.some((phrase) => lowerCase.includes(phrase));
}
