// Where the Claude Code CLI lives and what environment it should get when the
// app spawns it in a terminal.
//
// On Windows the same three questions have different answers: the binary is
// `claude.exe` or `claude.cmd`, PATH is searched with `where` rather than by
// letting the spawn resolve a bare name, and a `.cmd` cannot be handed to a
// pty directly — it is a batch file and needs `cmd.exe /c` in front of it.
// `spawnPlanFor()` is the one place that decides which of those it is.
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  claudeBinaryCandidates,
  claudeBinaryNamesOnPath,
  isWindows,
  pathListSeparator,
  shellPathFolders
} from "./lib/platformPaths.js";

// A Dock-launched app (and a Start Menu one) inherits a minimal PATH; the CLI
// and the tools it spawns need the usual folders.
export function ensureShellPath({
  platform = process.platform,
  homeDirectory = os.homedir(),
  environment = process.env
} = {}) {
  const separator = pathListSeparator(platform);
  const extraFolders = shellPathFolders({ platform, homeDirectory });
  const currentFolders = String(environment.PATH || "").split(separator).filter(Boolean);
  const alreadyThere = isWindows(platform)
    ? currentFolders.map((folder) => folder.toLowerCase())
    : currentFolders;
  const missing = extraFolders.filter((folder) =>
    isWindows(platform) ? !alreadyThere.includes(folder.toLowerCase()) : !alreadyThere.includes(folder)
  );
  environment.PATH = missing.concat(currentFolders).join(separator);
  return environment.PATH;
}

// `where claude.exe` on Windows, `command -v claude` elsewhere. Only the
// first line matters: `where` prints one path per match.
function lookUpOnPath(name, platform) {
  try {
    const output = isWindows(platform)
      ? execFileSync("where", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      : execFileSync("command", ["-v", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const firstLine = String(output || "").split(/\r?\n/).find((line) => line.trim() !== "");
    return firstLine ? firstLine.trim() : "";
  } catch (error) {
    return "";
  }
}

// CLAUDING_CLAUDE_BIN wins over everything: it is how a second install, a
// version manager or a wrapper script is pointed at without touching PATH.
// After that, ~/.local/bin/claude (claude.exe, then claude.cmd, on Windows),
// and finally whatever PATH says. On macOS the bare name "claude" is returned
// when nothing was found, because the spawn resolves it; on Windows a bare
// name is not enough for a pty, so the PATH lookup is done here.
export function claudeExecutablePath({
  platform = process.platform,
  homeDirectory = os.homedir(),
  environment = process.env,
  fileExists = (candidate) => fs.existsSync(candidate),
  findOnPath = (name) => lookUpOnPath(name, platform)
} = {}) {
  const chosen = String(environment.CLAUDING_CLAUDE_BIN || "").trim();
  if (chosen) {
    return chosen;
  }
  for (const candidate of claudeBinaryCandidates({ platform, homeDirectory })) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  for (const name of claudeBinaryNamesOnPath(platform)) {
    const found = findOnPath(name);
    if (found) {
      return found;
    }
  }
  return isWindows(platform) ? "claude.cmd" : "claude";
}

// A batch file is not a program: Windows can only run it through the command
// interpreter, and node-pty hands its argument list straight to CreateProcess.
// So a `.cmd` (or `.bat`) is wrapped, and everything else is spawned as it is.
export function spawnPlanFor(executablePath, commandArguments = [], platform = process.platform) {
  const wanted = String(executablePath || "");
  if (isWindows(platform) && /\.(cmd|bat)$/i.test(wanted)) {
    const interpreter = process.env.COMSPEC || "cmd.exe";
    return {
      file: interpreter,
      commandArguments: ["/c", wanted].concat(commandArguments),
      throughCommandInterpreter: true
    };
  }
  return { file: wanted, commandArguments: commandArguments.slice(), throughCommandInterpreter: false };
}

// The pty options that differ between the two systems. ConPTY is the Windows
// pseudo-console node-pty builds on; without it node-pty falls back to
// winpty, which needs a helper binary the prebuilt package does not ship.
export function ptyOptionsFor(platform = process.platform) {
  return isWindows(platform) ? { useConpty: true } : {};
}

// Variables a Claude Code process exports into its own child shells. When
// Clauding is itself started from inside a Claude session, inheriting them
// makes the CLI think it is a nested child ("Transcript saving is off") and
// it skips its registry entry — so they never reach the pty.
const NESTED_SESSION_VARIABLE = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_JOB_DIR$|CLAUDE_EFFORT$|AI_AGENT$)/;

// `sourceEnvironment` is the app's own environment; it is a parameter only so
// the dry tests can hand in one of their own instead of the real process.
// TERM and COLORTERM are set on Windows too: ConPTY understands the escape
// sequences, and a program that ignores the variables is none the worse.
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
  const plan = spawnPlanFor(claudeExecutablePath(), ["--append-system-prompt-file", probeFilePath, "mcp"]);
  let output = "";
  try {
    output = execFileSync(plan.file, plan.commandArguments, {
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
