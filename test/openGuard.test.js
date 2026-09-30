// One conversation, one `claude`. After an app restart the same session was
// resumed twice at once — two processes writing into one transcript. The
// decision (electron/lib/openGuard.js) is checked on its own, and then the
// real terminal registry in dry-run mode (CLAUDING_DRY_SPAWN=1: everything
// but the spawn) is asked to open the same session twice in a row.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resumeOpenDecision } from "../electron/lib/openGuard.js";

// The registry reads ~/.claude/sessions for the "running elsewhere" check;
// the test gets a folder of its own, set before terminals.js is loaded.
const claudeFolder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-open-guard-"));
fs.mkdirSync(path.join(claudeFolder, "sessions"), { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeFolder;
process.env.CLAUDING_DRY_SPAWN = "1";
const { createTerminalRegistry } = await import("../electron/terminals.js");

function quietRegistry() {
  return createTerminalRegistry({ sendToWindow() {}, log: null });
}

test("a session nobody has is spawned; a fork always is", () => {
  assert.deepEqual(resumeOpenDecision({ sessionId: "abc", records: [], registryEntries: [] }), { action: "spawn" });
  assert.deepEqual(resumeOpenDecision({ sessionId: null }), { action: "spawn" }, "a new session has no id yet");
  const owner = { terminalId: "t1", sessionId: "abc", pid: 11, exited: false };
  assert.deepEqual(resumeOpenDecision({ sessionId: "abc", forkSession: true, records: [owner] }), { action: "spawn" });
});

test("a session one of the app's terminals has is shown, not started again", () => {
  const owner = { terminalId: "t1", sessionId: "abc", pid: 11, exited: false };
  assert.deepEqual(resumeOpenDecision({ sessionId: "abc", records: [owner] }), { action: "show", terminalId: "t1" });
  const ended = { ...owner, exited: true };
  assert.deepEqual(resumeOpenDecision({ sessionId: "abc", records: [ended] }), { action: "restart", terminalId: "t1" });
});

test("a terminal the app is hanging up on purpose does not own the session", () => {
  // The restart behind "Assign to agent" and "Extra claude flags…": close,
  // then open the same session — the open is the replacement.
  const leaving = { terminalId: "t1", sessionId: "abc", pid: 11, exited: false, closingOnPurpose: true };
  const entries = [{ sessionId: "abc", pid: 11, alive: true }];
  assert.deepEqual(resumeOpenDecision({ sessionId: "abc", records: [leaving], registryEntries: entries }), { action: "spawn" });
});

test("a live claude outside the app is refused; a dead registry entry is not", () => {
  const live = [{ sessionId: "abc", pid: 4242, alive: true }];
  assert.deepEqual(resumeOpenDecision({ sessionId: "abc", records: [], registryEntries: live }), {
    action: "refuse",
    reason: "running-elsewhere",
    pid: 4242
  });
  const stale = [{ sessionId: "abc", pid: 4242, alive: false }];
  assert.deepEqual(resumeOpenDecision({ sessionId: "abc", records: [], registryEntries: stale }), { action: "spawn" });
});

test("two rapid opens of the same session start one terminal", () => {
  const registry = quietRegistry();
  const first = registry.open({ workingDirectory: os.tmpdir(), resumeSessionId: "session-twice" });
  const second = registry.open({ workingDirectory: os.tmpdir(), resumeSessionId: "session-twice" });
  assert.equal(second.terminalId, first.terminalId, "the second click shows the first terminal");
  assert.equal(second.reused, true);
  assert.equal(registry.list().length, 1, "exactly one terminal, so exactly one claude");
  registry.closeAll();
});

test("a fork of an open session still gets a terminal of its own", () => {
  const registry = quietRegistry();
  const original = registry.open({ workingDirectory: os.tmpdir(), resumeSessionId: "session-forked" });
  const fork = registry.open({ workingDirectory: os.tmpdir(), resumeSessionId: "session-forked", forkSession: true });
  assert.notEqual(fork.terminalId, original.terminalId);
  assert.equal(registry.list().length, 2);
  registry.closeAll();
});

test("a session a claude outside the app runs is refused by the registry", () => {
  // This test process stands in for the other `claude`: alive, not ours.
  fs.writeFileSync(
    path.join(claudeFolder, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "session-elsewhere", cwd: os.tmpdir(), startedAt: Date.now() })
  );
  const registry = quietRegistry();
  const result = registry.open({ workingDirectory: os.tmpdir(), resumeSessionId: "session-elsewhere" });
  assert.equal(result.refused, true);
  assert.equal(result.reason, "running-elsewhere");
  assert.equal(registry.list().length, 0, "nothing was spawned");
  fs.rmSync(path.join(claudeFolder, "sessions", `${process.pid}.json`));
});
