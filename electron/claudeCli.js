// Where the Claude Code CLI lives and what environment it should get when the
// app spawns it in a terminal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const localClaudeBinary = path.join(os.homedir(), ".local", "bin", "claude");

// A Dock-launched app inherits a minimal PATH; the CLI (and the tools it
// spawns: git, node, brew-installed binaries) need the usual shell folders.
export function ensureShellPath() {
  const extraFolders = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  const currentFolders = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const missing = extraFolders.filter((folder) => !currentFolders.includes(folder));
  process.env.PATH = missing.concat(currentFolders).join(path.delimiter);
}

// ~/.local/bin/claude when it exists (the same binary as in the terminal),
// otherwise whatever `claude` resolves to on PATH.
export function claudeExecutablePath() {
  return fs.existsSync(localClaudeBinary) ? localClaudeBinary : "claude";
}

// Variables a Claude Code process exports into its own child shells. When
// Clauding is itself started from inside a Claude session, inheriting them
// makes the CLI think it is a nested child ("Transcript saving is off") and
// it skips its registry entry — so they never reach the pty.
const NESTED_SESSION_VARIABLE = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_JOB_DIR$|CLAUDE_EFFORT$|AI_AGENT$)/;

// `sourceEnvironment` is the app's own environment; it is a parameter only so
// the dry tests can hand in one of their own instead of the real process.
export function terminalEnvironment(sourceEnvironment = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    if (typeof value === "string" && !NESTED_SESSION_VARIABLE.test(name)) {
      environment[name] = value;
    }
  }
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  environment.TERM_PROGRAM = "Clauding";
  if (!environment.LANG) {
    environment.LANG = "en_US.UTF-8";
  }
  return environment;
}

// Does this CLI accept `--append-system-prompt-file <path>`? An agent's
// definition plus the preamble is far too long for a command line argument
// that shows up in `ps`, so the combined text goes into a file when the flag
// exists and is inlined when it does not.
//
// `claude --help` is no help here: the flag has no option line of its own,
// it is only mentioned inside the --bare paragraph as
// "--append-system-prompt[-file]". So it is probed instead — put in front of
// the `mcp` subcommand, which prints its usage and exits at once, while an
// option the CLI does not know makes it answer "unknown option" first.
// The answer is the same for the life of the app, so it is asked once.
let appendSystemPromptFileSupport = null;

export function supportsAppendSystemPromptFile(probeFilePath) {
  if (appendSystemPromptFileSupport !== null) {
    return appendSystemPromptFileSupport;
  }
  let output = "";
  try {
    output = execFileSync(claudeExecutablePath(), ["--append-system-prompt-file", probeFilePath, "mcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000
    });
  } catch (error) {
    // `claude mcp` without a subcommand prints its usage and exits 1, so
    // landing here is the normal case; only the text matters.
    output = `${(error && error.stdout) || ""}${(error && error.stderr) || ""}`;
    if (!output) {
      appendSystemPromptFileSupport = false;
      return false;
    }
  }
  appendSystemPromptFileSupport = !/unknown option/i.test(output);
  return appendSystemPromptFileSupport;
}
