// CL-07, CL-09, CL-13, CL-15 — the command line and the environment the app
// gives a terminal (electron/lib/claudeArguments.js, electron/claudeCli.js),
// and the name a fork is started under (src/renderer/forkName.js).
//
// Nothing is spawned here: the argument list is built and read back, so no
// `claude` runs and no pty is created.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildClaudeArguments,
  buildTerminalEnvironment,
  cleanSessionDisplayName
} from "../electron/lib/claudeArguments.js";
import { terminalEnvironment } from "../electron/claudeCli.js";
import { forkDisplayName, FORK_NAME_MAX_LENGTH, FORK_NAME_SUFFIX } from "../src/renderer/forkName.js";

const AGENT = { id: "agent-one", name: "Spec Writer", emoji: "📐" };

function valueAfter(commandArguments, flag) {
  const position = commandArguments.indexOf(flag);
  return position === -1 ? null : commandArguments[position + 1];
}

test("a brand-new session is started with nothing but its appended prompt", () => {
  const { commandArguments } = buildClaudeArguments({ appendedPrompt: "PREAMBLE" });
  assert.deepEqual(commandArguments, ["--append-system-prompt", "PREAMBLE", "--system-prompt-snapshot", "off"]);
});

test("a click on a row resumes exactly that session", () => {
  const { commandArguments } = buildClaudeArguments({ resumeSessionId: "session-one", appendedPrompt: "PREAMBLE" });
  assert.equal(commandArguments[0], "--resume");
  assert.equal(commandArguments[1], "session-one");
  assert.equal(commandArguments.includes("--fork-session"), false);
});

test("a fork resumes the original and asks for a copy under its own name", () => {
  const { commandArguments } = buildClaudeArguments({
    resumeSessionId: "session-one",
    forkSession: true,
    sessionName: "Onboarding (fork)",
    appendedPrompt: "PREAMBLE"
  });
  assert.equal(valueAfter(commandArguments, "--resume"), "session-one");
  assert.ok(commandArguments.includes("--fork-session"));
  assert.equal(valueAfter(commandArguments, "--name"), "Onboarding (fork)");
  assert.equal(commandArguments.indexOf("--resume") < commandArguments.indexOf("--fork-session"), true);
});

test("the prompt goes into a file when the CLI takes one, and inline when it does not", () => {
  const withFile = buildClaudeArguments({
    appendedPrompt: "A very long agent definition",
    promptFilePath: "/somewhere/prompts/terminal-one.md"
  }).commandArguments;
  assert.equal(valueAfter(withFile, "--append-system-prompt-file"), "/somewhere/prompts/terminal-one.md");
  assert.equal(withFile.includes("--append-system-prompt"), false, "the text itself never reaches the command line");

  const inline = buildClaudeArguments({ appendedPrompt: "A very long agent definition" }).commandArguments;
  assert.equal(valueAfter(inline, "--append-system-prompt"), "A very long agent definition");
  assert.equal(inline.includes("--append-system-prompt-file"), false);
});

test("the prompt snapshot is switched off whenever something is appended", () => {
  for (const options of [
    { appendedPrompt: "PREAMBLE" },
    { appendedPrompt: "PREAMBLE", resumeSessionId: "session-one" },
    { appendedPrompt: "PREAMBLE", resumeSessionId: "session-one", forkSession: true },
    { appendedPrompt: "PREAMBLE", promptFilePath: "/somewhere/prompt.md" }
  ]) {
    const { commandArguments } = buildClaudeArguments(options);
    assert.equal(
      valueAfter(commandArguments, "--system-prompt-snapshot"),
      "off",
      "without this a resumed session never learns about the panel"
    );
  }
});

test("with nothing to append there is no snapshot flag either", () => {
  const { commandArguments } = buildClaudeArguments({ resumeSessionId: "session-one", appendedPrompt: "" });
  assert.deepEqual(commandArguments, ["--resume", "session-one"]);
});

test("a name the user typed wins over the agent's own", () => {
  assert.equal(valueAfter(buildClaudeArguments({ sessionName: "My name", agent: AGENT }).commandArguments, "--name"), "My name");
  assert.equal(valueAfter(buildClaudeArguments({ agent: AGENT }).commandArguments, "--name"), "📐 Spec Writer");
  assert.equal(buildClaudeArguments({}).commandArguments.includes("--name"), false);
  assert.equal(buildClaudeArguments({ sessionName: "   " }).commandArguments.includes("--name"), false);
});

test("a typed session name is tidied and capped", () => {
  assert.equal(cleanSessionDisplayName("  two    words \n"), "two words");
  assert.equal(cleanSessionDisplayName("x".repeat(500)).length, 120);
  assert.equal(cleanSessionDisplayName(null), "");
  assert.equal(cleanSessionDisplayName(42), "");
});

test("a fork is named after the original, with room kept for the marker", () => {
  assert.equal(forkDisplayName("Onboarding"), "Onboarding (fork)");
  assert.equal(forkDisplayName("  spaced   out  "), "spaced out (fork)");
  assert.equal(forkDisplayName(""), FORK_NAME_SUFFIX);

  const long = forkDisplayName("y".repeat(200));
  assert.equal(long.length, FORK_NAME_MAX_LENGTH);
  assert.ok(long.endsWith(`…${FORK_NAME_SUFFIX}`), "a title that does not fit is cut with an ellipsis");
  assert.ok(long.length <= 120, "and still fits what the CLI is given");
});

test("the terminal knows its own id, so `clauding` lands in the right panel", () => {
  const environment = buildTerminalEnvironment({
    baseEnvironment: { PATH: "/usr/bin" },
    terminalId: "terminal-one",
    commandDirectory: "/somewhere/clauding/bin"
  });
  assert.equal(environment.CLAUDING_TERMINAL_ID, "terminal-one");
});

test("the folder holding the `clauding` command goes in front of PATH", () => {
  const environment = buildTerminalEnvironment({
    baseEnvironment: { PATH: `/usr/bin${path.delimiter}/bin` },
    terminalId: "terminal-one",
    commandDirectory: "/somewhere/clauding/bin"
  });
  assert.equal(environment.PATH, `/somewhere/clauding/bin${path.delimiter}/usr/bin${path.delimiter}/bin`);

  const withoutFolders = buildTerminalEnvironment({ baseEnvironment: {}, terminalId: "terminal-one" });
  assert.equal(withoutFolders.PATH, undefined, "with no command folder PATH is left alone");
});

test("building the environment does not change the one it was given", () => {
  const base = { PATH: "/usr/bin" };
  buildTerminalEnvironment({ baseEnvironment: base, terminalId: "terminal-one", commandDirectory: "/bin/clauding" });
  assert.deepEqual(base, { PATH: "/usr/bin" });
});

test("the variables that would make the CLI think it is a nested session are dropped", () => {
  const environment = terminalEnvironment({
    PATH: "/usr/bin",
    HOME: "/Users/someone",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "1234",
    CLAUDE_PID: "999",
    CLAUDE_JOB_DIR: "/somewhere",
    CLAUDE_EFFORT: "high",
    AI_AGENT: "1",
    CLAUDE_CONFIG_DIR: "/Users/someone/.claude",
    ANTHROPIC_API_KEY: "kept"
  });
  assert.equal(environment.CLAUDECODE, undefined);
  assert.equal(environment.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(environment.CLAUDE_CODE_SSE_PORT, undefined);
  assert.equal(environment.CLAUDE_PID, undefined);
  assert.equal(environment.CLAUDE_JOB_DIR, undefined);
  assert.equal(environment.CLAUDE_EFFORT, undefined);
  assert.equal(environment.AI_AGENT, undefined);
  assert.equal(environment.HOME, "/Users/someone");
  assert.equal(environment.ANTHROPIC_API_KEY, "kept");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "/Users/someone/.claude", "only the nesting variables go");
});

test("the terminal is told it is a colour terminal inside Clauding", () => {
  const environment = terminalEnvironment({ PATH: "/usr/bin" });
  assert.equal(environment.TERM, "xterm-256color");
  assert.equal(environment.COLORTERM, "truecolor");
  assert.equal(environment.TERM_PROGRAM, "Clauding");
  assert.equal(environment.LANG, "en_US.UTF-8", "a missing LANG is filled in");
  assert.equal(terminalEnvironment({ LANG: "pl_PL.UTF-8" }).LANG, "pl_PL.UTF-8");
});

test("the real environment is only read, never changed", () => {
  const before = { ...process.env };
  terminalEnvironment();
  assert.deepEqual({ ...process.env }, before);
});
