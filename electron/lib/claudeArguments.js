// The pure part of "how the app starts the Claude Code CLI": the argument
// list and the environment of a terminal. electron/terminals.js decides the
// values (which session to resume, whether the prompt went into a file) and
// then spawns the pty with what these two functions return, so the shape of
// the command line can be checked without a pty and without a `claude`.
import path from "node:path";
import { isReservedFlag } from "./extraFlags.js";

export {
  EXTRA_FLAGS_PLACEHOLDER,
  RESERVED_FLAGS,
  checkExtraArguments,
  isReservedFlag,
  mergeExtraArguments,
  reservedFlagsIn,
  splitArguments
} from "./extraFlags.js";

const MAXIMUM_SESSION_NAME_LENGTH = 120;

export function cleanSessionDisplayName(rawName) {
  if (typeof rawName !== "string") {
    return "";
  }
  return rawName.replace(/\s+/g, " ").trim().slice(0, MAXIMUM_SESSION_NAME_LENGTH);
}

// The command line of one terminal:
//   --resume <id>                  when a session is being continued
//   --fork-session                 when that continuation is a copy
//   --name "<title>"               a name the user typed, or the agent's own
//   --append-system-prompt-file    the combined prompt when it went to a file
//   --append-system-prompt <text>  the same text inline when it did not
//   --system-prompt-snapshot off   always, whenever something is appended, so
//                                  a resumed session gets the preamble too
//   <the user's extra flags>
//   --plugin-dir <mod folder>      the Clauding mod, last, when it is on and
//                                  the CLI can load mods (lib/modState.js:
//                                  modArguments). Only the `claude` this app
//                                  starts gets it; nothing is installed.
// `agent` is only read for the fallback display name; the prompt text itself
// is built by the caller (buildAgentSystemPrompt in electron/agents.js).
export function buildClaudeArguments({
  resumeSessionId = null,
  forkSession = false,
  sessionName = null,
  agent = null,
  appendedPrompt = "",
  promptFilePath = null,
  extraArguments = [],
  pluginArguments = []
} = {}) {
  const commandArguments = resumeSessionId ? ["--resume", resumeSessionId] : [];
  if (forkSession) {
    commandArguments.push("--fork-session");
  }
  const typedName = cleanSessionDisplayName(sessionName);
  const displayName = typedName || (agent ? `${agent.emoji} ${agent.name}`.trim() : "");
  if (displayName) {
    commandArguments.push("--name", displayName);
  }
  if (appendedPrompt) {
    if (promptFilePath) {
      commandArguments.push("--append-system-prompt-file", promptFilePath);
    } else {
      commandArguments.push("--append-system-prompt", appendedPrompt);
    }
    commandArguments.push("--system-prompt-snapshot", "off");
  }
  // The user's own flags go last, after everything the app needs, and never
  // include one of the app's own (see mergeExtraArguments).
  for (const token of extraArguments || []) {
    if (typeof token === "string" && token !== "" && !isReservedFlag(token)) {
      commandArguments.push(token);
    }
  }
  commandArguments.push(...(pluginArguments || []));
  return { commandArguments, displayName };
}

// The environment of one terminal: whatever terminalEnvironment() left of the
// app's own environment, plus this terminal's id (the `clauding` command
// reads it) and the folder holding that command in front of PATH.
//
// CLAUDE_CODE_DISABLE_AGENT_VIEW=1 rides along with every `claude` the app
// starts (new, resume, fork, kickoff). Without it the CLI's agent view is
// on: ← on an empty prompt, Ctrl+Z or Ctrl+C twice sends the session to the
// CLI's background daemon under a new id (lib/continuedIn.js) — the
// conversation then vanished from the list and its agent link pointed at a
// stale copy. Clauding keeps its sessions itself. The environment variable,
// not `--settings`, because `--settings` makes a `--resume` refuse to attach
// to a session that is already alive in the daemon.
export const DISABLE_AGENT_VIEW_VARIABLE = "CLAUDE_CODE_DISABLE_AGENT_VIEW";

//
// The one exception is `attachToBackground`: a terminal opened onto a
// session that is already alive in the daemon. With the variable set the CLI
// refuses that attach ("'attach' is disabled", and a `--resume` of it says
// "That session is running in the background"), so that terminal goes
// without it — it is a plain `claude --resume <id>`, nothing else.
export function buildTerminalEnvironment({ baseEnvironment, terminalId, commandDirectory = null, attachToBackground = false }) {
  const environment = { ...baseEnvironment };
  environment.CLAUDING_TERMINAL_ID = terminalId;
  if (attachToBackground) {
    delete environment[DISABLE_AGENT_VIEW_VARIABLE];
  } else {
    environment[DISABLE_AGENT_VIEW_VARIABLE] = "1";
  }
  if (commandDirectory) {
    environment.PATH = [commandDirectory, environment.PATH || ""].filter(Boolean).join(path.delimiter);
  }
  return environment;
}
