// What a fork's `--name` looks like: the original title with a marker after
// it, so the two rows are told apart at a glance. Left untranslated on
// purpose — it becomes the session's stored display name, not a label the
// app redraws when the interface language changes.
export const FORK_NAME_SUFFIX = " (fork)";
export const FORK_NAME_MAX_LENGTH = 90;

// A long title is cut with an ellipsis so the whole name, marker included,
// still fits the limit.
export function forkDisplayName(originalTitle) {
  const cleaned = String(originalTitle || "").replace(/\s+/g, " ").trim();
  const room = FORK_NAME_MAX_LENGTH - FORK_NAME_SUFFIX.length;
  const shortened = cleaned.length > room ? `${cleaned.slice(0, room - 1)}…` : cleaned;
  return `${shortened}${FORK_NAME_SUFFIX}`;
}
