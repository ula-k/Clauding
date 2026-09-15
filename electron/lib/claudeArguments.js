// The pure part of "how the app starts the Claude Code CLI": the argument
// list and the environment of a terminal. electron/terminals.js decides the
// values (which session to resume, whether the prompt went into a file) and
// then spawns the pty with what these two functions return, so the shape of
// the command line can be checked without a pty and without a `claude`.
import path from "node:path";

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
// `agent` is only read for the fallback display name; the prompt text itself
// is built by the caller (buildAgentSystemPrompt in electron/agents.js).
export function buildClaudeArguments({
  resumeSessionId = null,
  forkSession = false,
  sessionName = null,
  agent = null,
  appendedPrompt = "",
  promptFilePath = null
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
  return { commandArguments, displayName };
}

// The environment of one terminal: whatever terminalEnvironment() left of the
// app's own environment, plus this terminal's id (the `clauding` command
// reads it) and the folder holding that command in front of PATH.
export function buildTerminalEnvironment({ baseEnvironment, terminalId, commandDirectory = null }) {
  const environment = { ...baseEnvironment };
  environment.CLAUDING_TERMINAL_ID = terminalId;
  if (commandDirectory) {
    environment.PATH = [commandDirectory, environment.PATH || ""].filter(Boolean).join(path.delimiter);
  }
  return environment;
}
