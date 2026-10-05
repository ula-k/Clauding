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
// And the things that used to be baked into the code, so the setup agent
// (or the user) can say what is true on this machine:
//
//   language       "" (follow the system) or one of the window's languages
//   preambleExtra  text appended to preamble.md in every terminal ("answer
//                  in Polish", "plans open as HTML pages in the panel")
//   claudeBinary   "" (find it: ~/.local/bin/claude, then PATH) or the
//                  absolute path of the `claude` to start;
//                  CLAUDING_CLAUDE_BIN still wins
//   claudeHome     "" (~/.claude) or the folder Claude Code keeps its
//                  sessions in; CLAUDE_CONFIG_DIR still wins
//   onboarding     "" until the first-run question was answered (by the
//                  setup agent's `clauding onboarding done`, or "I'll set
//                  it up myself"), then "done"
//
// And the Clauding mod's switches (Settings → "Clauding mod", see
// electron/lib/modState.js and builtin/mod/clauding-mod/): modEnabled (the
// overall one: whether `--plugin-dir` is added at all), modStateReports,
// modNotifications, modSound (the only one off by default), modStatusLine,
// modContextBar, modGuard, and modGuardPatterns — the guard's rules, one
// regular expression per line; an empty field means the defaults. A session
// cannot change these with `clauding settings set`: the guard is not
// something the session it guards may switch off.
//
// File shape (version 1):
//   { "version": 1, "agentsRoot": "/Users/<you>/Clauding/agents",
//     "skillsRoot": "/Users/<you>/.claude/skills",
//     "skillScanRoots": [], "skillMakerSeeding": "unanswered",
//     "extraClaudeArguments": "", "language": "", "preambleExtra": "",
//     "claudeBinary": "", "claudeHome": "", "onboarding": "" }
//
// Anything unexpected in the file is replaced by the default, exactly like
// groups.json and agents.json: a broken settings.json must never keep the
// app from starting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeExtraArguments } from "./lib/claudeArguments.js";
import { LANGUAGE_CODES, MAXIMUM_PREAMBLE_EXTRA_CHARACTERS } from "./lib/settingCommands.js";
import { claudeHomeFolder, claudeRegistryPaths, expandHomeFolder, samePath } from "./lib/platformPaths.js";
import { MOD_SWITCH_KEYS, cleanGuardPatterns, cleanModSwitches } from "./lib/modState.js";
import { DEFAULT_GUARD_PATTERNS } from "../builtin/mod/clauding-mod/hooks/commandGuard.js";

const SAVE_DEBOUNCE_MILLISECONDS = 150;
const MAXIMUM_EXTRA_ARGUMENTS_LENGTH = 500;
// The window's languages (src/renderer/languageDetection.js has the same list).
const SETTING_LANGUAGES = LANGUAGE_CODES;
export const ONBOARDING_STATES = ["", "done"];

export function defaultAgentsRoot() {
  return path.join(os.homedir(), "Clauding", "agents");
}

// The skills folder inside the Claude folder: ~/.claude/skills unless the
// app (or CLAUDE_CONFIG_DIR) points somewhere else.
export function defaultSkillsRoot(claudeHome = "") {
  const folder = claudeHomeFolder({ homeDirectory: os.homedir(), configuredHome: claudeHome });
  return claudeRegistryPaths({ homeDirectory: os.homedir(), claudeHome: folder }).skillsDirectory;
}

export function cleanLanguage(rawLanguage) {
  const language = String(rawLanguage || "").trim();
  return SETTING_LANGUAGES.includes(language) ? language : "";
}

// Free text, kept as written (line breaks included), only trimmed and cut.
export function cleanPreambleExtra(rawText) {
  return String(rawText || "").replace(/\r\n/g, "\n").trim().slice(0, MAXIMUM_PREAMBLE_EXTRA_CHARACTERS);
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
  const claudeHome = cleanFolder(source.claudeHome, "");
  return {
    agentsRoot: cleanFolder(source.agentsRoot, defaultAgentsRoot()),
    skillsRoot: cleanFolder(source.skillsRoot, defaultSkillsRoot(claudeHome)),
    skillScanRoots: cleanFolderList(source.skillScanRoots),
    skillMakerSeeding: SKILL_SEEDING_ANSWERS.includes(seeding) ? seeding : "unanswered",
    extraClaudeArguments: cleanExtraClaudeArguments(source.extraClaudeArguments),
    language: cleanLanguage(source.language),
    preambleExtra: cleanPreambleExtra(source.preambleExtra),
    claudeBinary: cleanFolder(source.claudeBinary, ""),
    claudeHome,
    onboarding: ONBOARDING_STATES.includes(source.onboarding) ? source.onboarding : "",
    ...cleanModSwitches(source),
    modGuardPatterns: cleanGuardPatterns(source.modGuardPatterns, DEFAULT_GUARD_PATTERNS)
  };
}

const COMPARED_KEYS = [
  "agentsRoot",
  "skillsRoot",
  "skillMakerSeeding",
  "extraClaudeArguments",
  "language",
  "preambleExtra",
  "claudeBinary",
  "claudeHome",
  "onboarding",
  ...MOD_SWITCH_KEYS,
  "modGuardPatterns"
];

function sameSettings(first, second) {
  return (
    COMPARED_KEYS.every((key) => first[key] === second[key]) &&
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
    const change = { ...(draft || {}) };
    // A skills folder that was only ever the default follows the Claude
    // folder when that moves; one the user chose stays where it is.
    if ("claudeHome" in change && !("skillsRoot" in change) && samePath(state.skillsRoot, defaultSkillsRoot(state.claudeHome))) {
      change.skillsRoot = defaultSkillsRoot(cleanFolder(change.claudeHome, ""));
    }
    const merged = sanitize({ ...state, ...change });
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
