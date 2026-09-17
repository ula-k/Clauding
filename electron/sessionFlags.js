// The extra `claude` flags a single conversation was started with, saved to
// <userData>/session-flags.json so they can be put back on every later
// `--resume`. Without this a session started with `--channels
// plugin:telegram@claude-plugins-official` would quietly lose its channel the first time the app
// resumed it, and a Telegram conversation would simply stop arriving.
//
// File shape (version 1):
//   { "version": 1, "sessionFlags": { "<sessionId>": "--channels plugin:telegram@claude-plugins-official" } }
//
// Only the *session* level is kept here. The global flags live in
// settings.json and the agent's in agents.json, and both are read fresh
// every time a terminal starts, so changing them changes every future
// terminal — which is what makes them the other two levels.
//
// The file is also *re-read* when something else writes it (main.js watches
// it): "Extra claude flags…" in another window, or the user editing
// session-flags.json by hand, no longer needs the app to be restarted
// before the change is seen.
import fs from "node:fs";
import path from "node:path";

const SAVE_DEBOUNCE_MILLISECONDS = 150;
const MAXIMUM_FLAGS_LENGTH = 500;

export function cleanFlagsText(rawText) {
  return String(rawText || "").replace(/\s+/g, " ").trim().slice(0, MAXIMUM_FLAGS_LENGTH);
}

function sanitize(saved) {
  const source = saved && typeof saved === "object" ? saved : {};
  const stored = source.sessionFlags && typeof source.sessionFlags === "object" ? source.sessionFlags : {};
  const sessionFlags = {};
  for (const [sessionId, flags] of Object.entries(stored)) {
    const text = cleanFlagsText(flags);
    if (sessionId && text) {
      sessionFlags[sessionId] = text;
    }
  }
  return { sessionFlags };
}

// Two states hold the same thing when every session in one is in the other
// with the same flags. Used to tell a change on disk from the echo of the
// app's own write.
function sameFlags(first, second) {
  const firstIds = Object.keys(first.sessionFlags).sort();
  const secondIds = Object.keys(second.sessionFlags).sort();
  if (firstIds.join("\n") !== secondIds.join("\n")) {
    return false;
  }
  return firstIds.every((sessionId) => first.sessionFlags[sessionId] === second.sessionFlags[sessionId]);
}

export function createSessionFlagsStore({ storagePath, onChange, log }) {
  let state = sanitize(null);
  let saveTimer = null;

  try {
    state = sanitize(JSON.parse(fs.readFileSync(storagePath, "utf8")));
  } catch (error) {
    state = sanitize(null);
  }

  function save() {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(storagePath), { recursive: true });
        fs.writeFileSync(storagePath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
      } catch (error) {
        if (log) {
          log(`[session-flags] could not save ${storagePath}: ${error.message}`);
        }
      }
    }, SAVE_DEBOUNCE_MILLISECONDS);
  }

  function get() {
    return { sessionFlags: { ...state.sessionFlags } };
  }

  function announce() {
    if (onChange) {
      onChange(get());
    }
  }

  // Somebody else wrote the file: another window's "Extra claude flags…",
  // or a hand edit in Application Support. A half-written or unreadable
  // file changes nothing — what is in memory is still the better answer —
  // and a file that says exactly what is already held raises no change, so
  // the store's own saves do not come back as news.
  function reloadFromDisk() {
    let loaded = null;
    try {
      loaded = sanitize(JSON.parse(fs.readFileSync(storagePath, "utf8")));
    } catch (error) {
      return false;
    }
    if (sameFlags(loaded, state)) {
      return false;
    }
    state = loaded;
    if (log) {
      log(`[session-flags] re-read ${storagePath} after a change on disk`);
    }
    announce();
    return true;
  }

  function flagsFor(sessionId) {
    return (sessionId && state.sessionFlags[sessionId]) || "";
  }

  // Written the moment a terminal learns which session it became. Empty
  // flags remove the entry instead of storing an empty string.
  function remember(sessionId, flags) {
    if (!sessionId) {
      return "";
    }
    const text = cleanFlagsText(flags);
    if (state.sessionFlags[sessionId] === text) {
      return text;
    }
    if (text) {
      state.sessionFlags[sessionId] = text;
    } else {
      delete state.sessionFlags[sessionId];
    }
    save();
    announce();
    return text;
  }

  function forget(sessionId) {
    if (sessionId && state.sessionFlags[sessionId]) {
      delete state.sessionFlags[sessionId];
      save();
      announce();
    }
  }

  return { get, flagsFor, remember, forget, reloadFromDisk };
}
