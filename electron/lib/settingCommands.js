// `clauding settings get|set`: which settings a session may change, and
// what counts as a valid value for each. Pure — the file checks are handed
// in — so test/setupCommands.test.js can walk every rule without a disk.
//
// The whitelist is short on purpose. Everything else in settings.json (the
// first-run answer about the skills, the onboarding flag) has a command of
// its own that says what it means.
import path from "node:path";
import { checkExtraArguments } from "./extraFlags.js";
import { expandHomeFolder } from "./platformPaths.js";

export const SETTABLE_KEYS = [
  "language",
  "agentsRoot",
  "skillsRoot",
  "preambleExtra",
  "claudeBinary",
  "claudeHome",
  "skillScanRoots",
  "extraClaudeArguments"
];

export const LANGUAGE_CODES = ["en", "pl", "es", "zh-CN"];
export const MAXIMUM_PREAMBLE_EXTRA_CHARACTERS = 4000;
// Words that put a setting back to "find it yourself".
const AUTOMATIC_WORDS = ["", "auto", "automatic", "default", "system", "none"];

function isAutomatic(text) {
  return AUTOMATIC_WORDS.includes(String(text || "").trim().toLowerCase());
}

function absoluteFolder(rawValue, { homeDirectory }) {
  const expanded = expandHomeFolder(String(rawValue || "").trim(), { homeDirectory });
  if (!path.isAbsolute(expanded)) {
    throw new Error(`"${rawValue}" is not an absolute path (start it with / or ~/).`);
  }
  return path.normalize(expanded);
}

// "a, b" / "a:b" / '["a","b"]' → list of absolute folders.
function folderList(rawValue, options) {
  const text = String(rawValue || "").trim();
  if (isAutomatic(text)) {
    return [];
  }
  let entries;
  if (text.startsWith("[")) {
    try {
      entries = JSON.parse(text);
    } catch (error) {
      throw new Error("the list is not valid JSON.");
    }
    if (!Array.isArray(entries)) {
      throw new Error("expected a JSON list of folders.");
    }
  } else {
    entries = text.split(/[,\n]/);
  }
  return entries.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => absoluteFolder(entry, options));
}

// → { key, draft (what settings.update gets), shown (for the reply line) }.
// Throws an Error whose message is the reason, in one sentence.
export function parseSettingValue(key, rawValue, {
  homeDirectory,
  isDirectory = () => true,
  isExecutableFile = () => true
} = {}) {
  if (!SETTABLE_KEYS.includes(key)) {
    throw new Error(`"${key}" is not a setting this command changes. It changes: ${SETTABLE_KEYS.join(", ")}.`);
  }
  const text = rawValue === undefined || rawValue === null ? "" : String(rawValue);
  const options = { homeDirectory };
  if (key === "language") {
    if (isAutomatic(text)) {
      return { key, draft: { language: "" }, shown: "the system language" };
    }
    const code = LANGUAGE_CODES.find((candidate) => candidate.toLowerCase() === text.trim().toLowerCase());
    if (!code) {
      throw new Error(`"${text}" is not one of the window's languages (${LANGUAGE_CODES.join(", ")}, or "system").`);
    }
    return { key, draft: { language: code }, shown: code };
  }
  if (key === "agentsRoot" || key === "skillsRoot") {
    const folder = absoluteFolder(text, options);
    return { key, draft: { [key]: folder }, shown: folder };
  }
  if (key === "claudeHome") {
    if (isAutomatic(text)) {
      return { key, draft: { claudeHome: "" }, shown: "automatic (~/.claude)" };
    }
    const folder = absoluteFolder(text, options);
    if (!isDirectory(folder)) {
      throw new Error(`there is no folder at ${folder}.`);
    }
    return { key, draft: { claudeHome: folder }, shown: folder };
  }
  if (key === "claudeBinary") {
    if (isAutomatic(text)) {
      return { key, draft: { claudeBinary: "" }, shown: "automatic (~/.local/bin/claude, then PATH)" };
    }
    const binary = absoluteFolder(text, options);
    if (!isExecutableFile(binary)) {
      throw new Error(`${binary} is not an executable file.`);
    }
    return { key, draft: { claudeBinary: binary }, shown: binary };
  }
  if (key === "skillScanRoots") {
    const folders = folderList(text, options);
    const missing = folders.filter((folder) => !isDirectory(folder));
    if (missing.length > 0) {
      throw new Error(`there is no folder at ${missing.join(", ")}.`);
    }
    return { key, draft: { skillScanRoots: folders }, shown: folders.length > 0 ? folders.join(", ") : "none" };
  }
  if (key === "preambleExtra") {
    const extra = text.replace(/\r\n/g, "\n").trim();
    if (extra.length > MAXIMUM_PREAMBLE_EXTRA_CHARACTERS) {
      throw new Error(`the text is ${extra.length} characters long; the most is ${MAXIMUM_PREAMBLE_EXTRA_CHARACTERS}.`);
    }
    return { key, draft: { preambleExtra: extra }, shown: extra ? `${extra.length} characters` : "empty" };
  }
  // extraClaudeArguments
  const flags = text.replace(/\s+/g, " ").trim();
  const checked = checkExtraArguments(flags);
  if (checked.reserved.length > 0) {
    throw new Error(checked.message);
  }
  return { key, draft: { extraClaudeArguments: flags }, shown: flags || "none" };
}

// What `clauding settings get` prints: the settable keys with their stored
// values, and what is actually in use where "automatic" was stored.
export function describeSettings(settings, effective = {}) {
  const described = {};
  for (const key of SETTABLE_KEYS) {
    described[key] = settings[key] === undefined ? null : settings[key];
  }
  described.onboarding = settings.onboarding || "";
  described.skillMakerSeeding = settings.skillMakerSeeding || "unanswered";
  described.inUse = {
    claudeBinary: effective.claudeBinary || null,
    claudeHome: effective.claudeHome || null,
    claudeHomeFrom: effective.claudeHomeOrigin || null,
    language: settings.language || "system"
  };
  return described;
}

// `settings get <key>`: one value, printed as it is (a list as JSON).
export function describeOneSetting(settings, key, effective = {}) {
  if (!SETTABLE_KEYS.includes(key) && key !== "onboarding") {
    throw new Error(`"${key}" is not a setting. Settings: ${SETTABLE_KEYS.join(", ")}, onboarding.`);
  }
  const stored = settings[key];
  if (Array.isArray(stored)) {
    return JSON.stringify(stored);
  }
  if ((key === "claudeBinary" || key === "claudeHome") && !stored) {
    return `${effective[key] || ""} (automatic)`.trim();
  }
  if (key === "language" && !stored) {
    return "system";
  }
  return String(stored === undefined || stored === null ? "" : stored);
}
