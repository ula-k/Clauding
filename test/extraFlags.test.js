// CL-26 — the extra `claude` flags: how the field is split, which flags are
// refused, how the three levels merge, and where they end up on the command
// line (electron/lib/extraFlags.js, electron/lib/claudeArguments.js). Dry:
// nothing is spawned and no file is read.
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkExtraArguments,
  isReservedFlag,
  mergeExtraArguments,
  splitArguments
} from "../electron/lib/extraFlags.js";
import { EXTRA_FLAGS_PLACEHOLDER, buildClaudeArguments } from "../electron/lib/claudeArguments.js";
import { cleanExtraClaudeArguments } from "../electron/settings.js";

test("the field is split the way a shell would split it", () => {
  assert.deepEqual(splitArguments("--channels plugin:telegram"), ["--channels", "plugin:telegram"]);
  assert.deepEqual(splitArguments("   --model   sonnet  "), ["--model", "sonnet"]);
  assert.deepEqual(splitArguments(''), []);
  assert.deepEqual(splitArguments('--name "two words"'), ["--name", "two words"]);
  assert.deepEqual(splitArguments("--name 'two words'"), ["--name", "two words"]);
  assert.deepEqual(splitArguments("--path a\\ b"), ["--path", "a b"], "a backslash escapes a space");
  assert.deepEqual(splitArguments('--empty ""'), ["--empty", ""], "an empty quoted value is still a value");
});

test("the flags the app sets itself are the ones that cannot be typed", () => {
  for (const flag of ["--resume", "-p", "--print", "--output-format", "--system-prompt-snapshot"]) {
    assert.equal(isReservedFlag(flag), true, flag);
  }
  assert.equal(isReservedFlag("--append-system-prompt"), true);
  assert.equal(isReservedFlag("--append-system-prompt-file"), true);
  assert.equal(isReservedFlag("--output-format=json"), true, "the value may be attached with =");
  assert.equal(isReservedFlag("--model"), false);
  assert.equal(isReservedFlag("--channels"), false);
  assert.equal(isReservedFlag("--dangerously-skip-permissions"), false);
});

test("a reserved flag is refused by name instead of being silently dropped", () => {
  const refused = checkExtraArguments("--channels telegram --resume abc");
  assert.deepEqual(refused.reserved, ["--resume"]);
  assert.match(refused.message, /--resume/);
  assert.match(refused.message, /take it out/);
  const twoOfThem = checkExtraArguments("--print --output-format json");
  assert.deepEqual(twoOfThem.reserved, ["--print", "--output-format"]);
  assert.match(twoOfThem.message, /take them out/);
  const fine = checkExtraArguments("--channels plugin:telegram");
  assert.deepEqual(fine.reserved, []);
  assert.equal(fine.message, "");
});

test("the three levels merge global, then agent, then session", () => {
  assert.deepEqual(
    mergeExtraArguments(["--model sonnet", "--dangerously-skip-permissions", "--channels plugin:telegram"]),
    ["--model", "sonnet", "--dangerously-skip-permissions", "--channels", "plugin:telegram"]
  );
  assert.deepEqual(mergeExtraArguments(["", null, "--channels telegram"]), ["--channels", "telegram"]);
  assert.deepEqual(mergeExtraArguments([]), []);
});

test("a reserved flag in a file takes its value with it and never reaches the CLI", () => {
  assert.deepEqual(mergeExtraArguments(["--resume abc --model sonnet"]), ["--model", "sonnet"]);
  assert.deepEqual(mergeExtraArguments(["--model sonnet --print"]), ["--model", "sonnet"]);
  assert.deepEqual(mergeExtraArguments(["--output-format=json --channels telegram"]), ["--channels", "telegram"]);
  assert.equal(cleanExtraClaudeArguments("  --model   sonnet  --resume zzz "), "--model sonnet");
});

test("the flags go last, after everything the app needs for itself", () => {
  const { commandArguments } = buildClaudeArguments({
    resumeSessionId: "session-one",
    forkSession: true,
    sessionName: "a copy",
    appendedPrompt: "the preamble",
    promptFilePath: "/scratch/prompt.md",
    extraArguments: ["--channels", "plugin:telegram"]
  });
  assert.deepEqual(commandArguments, [
    "--resume",
    "session-one",
    "--fork-session",
    "--name",
    "a copy",
    "--append-system-prompt-file",
    "/scratch/prompt.md",
    "--system-prompt-snapshot",
    "off",
    "--channels",
    "plugin:telegram"
  ]);
  const guarded = buildClaudeArguments({ extraArguments: ["--print", "--model", "sonnet"] });
  assert.deepEqual(guarded.commandArguments, ["--model", "sonnet"], "a reserved flag is refused here too");
  const none = buildClaudeArguments({ sessionName: "plain" });
  assert.deepEqual(none.commandArguments, ["--name", "plain"], "no flags, no change");
});

// The bug this pins down: "I add any extra flags and the new session does not
// open." The command line was never the problem — these two strings, the ones
// Ula actually types, come out of the builder exactly as `claude` wants them,
// one token per word, the `@` and the `:` untouched, and after everything the
// app sets itself. What did go wrong was the value the field suggested
// (untagged, so the CLI refused it) and the pane disappearing with the CLI.
//
// Composed the way electron/terminals.js does it: the three levels merged,
// then the whole command line built.
function commandLineFor({ globalFlags = "", agentFlags = "", sessionFlags = "", appendedPrompt = "a preamble" } = {}) {
  return buildClaudeArguments({
    appendedPrompt,
    extraArguments: mergeExtraArguments([globalFlags, agentFlags, sessionFlags])
  }).commandArguments;
}

test("a new session with --model sonnet gets exactly that on its command line", () => {
  assert.deepEqual(commandLineFor({ sessionFlags: "--model sonnet" }), [
    "--append-system-prompt",
    "a preamble",
    "--system-prompt-snapshot",
    "off",
    "--model",
    "sonnet"
  ]);
});

test("the Telegram channel flag survives the builder token for token", () => {
  assert.deepEqual(commandLineFor({ sessionFlags: EXTRA_FLAGS_PLACEHOLDER }), [
    "--append-system-prompt",
    "a preamble",
    "--system-prompt-snapshot",
    "off",
    "--channels",
    "plugin:telegram@claude-plugins-official"
  ]);
});

test("the flags are never pasted together into one argument", () => {
  const commandArguments = commandLineFor({ sessionFlags: EXTRA_FLAGS_PLACEHOLDER });
  assert.ok(
    commandArguments.every((argument) => !/\s/.test(argument) || argument === "a preamble"),
    "one flag or value per argument, so no shell is needed to take them apart"
  );
});

test("all three levels land in order, with nothing merged or dropped", () => {
  assert.deepEqual(
    commandLineFor({
      globalFlags: "--model sonnet",
      agentFlags: "--dangerously-skip-permissions",
      sessionFlags: EXTRA_FLAGS_PLACEHOLDER
    }),
    [
      "--append-system-prompt",
      "a preamble",
      "--system-prompt-snapshot",
      "off",
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
      "--channels",
      "plugin:telegram@claude-plugins-official"
    ]
  );
});
