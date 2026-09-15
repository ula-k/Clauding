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
//     "collapsed": ["<groupId>", …]
//   }
//
// `collapsed` lists the groups folded shut in the list (Default may be one of
// them). A group not named there is open — that is the default, so an older
// groups.json without the field simply has everything open.
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

function cleanName(rawName) {
  return String(rawName || "").replace(/\s+/g, " ").trim().slice(0, MAXIMUM_NAME_LENGTH);
}

function emptyState() {
  return {
    groups: [{ id: DEFAULT_GROUP_ID, name: null, order: 0 }],
    membership: {},
    hidden: [],
    collapsed: []
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
    state = emptyState();
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
      collapsed: state.collapsed.slice()
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
  function setHidden(sessionId, hidden) {
    if (!sessionId) {
      return get();
    }
    const isHidden = state.hidden.includes(sessionId);
    if (hidden && !isHidden) {
      state.hidden.push(sessionId);
    } else if (!hidden && isHidden) {
      state.hidden = state.hidden.filter((entry) => entry !== sessionId);
    } else {
      return get();
    }
    announce();
    return get();
  }

  // A hidden session that the CLI registry shows as busy again comes back:
  // the user hid it because the list was too long, not to lose track of live work.
  function unhideRunning(runningSessionIds) {
    const stillHidden = state.hidden.filter((sessionId) => !runningSessionIds.has(sessionId));
    if (stillHidden.length === state.hidden.length) {
      return false;
    }
    if (log) {
      const woken = state.hidden.filter((sessionId) => runningSessionIds.has(sessionId));
      log(`[groups] unhidden because they are running again: ${woken.join(", ")}`);
    }
    state.hidden = stillHidden;
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
    setHidden,
    unhideRunning
  };
}
