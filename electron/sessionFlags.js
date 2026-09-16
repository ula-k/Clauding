// The extra `claude` flags a single conversation was started with, saved to
// <userData>/session-flags.json so they can be put back on every later
// `--resume`. Without this a session started with `--channels
// plugin:telegram` would quietly lose its channel the first time the app
// resumed it, and a Telegram conversation would simply stop arriving.
//
// File shape (version 1):
//   { "version": 1, "sessionFlags": { "<sessionId>": "--channels plugin:telegram" } }
//
// Only the *session* level is kept here. The global flags live in
// settings.json and the agent's in agents.json, and both are read fresh
// every time a terminal starts, so changing them changes every future
// terminal — which is what makes them the other two levels.
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

export function createSessionFlagsStore({ storagePath, log }) {
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
    return text;
  }

  function forget(sessionId) {
    if (sessionId && state.sessionFlags[sessionId]) {
      delete state.sessionFlags[sessionId];
      save();
    }
  }

  return { get, flagsFor, remember, forget };
}
