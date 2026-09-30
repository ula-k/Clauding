// Ctrl+Z in a Clauding terminal: Claude Code suspends itself on it, and with
// no shell in the pane there is no `fg` to bring it back. Two belts, both
// checked here without a pty: the key never reaches the CLI (it becomes the
// CLI's own undo), and a stopped process is recognised so the main process
// can continue it (electron/lib/suspendWatch.js).
import test from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_UNDO_INPUT, terminalKeyDecision } from "../src/renderer/terminalKeys.js";
import {
  isStoppedState,
  parseProcessStates,
  processStateCommand,
  suspendDecision,
  scanForSuspendMessage,
  MESSAGE_SETTLE_MILLISECONDS,
  suspendNoticeText
} from "../electron/lib/suspendWatch.js";
import { applicationMenuTemplate } from "../electron/lib/applicationMenu.js";

const keyDown = (key, modifiers = {}) => ({ type: "keydown", key, code: `Key${key.toUpperCase()}`, ...modifiers });

test("Ctrl+Z becomes Claude Code's undo instead of a suspend, on both systems", () => {
  assert.equal(CLAUDE_UNDO_INPUT, "\x1f", "Ctrl+_ is the byte 0x1f, not Ctrl+Z's 0x1a");
  for (const platform of ["darwin", "win32"]) {
    assert.equal(terminalKeyDecision(keyDown("z", { ctrlKey: true }), platform), "undo-instead-of-suspend");
    assert.equal(terminalKeyDecision(keyDown("Z", { ctrlKey: true, shiftKey: true }), platform), "undo-instead-of-suspend");
    assert.equal(
      terminalKeyDecision({ type: "keyup", key: "z", ctrlKey: true }, platform),
      "swallow",
      "the rest of the same stroke does not slip through"
    );
  }
});

test("⌘Z on macOS is left to the Edit menu, which types the same undo", () => {
  assert.equal(terminalKeyDecision(keyDown("z", { metaKey: true }), "darwin"), "leave-to-menu");
  const undo = applicationMenuTemplate({ platform: "darwin", onUndo: () => {} })[1].submenu[0];
  assert.equal(undo.role, undefined, "a handler, not the plain role");
  assert.equal(undo.accelerator, "CommandOrControl+Z");
  const windowsUndo = applicationMenuTemplate({ platform: "win32", onUndo: () => {} })[1].submenu[0];
  assert.equal(windowsUndo.role, "undo", "Windows keeps the role; Ctrl+Z there goes through the key handler");
});

test("every other key is untouched", () => {
  assert.equal(terminalKeyDecision(keyDown("z"), "darwin"), "pass-to-terminal", "a plain z types a z");
  assert.equal(terminalKeyDecision(keyDown("z", { ctrlKey: true, altKey: true }), "darwin"), "pass-to-terminal");
  assert.equal(terminalKeyDecision(keyDown("c", { ctrlKey: true }), "darwin"), "pass-to-terminal", "Ctrl+C stays the interrupt");
  assert.equal(terminalKeyDecision(keyDown("d", { ctrlKey: true }), "darwin"), "pass-to-terminal");
  assert.equal(terminalKeyDecision(keyDown("k", { metaKey: true }), "darwin"), "clear");
  assert.equal(terminalKeyDecision(keyDown("v", { metaKey: true }), "darwin"), "leave-to-menu");
  assert.equal(terminalKeyDecision({ type: "keydown", key: "Enter" }, "darwin"), "pass-to-terminal");
});

test("the Terminal menu has the two ways out, on both systems", () => {
  for (const platform of ["darwin", "win32"]) {
    const clicked = [];
    const template = applicationMenuTemplate({
      platform,
      onResumeSuspended: () => clicked.push("resume"),
      onRestartTerminal: () => clicked.push("restart")
    });
    const terminalMenu = template.find((menu) => menu.label === "Terminal");
    assert.ok(terminalMenu, `${platform} has a Terminal menu`);
    assert.deepEqual(
      terminalMenu.submenu.map((item) => item.label),
      ["Resume suspended session", "Restart terminal"]
    );
    terminalMenu.submenu.forEach((item) => item.click());
    assert.deepEqual(clicked, ["resume", "restart"]);
  }
});

test("one ps for all terminals, and nothing to ask when there are none", () => {
  assert.deepEqual(processStateCommand([101, 202]), { file: "ps", commandArguments: ["-o", "pid=,stat=", "-p", "101,202"] });
  assert.equal(processStateCommand([]), null);
  assert.equal(processStateCommand([0, null]), null, "a dry-run terminal has pid 0");
});

test("ps output is read into pid -> state, whatever the padding", () => {
  const states = parseProcessStates("  4101 Ss+\n 4202 T\n4303 T+\n\n");
  assert.equal(states.get(4101), "Ss+");
  assert.equal(states.get(4202), "T");
  assert.equal(states.get(4303), "T+");
  assert.equal(states.has(9999), false, "a pid ps did not list is gone, not stopped");
  assert.equal(parseProcessStates("").size, 0);
  assert.equal(parseProcessStates(undefined).size, 0);
});

test("only a stopped process (T) is continued; running, sleeping and traced are left alone", () => {
  assert.equal(isStoppedState("T"), true);
  assert.equal(isStoppedState("T+"), true);
  assert.equal(isStoppedState("Ts"), true);
  assert.equal(isStoppedState("S+"), false);
  assert.equal(isStoppedState("R"), false);
  assert.equal(isStoppedState("t"), false, "Linux's debugger stop is somebody's on purpose");
  assert.equal(isStoppedState(undefined), false);
});

test("the note is written once per suspension, SIGCONT on every look that finds it stopped", () => {
  assert.deepEqual(suspendDecision({ processState: "T+", wasStopped: false }), { stopped: true, resume: true, announce: true });
  assert.deepEqual(suspendDecision({ processState: "T+", wasStopped: true }), { stopped: true, resume: true, announce: false });
  assert.deepEqual(suspendDecision({ processState: "S+", wasStopped: true }), { stopped: false, resume: false, announce: false });
  assert.deepEqual(suspendDecision({ processState: undefined }), { stopped: false, resume: false, announce: false });
});

test("the note in the pane is one dim line", () => {
  const text = suspendNoticeText();
  assert.match(text, /Claude was suspended \(Ctrl\+Z\) — resumed automatically\./);
  assert.match(text, /\x1b\[2;37m/);
  assert.ok(text.endsWith("\x1b[0m\r\n"));
});

test("the CLI's own sentence counts as suspended, even split over two chunks", () => {
  // What CLI 2.1.x prints on Ctrl+Z, escape sequences and all; the process
  // itself is never stopped under a pty with no shell (orphaned group).
  const chunk = "\x1b(B\x1b[<u\r\nClaude Code has been suspended. Run `fg` to bring Claude Code back.\r\nNote: ctrl + z now suspends Claude Code, ctrl + _ undoes input.\r\n";
  assert.equal(scanForSuspendMessage("", chunk).suspended, true);
  const first = scanForSuspendMessage("", "\x1b[2mClaude Code has been susp");
  assert.equal(first.suspended, false);
  const second = scanForSuspendMessage(first.carriedText, "ended. Run `fg` to bring Claude Code back.");
  assert.equal(second.suspended, true);
  assert.equal(second.carriedText, "", "one sentence counts once");
  assert.equal(scanForSuspendMessage("", "everything is fine, run the tests").suspended, false);
});

test("the sentence is acted on after a short settle, then forgotten", () => {
  const seenAt = 10000;
  const tooSoon = suspendDecision({ processState: "S+", messageSeenAt: seenAt, now: seenAt + MESSAGE_SETTLE_MILLISECONDS - 1 });
  assert.equal(tooSoon.resume, false, "the CLI is still letting go of the screen");
  const settled = suspendDecision({ processState: "S+", messageSeenAt: seenAt, now: seenAt + 1000 });
  assert.deepEqual(settled, { stopped: true, resume: true, announce: true });
  assert.equal(suspendDecision({ processState: "S+", messageSeenAt: 0, now: seenAt }).resume, false);
});
