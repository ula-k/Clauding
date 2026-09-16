// CL-19b — "Extra claude flags…" decides nothing until the dialog is
// answered (src/renderer/sessionFlagsPlan.js), and session-flags.json is
// re-read when it changes on disk (electron/sessionFlags.js). Dry tests: no
// window, no IPC, no `claude` — only the mapping from the button that was
// pressed to the two things that may happen (write the flags, restart the
// terminal), and the store against a file in a throw-away folder.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CANCEL,
  SAVE_AND_RESTART,
  SAVE_ONLY,
  flagsApplyOnNextResume,
  flagsChangePlan
} from "../src/renderer/sessionFlagsPlan.js";
import { createSessionFlagsStore } from "../electron/sessionFlags.js";

const OPEN_IN_TERMINAL = { hasOpenTerminal: true };
const NOT_OPEN = { hasOpenTerminal: false };

test("Cancel writes nothing and restarts nothing", () => {
  assert.deepEqual(flagsChangePlan(CANCEL, OPEN_IN_TERMINAL), { writeFlags: false, restart: false });
  assert.deepEqual(flagsChangePlan(CANCEL, NOT_OPEN), { writeFlags: false, restart: false });
});

test("Escape, a click outside, an unknown answer: all of them are Cancel", () => {
  for (const choice of [null, undefined, "", "somethingElse"]) {
    assert.deepEqual(flagsChangePlan(choice, OPEN_IN_TERMINAL), { writeFlags: false, restart: false });
  }
});

test("Save only writes the flags and leaves the terminal alone", () => {
  assert.deepEqual(flagsChangePlan(SAVE_ONLY, OPEN_IN_TERMINAL), { writeFlags: true, restart: false });
  assert.deepEqual(flagsChangePlan(SAVE_ONLY, NOT_OPEN), { writeFlags: true, restart: false });
});

test("Save and restart writes the flags and restarts the open terminal", () => {
  assert.deepEqual(flagsChangePlan(SAVE_AND_RESTART, OPEN_IN_TERMINAL), { writeFlags: true, restart: true });
});

test("there is nothing to restart when the session is not open in a terminal of ours", () => {
  assert.deepEqual(flagsChangePlan(SAVE_AND_RESTART, NOT_OPEN), { writeFlags: true, restart: false });
  assert.deepEqual(flagsChangePlan(SAVE_AND_RESTART, undefined), { writeFlags: true, restart: false });
});

test("only a save without a restart waits for the next resume", () => {
  assert.equal(flagsApplyOnNextResume(SAVE_ONLY, OPEN_IN_TERMINAL), true);
  assert.equal(flagsApplyOnNextResume(SAVE_ONLY, NOT_OPEN), true);
  assert.equal(flagsApplyOnNextResume(SAVE_AND_RESTART, OPEN_IN_TERMINAL), false);
  assert.equal(flagsApplyOnNextResume(CANCEL, OPEN_IN_TERMINAL), false);
});

test("a plan is a fresh object every time, so a caller cannot spoil the next one", () => {
  const first = flagsChangePlan(SAVE_ONLY, OPEN_IN_TERMINAL);
  first.restart = true;
  assert.deepEqual(flagsChangePlan(SAVE_ONLY, OPEN_IN_TERMINAL), { writeFlags: true, restart: false });
});

function temporaryStorePath() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-session-flags-"));
  return path.join(folder, "session-flags.json");
}

function writeStoreFile(storagePath, sessionFlags) {
  fs.writeFileSync(storagePath, `${JSON.stringify({ version: 1, sessionFlags }, null, 2)}\n`);
}

test("a hand-edited session-flags.json is picked up by reloadFromDisk", () => {
  const storagePath = temporaryStorePath();
  writeStoreFile(storagePath, { one: "--model sonnet" });
  const announced = [];
  const store = createSessionFlagsStore({ storagePath, onChange: (state) => announced.push(state) });
  assert.equal(store.flagsFor("one"), "--model sonnet");

  writeStoreFile(storagePath, { one: "--channels plugin:telegram", two: "--model opus" });
  assert.equal(store.reloadFromDisk(), true);
  assert.equal(store.flagsFor("one"), "--channels plugin:telegram");
  assert.equal(store.flagsFor("two"), "--model opus");
  assert.equal(announced.length, 1);
  assert.deepEqual(announced[0].sessionFlags, { one: "--channels plugin:telegram", two: "--model opus" });
});

test("a file that says what is already held is not a change, so the store's own saves are not news", () => {
  const storagePath = temporaryStorePath();
  writeStoreFile(storagePath, { one: "--model sonnet" });
  const announced = [];
  const store = createSessionFlagsStore({ storagePath, onChange: (state) => announced.push(state) });
  writeStoreFile(storagePath, { one: "--model sonnet" });
  assert.equal(store.reloadFromDisk(), false);
  assert.equal(announced.length, 0);
});

test("a half-written or missing file leaves what is in memory alone", () => {
  const storagePath = temporaryStorePath();
  writeStoreFile(storagePath, { one: "--model sonnet" });
  const store = createSessionFlagsStore({ storagePath });
  fs.writeFileSync(storagePath, '{ "version": 1, "sessionFl');
  assert.equal(store.reloadFromDisk(), false);
  assert.equal(store.flagsFor("one"), "--model sonnet");
  fs.rmSync(storagePath);
  assert.equal(store.reloadFromDisk(), false);
  assert.equal(store.flagsFor("one"), "--model sonnet");
});

test("saving from the dialog stores the flags, and an empty field takes them away again", () => {
  const storagePath = temporaryStorePath();
  const announced = [];
  const store = createSessionFlagsStore({ storagePath, onChange: (state) => announced.push(state) });
  store.remember("one", "  --channels   plugin:telegram@claude-plugins-official ");
  assert.equal(store.flagsFor("one"), "--channels plugin:telegram@claude-plugins-official");
  assert.equal(announced.length, 1);
  // The same text again changes nothing, so nothing is announced twice.
  store.remember("one", "--channels plugin:telegram@claude-plugins-official");
  assert.equal(announced.length, 1);
  store.remember("one", "");
  assert.equal(store.flagsFor("one"), "");
  assert.deepEqual(store.get().sessionFlags, {});
  assert.equal(announced.length, 2);
});
