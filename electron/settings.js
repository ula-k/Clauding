// The app's own settings, saved to <userData>/settings.json. There are two,
// and both are folders:
//
//   agentsRoot   where a new agent definition is created — the folder the
//                Agent Maker writes into and the one the app watches, so a
//                definition that appears there can be offered as an agent.
//                Default: ~/Clauding/agents.
//   skillsRoot   where Claude Code reads skills from. Default
//                ~/.claude/skills, which is the CLI's own folder — the app
//                only reads it (and, once the user has said yes, seeds the
//                built-in skill-maker into it), so the menu shows this path
//                without offering to change it.
//
// Two more settings are remembered next to them:
//
//   skillScanRoots      extra folders "Scan for skills…" looks through, on
//                       top of the places it knows about. Added with a
//                       folder picker, never guessed.
//   extraClaudeArguments  extra flags every `claude` this app starts gets,
//                         written the way they would be typed in a terminal
//                         ("--model sonnet"). The first of the three levels;
//                         see electron/lib/claudeArguments.js.
//   skillMakerSeeding   "unanswered" until the user has been asked whether
//                       the built-in skill-maker may be written into their
//                       skills folder, then "installed" or "declined". The
//                       one file the app writes under ~/.claude is not
//                       written behind the user's back.
//
// File shape (version 1):
//   { "version": 1, "agentsRoot": "/Users/<you>/Clauding/agents",
//     "skillsRoot": "/Users/<you>/.claude/skills",
//     "skillScanRoots": [], "skillMakerSeeding": "unanswered",
//     "extraClaudeArguments": "" }
//
// Anything unexpected in the file is replaced by the default, exactly like
// groups.json and agents.json: a broken settings.json must never keep the
// app from starting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeExtraArguments } from "./lib/claudeArguments.js";
import { claudeRegistryPaths, expandHomeFolder } from "./lib/platformPaths.js";

const SAVE_DEBOUNCE_MILLISECONDS = 150;
const MAXIMUM_EXTRA_ARGUMENTS_LENGTH = 500;

export function defaultAgentsRoot() {
  return path.join(os.homedir(), "Clauding", "agents");
}

export function defaultSkillsRoot() {
  return claudeRegistryPaths({ homeDirectory: os.homedir() }).skillsDirectory;
}

function cleanFolder(rawFolder, fallback) {
  const folder = String(rawFolder || "").trim();
  if (!folder) {
    return fallback;
  }
  const expanded = expandHomeFolder(folder);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : fallback;
}

export const SKILL_SEEDING_ANSWERS = ["unanswered", "installed", "declined"];

// Folders the user added by hand: anything that is not an absolute path is
// dropped, and the same folder is never kept twice.
function cleanFolderList(rawList) {
  if (!Array.isArray(rawList)) {
    return [];
  }
  const folders = [];
  for (const entry of rawList) {
    const folder = cleanFolder(entry, "");
    if (folder && !folders.includes(folder)) {
      folders.push(folder);
    }
  }
  return folders;
}

// Flags the app sets itself are taken out here as well as in the field, so
// a settings.json edited by hand cannot break every terminal at once.
export function cleanExtraClaudeArguments(rawText) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim().slice(0, MAXIMUM_EXTRA_ARGUMENTS_LENGTH);
  return mergeExtraArguments([text]).join(" ");
}

function sanitize(saved) {
  const source = saved && typeof saved === "object" ? saved : {};
  const seeding = String(source.skillMakerSeeding || "");
  return {
    agentsRoot: cleanFolder(source.agentsRoot, defaultAgentsRoot()),
    skillsRoot: cleanFolder(source.skillsRoot, defaultSkillsRoot()),
    skillScanRoots: cleanFolderList(source.skillScanRoots),
    skillMakerSeeding: SKILL_SEEDING_ANSWERS.includes(seeding) ? seeding : "unanswered",
    extraClaudeArguments: cleanExtraClaudeArguments(source.extraClaudeArguments)
  };
}

function sameSettings(first, second) {
  return (
    first.agentsRoot === second.agentsRoot &&
    first.skillsRoot === second.skillsRoot &&
    first.skillMakerSeeding === second.skillMakerSeeding &&
    first.extraClaudeArguments === second.extraClaudeArguments &&
    first.skillScanRoots.join("\n") === second.skillScanRoots.join("\n")
  );
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
    return { ...state, skillScanRoots: state.skillScanRoots.slice() };
  }

  // One more folder for "Scan for skills…" to look through. Adding the same
  // one twice is not an error, it simply changes nothing.
  function addSkillScanRoot(folder) {
    return update({ skillScanRoots: state.skillScanRoots.concat([folder]) });
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
    if (sameSettings(merged, state)) {
      return get();
    }
    state = merged;
    save();
    if (onChange) {
      onChange(get());
    }
    return get();
  }

  // settings.json was edited outside the app (main.js watches it). An
  // unreadable or half-written file changes nothing, and a file that says
  // what is already held raises no change — so the store's own saves do not
  // come back as news.
  function reloadFromDisk() {
    let loaded = null;
    try {
      loaded = sanitize(JSON.parse(fs.readFileSync(storagePath, "utf8")));
    } catch (error) {
      return false;
    }
    if (sameSettings(loaded, state)) {
      return false;
    }
    state = loaded;
    if (log) {
      log(`[settings] re-read ${storagePath} after a change on disk`);
    }
    if (onChange) {
      onChange(get());
    }
    return true;
  }

  return { get, update, ensureAgentsRoot, addSkillScanRoot, reloadFromDisk };
}
