// The app's own settings, saved to <userData>/settings.json. There are two,
// and both are folders:
//
//   agentsRoot   where a new agent definition is created — the folder the
//                Agent Maker writes into and the one the app watches, so a
//                definition that appears there can be offered as an agent.
//                Default: ~/Clauding/agents.
//   skillsRoot   where Claude Code reads skills from. Default
//                ~/.claude/skills, which is the CLI's own folder — the app
//                only reads it (and seeds the built-in skill-maker into it),
//                so the menu shows this path without offering to change it.
//
// File shape (version 1):
//   { "version": 1, "agentsRoot": "/Users/<you>/Clauding/agents",
//     "skillsRoot": "/Users/<you>/.claude/skills" }
//
// Anything unexpected in the file is replaced by the default, exactly like
// groups.json and agents.json: a broken settings.json must never keep the
// app from starting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAVE_DEBOUNCE_MILLISECONDS = 150;

export function defaultAgentsRoot() {
  return path.join(os.homedir(), "Clauding", "agents");
}

export function defaultSkillsRoot() {
  return path.join(os.homedir(), ".claude", "skills");
}

function cleanFolder(rawFolder, fallback) {
  const folder = String(rawFolder || "").trim();
  if (!folder) {
    return fallback;
  }
  const expanded = folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(2)) : folder;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : fallback;
}

function sanitize(saved) {
  const source = saved && typeof saved === "object" ? saved : {};
  return {
    agentsRoot: cleanFolder(source.agentsRoot, defaultAgentsRoot()),
    skillsRoot: cleanFolder(source.skillsRoot, defaultSkillsRoot())
  };
}

export function createSettingsStore({ storagePath, onChange, log }) {
  let state = sanitize(null);
  let saveTimer = null;

  let hasStoredFile = true;
  try {
    state = sanitize(JSON.parse(fs.readFileSync(storagePath, "utf8")));
  } catch (error) {
    state = sanitize(null);
    hasStoredFile = false;
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
          log(`[settings] could not save ${storagePath}: ${error.message}`);
        }
      }
    }, SAVE_DEBOUNCE_MILLISECONDS);
  }

  // The file is written on the very first start rather than only when
  // something changes, so both folders can be seen (and edited by hand) in
  // Application Support from day one.
  if (!hasStoredFile) {
    save();
  }

  function get() {
    return { ...state };
  }

  // The agents root is created when it is read, so the watcher has something
  // to watch and the Agent Maker has somewhere to write. The skills root is
  // the CLI's own folder and is created the same way, by the seeding.
  function ensureAgentsRoot() {
    try {
      fs.mkdirSync(state.agentsRoot, { recursive: true });
    } catch (error) {
      if (log) {
        log(`[settings] could not create ${state.agentsRoot}: ${error.message}`);
      }
    }
    return state.agentsRoot;
  }

  function update(draft) {
    const merged = sanitize({ ...state, ...(draft || {}) });
    if (merged.agentsRoot === state.agentsRoot && merged.skillsRoot === state.skillsRoot) {
      return get();
    }
    state = merged;
    save();
    if (onChange) {
      onChange(get());
    }
    return get();
  }

  return { get, update, ensureAgentsRoot };
}
