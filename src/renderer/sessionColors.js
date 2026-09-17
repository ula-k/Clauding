// A colour per session: the **name on the row is drawn in it**, and nothing
// else is — no bar, no chip, no tinted background. What the session is
// *doing* stays the dot before the name, exactly as it always was, so the
// two never get in each other's way.
//
// Two sources, in this order:
//   1. the colour the user picked in the row menu's "Colour", stored in
//      groups.json under `colors` (electron/sessionGroups.js),
//   2. otherwise an automatic one, worked out from the session id alone.
//
// The automatic colour is a plain hash, so it never changes: the same
// session gets the same colour on every start, with nothing written to
// disk. "Automatic" in the menu simply drops the stored entry and this
// takes over again.
//
// The eight tokens are the ones in styles/theme.css that the project dots
// use; electron/sessionGroups.js keeps the identical list, because it is the
// one that decides what may be stored.
export const SESSION_COLOR_TOKENS = [
  "--project-color-0",
  "--project-color-1",
  "--project-color-2",
  "--project-color-3",
  "--project-color-4",
  "--project-color-5",
  "--project-color-6",
  "--project-color-7"
];

// FNV-1a over the session id, kept inside 32 bits. Any stable hash would do;
// this one is four lines and spreads the near-identical uuids the CLI writes
// evenly over the eight swatches.
function hashOfText(text) {
  let hash = 2166136261;
  for (let position = 0; position < text.length; position += 1) {
    hash ^= text.charCodeAt(position);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

// The colour a session has when nobody picked one for it.
export function automaticSessionColor(sessionId) {
  const text = String(sessionId || "");
  if (!text) {
    return SESSION_COLOR_TOKENS[0];
  }
  return SESSION_COLOR_TOKENS[hashOfText(text) % SESSION_COLOR_TOKENS.length];
}

// What a row actually draws: the stored colour if there is a valid one, the
// automatic one otherwise.
export function sessionColorToken(sessionId, storedColors) {
  const stored = storedColors ? storedColors[sessionId] : null;
  if (stored && SESSION_COLOR_TOKENS.includes(stored)) {
    return stored;
  }
  return automaticSessionColor(sessionId);
}

// Whether the menu should tick "Automatic" rather than one of the swatches.
export function hasChosenColor(sessionId, storedColors) {
  const stored = storedColors ? storedColors[sessionId] : null;
  return Boolean(stored && SESSION_COLOR_TOKENS.includes(stored));
}
