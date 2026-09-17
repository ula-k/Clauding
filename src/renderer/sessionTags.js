// The user's own tags on a session row, as rules rather than as a menu: what
// a session wears, what a click in the bulk menu would do, and how a label
// is cleaned before it is stored.
//
// NEEDS ANSWER is **not** here. That badge is worked out from the transcript
// (electron/lib/needsAnswer.js) and nobody can put it on or take it off; the
// row draws it first and these tags after it.
//
// The two limits are kept here and in electron/sessionGroups.js, the same
// way the color palette is: this file is what the window enforces while the
// user types, that one is what the store refuses to write.

// A pill sits next to a name on a one-line row, so a label stays short
// enough never to need an ellipsis of its own.
export const TAG_LABEL_MAX_LENGTH = 15;

// Three of the user's own tags plus NEEDS ANSWER is four pills, which is
// what a row can carry over two lines and still be read.
export const MAX_TAGS_PER_SESSION = 3;

// The same cleaning the store does: one line, no double spaces, cut to the
// limit. Applied while the field is typed into, so what is on screen is
// exactly what will be saved.
export function cleanTagLabel(rawLabel) {
  return String(rawLabel || "").replace(/\s+/g, " ").trim().slice(0, TAG_LABEL_MAX_LENGTH);
}

// The tags one session wears, as whole tag objects, in the catalogue's
// order — so two sessions wearing the same pair always show it in the same
// order — and never more than the limit.
export function tagsForSession(sessionId, tags, sessionTags) {
  const worn = (sessionTags && sessionTags[sessionId]) || [];
  if (worn.length === 0) {
    return [];
  }
  const wanted = new Set(worn);
  return (tags || []).filter((tag) => wanted.has(tag.id)).slice(0, MAX_TAGS_PER_SESSION);
}

// Whether one more tag would fit on a session.
export function canWearAnotherTag(sessionId, sessionTags) {
  const worn = (sessionTags && sessionTags[sessionId]) || [];
  return worn.length < MAX_TAGS_PER_SESSION;
}

// Every label a search box should match for one session.
export function tagLabelsForSession(sessionId, tags, sessionTags) {
  return tagsForSession(sessionId, tags, sessionTags).map((tag) => tag.label);
}

// What the bulk menu shows for one tag, and what a click on it would do.
//
//   state "all"   every picked session wears it      -> the click takes it off
//   state "some"  only some of them do (mixed)       -> the click puts it on all
//   state "none"  none of them do                    -> the click puts it on all
//
// `refused` names the sessions that would turn the tag down because they
// already wear three, so the menu can say so rather than appearing to do
// nothing. Removing never refuses anybody.
export function bulkTagPlan({ sessionIds, sessionTags, tagId }) {
  const ids = (sessionIds || []).filter((sessionId) => typeof sessionId === "string" && sessionId);
  if (ids.length === 0 || !tagId) {
    return { state: "none", applied: true, refused: [], sessionIds: [] };
  }
  const wearing = ids.filter((sessionId) => ((sessionTags && sessionTags[sessionId]) || []).includes(tagId));
  const state = wearing.length === ids.length ? "all" : wearing.length === 0 ? "none" : "some";
  const applied = state !== "all";
  const refused = applied
    ? ids.filter(
        (sessionId) =>
          !((sessionTags && sessionTags[sessionId]) || []).includes(tagId) && !canWearAnotherTag(sessionId, sessionTags)
      )
    : [];
  return { state, applied, refused, sessionIds: ids };
}
