// A color per session: the **name on the row is drawn in it**, and nothing
// else is — no bar, no chip, no tinted background. What the session is
// *doing* stays the dot before the name, exactly as it always was, so the
// two never get in each other's way.
//
// A session has a color only when the user gave it one, in the row menu's
// "Color". There is no automatic color: an untouched session's name is
// written in the ordinary text color, so the colored ones are the ones that
// were meant to stand out. "None" in the menu drops the stored entry again.
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

// What a row actually draws: the color the user picked, or null — a
// session nobody colored has no color of its own and the row falls back to
// the ordinary text color.
export function sessionColorToken(sessionId, storedColors) {
  const stored = storedColors ? storedColors[sessionId] : null;
  return stored && SESSION_COLOR_TOKENS.includes(stored) ? stored : null;
}

// Whether this session has a color of its own — what the menu ticks, and
// the opposite of what "None" means.
export function hasChosenColor(sessionId, storedColors) {
  return sessionColorToken(sessionId, storedColors) !== null;
}
