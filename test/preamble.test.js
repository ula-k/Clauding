// CL-13, CL-14 — the text every session gets appended to its system prompt
// (electron/preamble.js, electron/preamble-default.md): what it must say, and
// when the stored copy may be replaced.
//
// preamble.md is written into a throw-away folder under the system temporary
// folder; the real <userData>/preamble.md is never touched and no session is
// started.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PREVIOUS_DEFAULT_PREAMBLE_HASHES,
  defaultPreamble,
  hashOf,
  readPreamble,
  refreshStoredPreamble
} from "../electron/preamble.js";

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-preamble-"));
}

test("the default text tells a session it is in Clauding and which command opens the panel", () => {
  const text = defaultPreamble();
  assert.ok(text.includes("Clauding"), "it names the app");
  assert.ok(text.includes("side panel"), "and the right-hand panel");
  assert.ok(text.includes("clauding open"), "and the command that puts a page there");
  assert.ok(text.includes("clauding panel hide"));
  assert.ok(text.includes("clauding tabs"));
});

test("the default text forbids answering with a claude.ai Artifact", () => {
  const text = defaultPreamble();
  assert.ok(/do not publish a claude\.ai artifact/i.test(text), "the bug that started all this");
  assert.ok(/ctrl\+\]/i.test(text), "and the keystroke that is not the panel either");
  assert.ok(/say so verbatim/i.test(text), "a failed open is reported, not glossed over");
});

test("the default text asks for a plan as an HTML page in the panel", () => {
  const text = defaultPreamble();
  assert.ok(/plan/i.test(text));
  assert.ok(/HTML page/i.test(text));
  assert.ok(/not a wall of text/i.test(text), "it says what kind of page");
  assert.ok(/reloads it automatically/i.test(text), "and that editing the same file is enough");
});

test("the default text names the panel in the languages the interface has", () => {
  const text = defaultPreamble();
  assert.ok(text.includes("po prawej"), "Polish");
  assert.ok(text.includes("a la derecha"), "Spanish");
  assert.ok(text.includes("在右边"), "Simplified Chinese");
});

test("the current default is not in the list of replaceable old defaults", () => {
  assert.equal(
    PREVIOUS_DEFAULT_PREAMBLE_HASHES.includes(hashOf(defaultPreamble())),
    false,
    "otherwise the file would be rewritten on every start"
  );
  for (const hash of PREVIOUS_DEFAULT_PREAMBLE_HASHES) {
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
});

test("the first start writes the default text", () => {
  const preamblePath = path.join(scratchFolder(), "preamble.md");
  assert.deepEqual(refreshStoredPreamble(preamblePath), { status: "created" });
  assert.equal(fs.readFileSync(preamblePath, "utf8"), defaultPreamble());
  assert.deepEqual(refreshStoredPreamble(preamblePath), { status: "current" });
});

test("a file the user edited is kept, whatever the new default says", () => {
  const preamblePath = path.join(scratchFolder(), "preamble.md");
  const ownText = "My own preamble. Always answer in Polish.\n";
  fs.writeFileSync(preamblePath, ownText);
  const reported = [];
  const result = refreshStoredPreamble(preamblePath, (line) => reported.push(line));
  assert.deepEqual(result, { status: "kept" });
  assert.equal(fs.readFileSync(preamblePath, "utf8"), ownText, "the edit survives");
  assert.equal(reported.length, 1, "it is only mentioned in the log");
});

test("a file that is still one of our own old defaults is brought up to date", () => {
  const preamblePath = path.join(scratchFolder(), "preamble.md");
  const oldDefault = "An older default text this app once wrote.\n";
  fs.writeFileSync(preamblePath, oldDefault);
  const result = refreshStoredPreamble(preamblePath, null, [hashOf(oldDefault)]);
  assert.deepEqual(result, { status: "refreshed" });
  assert.equal(fs.readFileSync(preamblePath, "utf8"), defaultPreamble());
});

test("one changed character is an edit, not an old default", () => {
  const preamblePath = path.join(scratchFolder(), "preamble.md");
  const oldDefault = "An older default text this app once wrote.\n";
  fs.writeFileSync(preamblePath, `${oldDefault} `);
  assert.deepEqual(refreshStoredPreamble(preamblePath, null, [hashOf(oldDefault)]), { status: "kept" });
});

test("reading the preamble writes the default when the file is missing or empty", () => {
  const preamblePath = path.join(scratchFolder(), "preamble.md");
  assert.equal(readPreamble(preamblePath), defaultPreamble());
  assert.equal(fs.existsSync(preamblePath), true, "the file is created so it can be edited");

  fs.writeFileSync(preamblePath, "   \n");
  assert.equal(readPreamble(preamblePath), defaultPreamble(), "an empty file means the default");

  fs.writeFileSync(preamblePath, "Mine.\n");
  assert.equal(readPreamble(preamblePath), "Mine.\n");
});

test("a preamble that cannot be written still gives the session its text", () => {
  const missingFolder = path.join(scratchFolder(), "not", "created", "preamble.md");
  assert.equal(readPreamble(missingFolder), defaultPreamble());
  assert.deepEqual(refreshStoredPreamble(missingFolder), { status: "failed" });
});
