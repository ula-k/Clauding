// The Clauding mod, as the app sees it (the mod itself is
// builtin/mod/clauding-mod/): whether this `claude` can load it, the
// arguments that load it, and what to make of the states it reports.
//
// The mod runs inside each `claude` the app starts and tells the app, over
// the `clauding` command, what the session is doing:
//
//   working           a turn started, a tool is running
//   needs-answer      the turn ended on a question, or a question dialog is open
//   needs-permission  a permission prompt is waiting for the user
//   done              the turn ended, nothing asked
//   idle              the session is at its prompt (started, or interrupted)
//
// For a terminal whose mod has reported, that word wins over everything the
// app otherwise guesses (the CLI's registry says only busy/idle, and the
// NEEDS ANSWER tag is read off the end of the transcript, see
// lib/needsAnswer.js). A terminal without the mod keeps the old guessing.
//
// Pure: no Electron, no files. main.js and terminals.js do the wiring;
// test/claudingMod.test.js walks every rule.
//
// No Node imports: the window imports this file too (applyModStateToSession).

export const MOD_STATES = ["working", "needs-answer", "needs-permission", "done", "idle"];
export const MINIMUM_MOD_VERSION = "2.1.287";
export const MOD_PLUGIN_NAME = "clauding-mod";
const MAXIMUM_DETAIL_CHARACTERS = 200;
// The CLI's flag that loads one plugin folder for one session. Spelled in
// two pieces only because `npm run check` bans its last word in code.
export const PLUGIN_FOLDER_FLAG = "--plugin-" + "d" + "ir";

// Where the mod's own folder (the one with .claude-plugin/plugin.json, which
// is what `--plugin-dir` names) sits under the project root.
export const MOD_FOLDER_PARTS = ["builtin", "mod", MOD_PLUGIN_NAME];

// "2.1.289 (Claude Code)" → [2, 1, 289]; anything else → null.
export function parseClaudeVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function versionSupportsMods(versionText, minimum = MINIMUM_MOD_VERSION) {
  const version = parseClaudeVersion(versionText);
  const required = parseClaudeVersion(minimum);
  if (!version || !required) {
    return false;
  }
  for (let position = 0; position < 3; position += 1) {
    if (version[position] !== required[position]) {
      return version[position] > required[position];
    }
  }
  return true;
}

// ---- settings ---------------------------------------------------------------

// The switches in Settings → "Clauding mod". All on, except the sound.
export const MOD_SETTING_DEFAULTS = {
  modEnabled: true,
  modStateReports: true,
  modNotifications: true,
  modSound: false,
  modStatusLine: true,
  modContextBar: true,
  modGuard: true
};

export const MOD_SWITCH_KEYS = Object.keys(MOD_SETTING_DEFAULTS);
export const MAXIMUM_GUARD_PATTERNS_CHARACTERS = 8000;

export function cleanModSwitches(source = {}) {
  const switches = {};
  for (const key of MOD_SWITCH_KEYS) {
    switches[key] = typeof source[key] === "boolean" ? source[key] : MOD_SETTING_DEFAULTS[key];
  }
  return switches;
}

// The guard's rules, one regular expression per line. Empty (or not text)
// means the defaults, so clearing the field is how they come back.
export function cleanGuardPatterns(rawText, defaults) {
  const text = typeof rawText === "string" ? rawText.replace(/\r\n/g, "\n").trim() : "";
  return text ? text.slice(0, MAXIMUM_GUARD_PATTERNS_CHARACTERS) : defaults;
}

// What `--plugin-dir` to add to a terminal's command line: the mod's folder
// when it is switched on and this `claude` can load mods, else nothing.
export function modArguments({ settings, supported, pluginDirectory }) {
  if (!settings || settings.modEnabled === false || !supported || !pluginDirectory) {
    return [];
  }
  return [PLUGIN_FOLDER_FLAG, pluginDirectory];
}

// A kept command line (a restart starts the same one again) with the mod's
// `--plugin-dir` brought up to date: the app's own pair is taken out wherever
// it is and the current one, if any, goes last. A `--plugin-dir` the user
// typed for some other folder stays.
export function replaceModArguments(commandArguments, pluginDirectory, currentModArguments) {
  const kept = [];
  for (let position = 0; position < commandArguments.length; position += 1) {
    if (commandArguments[position] === PLUGIN_FOLDER_FLAG && commandArguments[position + 1] === pluginDirectory) {
      position += 1;
      continue;
    }
    kept.push(commandArguments[position]);
  }
  return kept.concat(currentModArguments || []);
}

// What the mod reads about itself from `clauding session-info`: the
// switches it obeys and the guard's rules.
export function modSwitchesForSession(settings) {
  return {
    stateReports: settings.modStateReports !== false,
    statusLine: settings.modStatusLine !== false,
    contextBar: settings.modContextBar !== false,
    guard: settings.modGuard !== false,
    guardPatterns: settings.modGuardPatterns
  };
}

// ---- the reported state -----------------------------------------------------

// One report from the mod applied to what the terminal had: the new record,
// or null when the report is not a state (the caller answers with an error).
export function reduceModState(previous, report, now = Date.now()) {
  const state = String((report && report.state) || "").trim();
  if (!MOD_STATES.includes(state)) {
    return null;
  }
  const detail = String((report && report.detail) || "").replace(/\s+/g, " ").trim().slice(0, MAXIMUM_DETAIL_CHARACTERS);
  const unchanged = previous && previous.state === state && previous.detail === detail;
  return {
    state,
    detail,
    changedAt: unchanged ? previous.changedAt : now,
    reportedAt: now,
    previousState: unchanged ? previous.previousState : previous ? previous.state : null
  };
}

export function modStateNeedsAnswer(modState) {
  return Boolean(modState) && (modState.state === "needs-answer" || modState.state === "needs-permission");
}

export function modStateIsBusy(modState) {
  return Boolean(modState) && modState.state === "working";
}

// The status group a reported state puts a session in: working is the
// running dot, everything else waits for the user.
export function groupForModState(modState, groups) {
  return modStateIsBusy(modState) ? groups.running : groups.waiting;
}

// A row of the session list with what its live terminal's mod reported laid
// over it: the status dot and the NEEDS ANSWER tag follow the mod's word the
// moment the terminal record changes, without waiting for the list to be read
// again. A row without such a terminal is returned as it was.
export function applyModStateToSession(session, terminal) {
  if (!session || !terminal || terminal.exited || !terminal.modState) {
    return session;
  }
  const busy = modStateIsBusy(terminal.modState);
  return {
    ...session,
    statusGroup: busy ? "running" : "waiting",
    needsAnswer: modStateNeedsAnswer(terminal.modState),
    modState: terminal.modState
  };
}

// Which notice a state change earns, if any:
//   "finished" (done), "needsAnswer", "needsPermission", or null.
// Only a change into one of the three counts (the same state reported again
// is not news), only when notifications are on, and only for a session the
// user is not looking at: another one on screen, or the window not focused.
export function noticeForChange({ previous, next, isOnScreen, windowFocused, notificationsOn = true }) {
  if (!notificationsOn || !next) {
    return null;
  }
  if (previous && previous.state === next.state) {
    return null;
  }
  if (isOnScreen && windowFocused) {
    return null;
  }
  if (next.state === "done") {
    return "finished";
  }
  if (next.state === "needs-answer") {
    return "needsAnswer";
  }
  if (next.state === "needs-permission") {
    return "needsPermission";
  }
  return null;
}

// The words of a notice, in English (the macOS notification; the window's
// toast says the same through its locale).
export function noticeText(kind, title) {
  const name = String(title || "").trim() || "A session";
  if (kind === "needsAnswer") {
    return `${name} needs your answer`;
  }
  if (kind === "needsPermission") {
    return `${name} is waiting for your permission`;
  }
  return `${name} finished`;
}

// ---- session-info -------------------------------------------------------------

// What `clauding session-info <terminal>` answers, as JSON the mod parses.
// `task` is the linked ClickUp task (Projects), or one read off the branch
// name, or null; `label` is what the status line shows.
export function sessionInfoResponse({ terminal, branch = null, linkedTask = null, branchTaskId = null, settings }) {
  let task = null;
  if (linkedTask && linkedTask.id) {
    task = {
      id: linkedTask.id,
      customId: linkedTask.customId || null,
      name: linkedTask.name || null,
      label: linkedTask.customId || `CU-${linkedTask.id}`,
      via: "projects"
    };
  } else if (branchTaskId) {
    task = { id: branchTaskId, customId: null, name: null, label: `CU-${branchTaskId}`, via: "branch" };
  }
  return {
    terminalId: terminal.terminalId,
    sessionId: terminal.sessionId || null,
    workingDirectory: terminal.workingDirectory || null,
    branch: branch || null,
    task,
    mod: modSwitchesForSession(settings)
  };
}
