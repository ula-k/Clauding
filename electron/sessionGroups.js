// The user's own grouping of the session list, saved to
// <userData>/groups.json. Nothing here is derived from the Claude Code
// registries: the groups are whatever the user made, the list only renders them.
//
// File shape (version 1):
//   {
//     "version": 1,
//     "groups": [{ "id": "default", "name": null, "order": 0 }, …],
//     "membership": { "<sessionId>": "<groupId>", … },
//     "hidden": ["<sessionId>", …],
//     "hiddenSince": { "<sessionId>": { "at": 1730000000000, "awaitingIdle": false }, … },
//     "collapsed": ["<groupId>", …],
//     "colors": { "<sessionId>": "--project-color-3", … },
//     "tags": [{ "id": "<uuid>", "label": "Finish today", "color": "--project-color-4" }, …],
//     "sessionTags": { "<sessionId>": ["<tagId>", …] }
//   }
//
// `tags` is the catalogue of the user's own tags — a label of at most 15
// characters and one of the eight palette colors each — and `sessionTags`
// says which of them a session wears (at most three; NEEDS ANSWER is not in
// here, it is worked out from the transcript and cannot be put on or taken
// off). A tag deleted from the catalogue leaves every session at the same
// time, and a deleted session takes its tags with it.
//
// A brand-new groups.json (and one written before tags existed) starts with
// the one shipped example, "Finish today". It is an ordinary tag: rename it,
// recolor it, delete it. Deleting it leaves `tags: []` in the file, which is
// a catalogue the user emptied — nothing is seeded into it again.
//
// `colors` holds only the colors the user picked by hand — the color a
// session's name is drawn in. A session that is not named there has no
// stored color at all and the list works one out from its id
// (src/renderer/sessionColors.js), so picking "Automatic" in the menu simply
// removes the entry again.
//
// `collapsed` lists the groups folded shut in the list (Default may be one of
// them). A group not named there is open — that is the default, so an older
// groups.json without the field simply has everything open.
//
// `hiddenSince` is what keeps a hidden session hidden. Hiding is "stop and
// put away": the app closes the session's own terminal first, so a row does
// not come back a second later merely because the CLI is still there. What
// brings a hidden session back is a *transition seen after it was hidden* —
// it starts needing an answer, or it goes busy again — never the mere fact
// that it exists and is idle. `awaitingIdle` is set when the session was
// still busy at the moment it was hidden: such a session has to be seen
// quiet once before "busy again" can mean anything.
//
// The group with id "default" always exists and always has a home for every
// session that is not named in `membership`; its `name` stays null so the
// renderer can print the translated label ("Default" / "Domyślna" / …).
// Renaming it stores a real name and that name wins from then on.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SAVE_DEBOUNCE_MILLISECONDS = 150;
const MAXIMUM_NAME_LENGTH = 60;

export const DEFAULT_GROUP_ID = "default";

// The eight colors a session's name can be drawn in. They are the tokens
// the project dots use in styles/theme.css, so a session color always
// belongs to the palette and never arrives here as a hex value;
// src/renderer/sessionColors.js keeps the identical list for the renderer,
// which also works out the automatic color of a session nobody has
// colored by hand.
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

// A tag label is short on purpose: it is a pill on a one-line row, and the
// row has a name to show as well. Fifteen characters is what fits next to a
// name without the pill needing an ellipsis of its own.
export const TAG_LABEL_MAX_LENGTH = 15;

// How many of the user's own tags one session can wear. The fourth is
// refused (the menu says so in a small note) rather than pushing one out:
// four pills plus NEEDS ANSWER is a row nobody can read.
export const MAX_TAGS_PER_SESSION = 3;

// The one tag the app ships with, so the feature is not an empty menu on
// the first run. It is seeded only into a catalogue that has never existed
// (see sanitize below), and it can be renamed, recolored or deleted like
// any other.
export const SEEDED_TAG = { id: "finish-today", label: "Finish today", color: "--project-color-4" };

export function cleanTagLabel(rawLabel) {
  return String(rawLabel || "").replace(/\s+/g, " ").trim().slice(0, TAG_LABEL_MAX_LENGTH);
}

function cleanTagColor(rawColor) {
  return SESSION_COLOR_TOKENS.includes(rawColor) ? rawColor : SESSION_COLOR_TOKENS[0];
}

function cleanName(rawName) {
  return String(rawName || "").replace(/\s+/g, " ").trim().slice(0, MAXIMUM_NAME_LENGTH);
}

function emptyState() {
  return {
    groups: [{ id: DEFAULT_GROUP_ID, name: null, order: 0 }],
    membership: {},
    hidden: [],
    hiddenSince: {},
    collapsed: [],
    colors: {},
    tags: [],
    sessionTags: {}
  };
}

// Anything unexpected in the file is dropped rather than crashing the app:
// a broken groups.json must never keep the session list from rendering.
function sanitize(saved) {
  const state = emptyState();
  if (!saved || typeof saved !== "object") {
    return state;
  }
  const seenIds = new Set([DEFAULT_GROUP_ID]);
  const groups = [];
  if (Array.isArray(saved.groups)) {
    for (const entry of saved.groups) {
      if (!entry || typeof entry.id !== "string" || !entry.id) {
        continue;
      }
      if (entry.id === DEFAULT_GROUP_ID) {
        state.groups[0].name = typeof entry.name === "string" && entry.name ? cleanName(entry.name) : null;
        state.groups[0].order = Number.isFinite(entry.order) ? Number(entry.order) : 0;
        continue;
      }
      if (seenIds.has(entry.id)) {
        continue;
      }
      seenIds.add(entry.id);
      groups.push({
        id: entry.id,
        name: cleanName(entry.name) || entry.id,
        order: Number.isFinite(entry.order) ? Number(entry.order) : groups.length + 1
      });
    }
  }
  // The user's own groups come first, in their order; Default is always last.
  groups.sort((first, second) => first.order - second.order);
  state.groups = groups.concat(state.groups);
  state.groups.forEach((group, position) => {
    group.order = position;
  });
  if (saved.membership && typeof saved.membership === "object") {
    for (const [sessionId, groupId] of Object.entries(saved.membership)) {
      if (typeof groupId === "string" && seenIds.has(groupId) && groupId !== DEFAULT_GROUP_ID) {
        state.membership[sessionId] = groupId;
      }
    }
  }
  if (Array.isArray(saved.hidden)) {
    state.hidden = saved.hidden.filter((sessionId) => typeof sessionId === "string");
    // A groups.json written before hiding remembered anything: every hidden
    // session is treated as hidden while quiet, which is the safe reading —
    // it stays hidden until something actually happens in it.
    const savedSince = saved.hiddenSince && typeof saved.hiddenSince === "object" ? saved.hiddenSince : {};
    for (const sessionId of state.hidden) {
      const entry = savedSince[sessionId];
      state.hiddenSince[sessionId] = {
        at: entry && Number.isFinite(entry.at) ? Number(entry.at) : Date.now(),
        awaitingIdle: Boolean(entry && entry.awaitingIdle)
      };
    }
  }
  // A color is a palette token and nothing else: a hex value, a token that
  // is not in the palette, or anything that is not a string is dropped, and
  // the session simply goes back to its automatic color.
  if (saved.colors && typeof saved.colors === "object") {
    for (const [sessionId, token] of Object.entries(saved.colors)) {
      if (typeof sessionId === "string" && sessionId && SESSION_COLOR_TOKENS.includes(token)) {
        state.colors[sessionId] = token;
      }
    }
  }
  // The tag catalogue. A tag needs an id and a label; the label is cut to
  // fifteen characters and the color has to be one of the palette tokens,
  // exactly like a session color. A file with no `tags` array at all has
  // never had a catalogue, so the shipped example goes in — an empty array
  // is a catalogue the user emptied and stays empty.
  if (Array.isArray(saved.tags)) {
    const seenTagIds = new Set();
    for (const entry of saved.tags) {
      if (!entry || typeof entry.id !== "string" || !entry.id || seenTagIds.has(entry.id)) {
        continue;
      }
      const label = cleanTagLabel(entry.label);
      if (!label) {
        continue;
      }
      seenTagIds.add(entry.id);
      state.tags.push({ id: entry.id, label, color: cleanTagColor(entry.color) });
    }
  } else {
    state.tags.push({ ...SEEDED_TAG });
  }
  // Which tags a session wears: only tags that exist, at most three, no
  // duplicates, and nothing stored for a session that wears none.
  if (saved.sessionTags && typeof saved.sessionTags === "object") {
    const knownTagIds = new Set(state.tags.map((tag) => tag.id));
    for (const [sessionId, tagIds] of Object.entries(saved.sessionTags)) {
      if (typeof sessionId !== "string" || !sessionId || !Array.isArray(tagIds)) {
        continue;
      }
      const kept = [];
      for (const tagId of tagIds) {
        if (knownTagIds.has(tagId) && !kept.includes(tagId) && kept.length < MAX_TAGS_PER_SESSION) {
          kept.push(tagId);
        }
      }
      if (kept.length > 0) {
        state.sessionTags[sessionId] = kept;
      }
    }
  }
  // Only groups that still exist can be collapsed; anything else is dropped.
  if (Array.isArray(saved.collapsed)) {
    state.collapsed = saved.collapsed.filter((groupId) => typeof groupId === "string" && seenIds.has(groupId));
  }
  return state;
}

export function createSessionGroupStore({ storagePath, onChange, log }) {
  let state = emptyState();
  let saveTimer = null;

  try {
    state = sanitize(JSON.parse(fs.readFileSync(storagePath, "utf8")));
  } catch (error) {
    // No file yet, or one that cannot be read: the same fresh start a file
    // with nothing in it gets — which is also where the shipped tag comes
    // from (sanitize seeds a catalogue that has never existed).
    state = sanitize({});
  }

  function save() {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(storagePath), { recursive: true });
        fs.writeFileSync(storagePath, JSON.stringify({ version: 1, ...state }, null, 2));
      } catch (error) {
        if (log) {
          log(`[groups] could not save ${storagePath}: ${error.message}`);
        }
      }
    }, SAVE_DEBOUNCE_MILLISECONDS);
  }

  // A copy the renderer can keep; never the stored objects themselves.
  function get() {
    return {
      groups: state.groups.map((group) => ({ ...group })),
      membership: { ...state.membership },
      hidden: state.hidden.slice(),
      hiddenSince: Object.fromEntries(
        Object.entries(state.hiddenSince).map(([sessionId, entry]) => [sessionId, { ...entry }])
      ),
      collapsed: state.collapsed.slice(),
      colors: { ...state.colors },
      tags: state.tags.map((tag) => ({ ...tag })),
      sessionTags: Object.fromEntries(
        Object.entries(state.sessionTags).map(([sessionId, tagIds]) => [sessionId, tagIds.slice()])
      )
    };
  }

  function announce() {
    save();
    if (onChange) {
      onChange(get());
    }
  }

  // `order` is simply the position in the array, so the array is the truth
  // from here on (it is sorted once when the file is read). Sorting again
  // here would undo the swap moveGroup() has just made.
  function renumber() {
    state.groups.forEach((group, position) => {
      group.order = position;
    });
  }

  function createGroup(rawName) {
    const name = cleanName(rawName);
    if (!name) {
      throw new Error("A group needs a name.");
    }
    // A new group is important right now, so it opens at the very top.
    const group = { id: randomUUID(), name, order: 0 };
    state.groups.unshift(group);
    renumber();
    announce();
    return { ...group };
  }

  function renameGroup(groupId, rawName) {
    const group = state.groups.find((entry) => entry.id === groupId);
    const name = cleanName(rawName);
    if (!group || !name) {
      return get();
    }
    group.name = name;
    announce();
    return get();
  }

  // "up" / "down" swap the group with its neighbour; the list never reorders
  // itself, so the order the user sets is the order that stays.
  // Default stays pinned at the bottom, so it never takes part in a swap.
  function moveGroup(groupId, direction) {
    const position = state.groups.findIndex((entry) => entry.id === groupId);
    const target = direction === "up" ? position - 1 : position + 1;
    const lastMovablePosition = state.groups.length - 2;
    if (groupId === DEFAULT_GROUP_ID || position === -1 || target < 0 || target > lastMovablePosition) {
      return get();
    }
    const moved = state.groups[position];
    state.groups[position] = state.groups[target];
    state.groups[target] = moved;
    renumber();
    announce();
    return get();
  }

  // Deleting a group never deletes sessions: everything in it goes back to
  // Default (which is why Default itself cannot be deleted).
  function deleteGroup(groupId) {
    if (groupId === DEFAULT_GROUP_ID) {
      return get();
    }
    const position = state.groups.findIndex((entry) => entry.id === groupId);
    if (position === -1) {
      return get();
    }
    state.groups.splice(position, 1);
    state.collapsed = state.collapsed.filter((collapsedId) => collapsedId !== groupId);
    for (const [sessionId, memberGroupId] of Object.entries(state.membership)) {
      if (memberGroupId === groupId) {
        delete state.membership[sessionId];
      }
    }
    renumber();
    announce();
    return get();
  }

  function assignSession(sessionId, groupId) {
    if (!sessionId) {
      return get();
    }
    const known = state.groups.some((entry) => entry.id === groupId);
    if (!known || groupId === DEFAULT_GROUP_ID) {
      delete state.membership[sessionId];
    } else {
      state.membership[sessionId] = groupId;
    }
    announce();
    return get();
  }

  // Folding a group shut only hides its rows on screen: membership, hiding
  // and status are all untouched, and the header stays put (it is still a
  // drop target). Default can be collapsed too — a "PRIV" group folded shut
  // is the point of the feature: nothing of it shows on a shared screen.
  function setCollapsed(groupId, collapsed) {
    if (!state.groups.some((entry) => entry.id === groupId)) {
      return get();
    }
    const isCollapsed = state.collapsed.includes(groupId);
    if (collapsed && !isCollapsed) {
      state.collapsed.push(groupId);
    } else if (!collapsed && isCollapsed) {
      state.collapsed = state.collapsed.filter((entry) => entry !== groupId);
    } else {
      return get();
    }
    announce();
    return get();
  }

  // Hiding only adds the session to `hidden`; its group is untouched, so
  // unhiding (by hand or automatically) puts it back exactly where it was.
  //
  // `wasBusy` is what the session was doing at the moment it was hidden.
  // Hiding a busy one (a session running in a terminal outside the app) does
  // not stop it, so it has to be seen quiet once before going busy again can
  // mean "something is happening here, look" — otherwise it would bounce
  // back into the list on the very next poll. The app's own terminals are
  // closed before this is called, so they are hidden quiet.
  function setHidden(sessionId, hidden, wasBusy = false) {
    if (!sessionId) {
      return get();
    }
    const isHidden = state.hidden.includes(sessionId);
    if (hidden && !isHidden) {
      state.hidden.push(sessionId);
      state.hiddenSince[sessionId] = { at: Date.now(), awaitingIdle: Boolean(wasBusy) };
    } else if (!hidden && isHidden) {
      state.hidden = state.hidden.filter((entry) => entry !== sessionId);
      delete state.hiddenSince[sessionId];
    } else {
      return get();
    }
    announce();
    return get();
  }

  // The color of one session, picked from the row's "Color" menu. `token`
  // null is "Automatic": the entry goes away and the list works the color
  // out from the session id again, which is what an uncolored session has
  // always had.
  function setSessionColor(sessionId, token) {
    if (!sessionId) {
      return get();
    }
    if (token === null || token === undefined || token === "") {
      if (!(sessionId in state.colors)) {
        return get();
      }
      delete state.colors[sessionId];
      announce();
      return get();
    }
    if (!SESSION_COLOR_TOKENS.includes(token) || state.colors[sessionId] === token) {
      return get();
    }
    state.colors[sessionId] = token;
    announce();
    return get();
  }

  // ---- Tags ------------------------------------------------------------
  //
  // The catalogue is the user's; a session wears up to three of its tags.
  // Nothing here knows about NEEDS ANSWER — that badge is read out of the
  // transcript and is not a tag anybody can put on or take off.

  // A new tag. The label is trimmed and cut to fifteen characters and the
  // color has to be a palette token; a tag with no label at all is not made.
  function createTag(draft) {
    const label = cleanTagLabel(draft && draft.label);
    if (!label) {
      return { tag: null, state: get() };
    }
    const tag = { id: randomUUID(), label, color: cleanTagColor(draft && draft.color) };
    state.tags.push(tag);
    announce();
    return { tag: { ...tag }, state: get() };
  }

  // Rename or recolor one tag. Every session wearing it follows, because a
  // session stores the tag's id and nothing else.
  function updateTag(tagId, draft) {
    const tag = state.tags.find((entry) => entry.id === tagId);
    if (!tag) {
      return get();
    }
    const label = cleanTagLabel(draft && draft.label);
    const color = draft && draft.color ? cleanTagColor(draft.color) : tag.color;
    if (label) {
      tag.label = label;
    }
    tag.color = color;
    announce();
    return get();
  }

  // Deleting a tag takes it off every session at the same time — that is
  // the whole of the cascade, and it is why the menu asks first.
  function deleteTag(tagId) {
    const position = state.tags.findIndex((entry) => entry.id === tagId);
    if (position === -1) {
      return get();
    }
    state.tags.splice(position, 1);
    for (const [sessionId, tagIds] of Object.entries(state.sessionTags)) {
      const kept = tagIds.filter((entry) => entry !== tagId);
      if (kept.length === 0) {
        delete state.sessionTags[sessionId];
      } else {
        state.sessionTags[sessionId] = kept;
      }
    }
    announce();
    return get();
  }

  // Put one tag on, or take it off, every session named — one row from its
  // own menu, or a whole selection from the bulk one. A session that
  // already wears three tags refuses the fourth and is named in `refused`,
  // so the menu can say so instead of silently doing nothing.
  function setSessionsTag(sessionIds, tagId, applied) {
    const known = state.tags.some((entry) => entry.id === tagId);
    if (!known) {
      return { state: get(), refused: [] };
    }
    const refused = [];
    let touched = false;
    for (const sessionId of Array.isArray(sessionIds) ? sessionIds : [sessionIds]) {
      if (typeof sessionId !== "string" || !sessionId) {
        continue;
      }
      const worn = state.sessionTags[sessionId] || [];
      const wearsIt = worn.includes(tagId);
      if (applied && !wearsIt) {
        if (worn.length >= MAX_TAGS_PER_SESSION) {
          refused.push(sessionId);
          continue;
        }
        state.sessionTags[sessionId] = worn.concat([tagId]);
        touched = true;
      } else if (!applied && wearsIt) {
        const kept = worn.filter((entry) => entry !== tagId);
        if (kept.length === 0) {
          delete state.sessionTags[sessionId];
        } else {
          state.sessionTags[sessionId] = kept;
        }
        touched = true;
      }
    }
    if (touched) {
      announce();
    }
    return { state: get(), refused };
  }

  // Every session this store knows nothing about any more (deleted) is
  // forgotten here: its group, its place in `hidden`, its hiding note, its
  // color and its tags.
  function forgetSession(sessionId) {
    if (!sessionId) {
      return get();
    }
    const known =
      sessionId in state.membership ||
      state.hidden.includes(sessionId) ||
      sessionId in state.hiddenSince ||
      sessionId in state.colors ||
      sessionId in state.sessionTags;
    if (!known) {
      return get();
    }
    delete state.membership[sessionId];
    delete state.hiddenSince[sessionId];
    delete state.colors[sessionId];
    delete state.sessionTags[sessionId];
    state.hidden = state.hidden.filter((entry) => entry !== sessionId);
    announce();
    return get();
  }

  // What the poll saw this time round: `liveBySession` is a Map of
  // sessionId -> { busy, needsAnswer }. A hidden session comes back only on
  // something that happened *after* it was hidden — it needs an answer, or
  // it went busy again having been seen quiet since. Being present in the
  // registry, or sitting idle at a prompt, is not an event: that is exactly
  // how a hidden session used to bounce straight back into the list.
  function unhideOnActivity(liveBySession) {
    const woken = [];
    let touched = false;
    for (const sessionId of state.hidden.slice()) {
      const live = (liveBySession && liveBySession.get(sessionId)) || null;
      const note = state.hiddenSince[sessionId] || { at: Date.now(), awaitingIdle: false };
      const busy = Boolean(live && live.busy);
      const needsAnswer = Boolean(live && live.needsAnswer);
      if (!busy && note.awaitingIdle) {
        // Seen quiet at last: from here on, busy again means something new.
        state.hiddenSince[sessionId] = { ...note, awaitingIdle: false };
        touched = true;
        continue;
      }
      if (needsAnswer || (busy && !note.awaitingIdle)) {
        woken.push(sessionId);
      }
    }
    if (woken.length === 0) {
      if (touched) {
        announce();
      }
      return false;
    }
    if (log) {
      log(`[groups] unhidden because something happened in them: ${woken.join(", ")}`);
    }
    state.hidden = state.hidden.filter((sessionId) => !woken.includes(sessionId));
    for (const sessionId of woken) {
      delete state.hiddenSince[sessionId];
    }
    announce();
    return true;
  }

  return {
    get,
    createGroup,
    renameGroup,
    moveGroup,
    deleteGroup,
    assignSession,
    setCollapsed,
    setSessionColor,
    createTag,
    updateTag,
    deleteTag,
    setSessionsTag,
    setHidden,
    forgetSession,
    unhideOnActivity
  };
}
