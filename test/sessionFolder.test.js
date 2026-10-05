// "This session's folder is unknown": renamed or forked long conversations
// ("summary", "media", "progress status") start with more than the 64 KiB
// the SDK reads before their first `cwd` line, so the SDK listed them with
// no folder, a click opened nothing and the column said "Opening a
// terminal…" for good. Checked here: the folder chain
// (electron/lib/sessionFolder.js), the transcript reading past the SDK's
// window (electron/sessions.js) and the end of the wait
// (src/renderer/openingState.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cwdValuesInText,
  decodeProjectFolderName,
  encodeProjectFolderName,
  resolveSessionFolder
} from "../electron/lib/sessionFolder.js";
import { readTranscriptFolders } from "../electron/sessions.js";
import { OPENING_TIMEOUT_MILLISECONDS, openingState } from "../src/renderer/openingState.js";

const existing = new Set(["/work/website", "/work/notes", "/work/parent", "/Users/ula/Documents/projects/claude"]);
const folderExists = (folder) => existing.has(folder);

test("cwd values are read in order, escaped paths included, half lines skipped", () => {
  const text = [
    '{"type":"custom-title","customTitle":"summary"}',
    '{"type":"user","cwd":"/work/website","uuid":"one"}',
    '{"type":"user","cwd":"/work/with \\"quote\\"","uuid":"two"}',
    '{"type":"user","cwd":"/work/no'
  ].join("\n");
  assert.deepEqual(cwdValuesInText(text), ["/work/website", '/work/with "quote"']);
  assert.deepEqual(cwdValuesInText(""), []);
});

test("the chain: the transcript's project folder, then the SDK's cwd, then the transcript's own lines", () => {
  const projectFolderName = "-Users-ula-Documents-projects-claude";
  const decodeProjectFolder = (name) => (name === projectFolderName ? "/Users/ula/Documents/projects/claude" : null);
  // The "summary" case: no SDK folder, the work inside the transcript in
  // another folder — the resume still starts where the transcript is filed.
  assert.deepEqual(
    resolveSessionFolder({ projectFolderName, decodeProjectFolder, headFolders: ["/work/website"], tailFolders: ["/work/notes"], folderExists }),
    { folder: "/Users/ula/Documents/projects/claude", source: "project", exists: true }
  );
  // An SDK folder that encodes to the project name is taken as it is, never
  // decoded (decoding cannot tell "my-app" from "my/app").
  let decodeCalls = 0;
  const countingDecode = () => {
    decodeCalls += 1;
    return null;
  };
  assert.deepEqual(
    resolveSessionFolder({ projectFolderName: "-work-website", decodeProjectFolder: countingDecode, sdkFolder: "/work/website", folderExists }),
    { folder: "/work/website", source: "project", exists: true }
  );
  assert.equal(decodeCalls, 0);
  // The project folder is gone (a removed worktree): the SDK's folder.
  assert.equal(resolveSessionFolder({ projectFolderName: "-gone-worktree", decodeProjectFolder, sdkFolder: "/work/notes", folderExists }).source, "sdk");
  // Nothing but the transcript: its first line, then its last.
  assert.deepEqual(resolveSessionFolder({ headFolders: ["/work/website", "/work/notes"], folderExists }), {
    folder: "/work/website",
    source: "transcript",
    exists: true
  });
  assert.equal(resolveSessionFolder({ headFolders: ["/gone"], tailFolders: ["/gone", "/work/notes"], folderExists }).folder, "/work/notes");
});

test("a folder that is gone is passed over; when all are gone the first is named, and nothing at all is none", () => {
  assert.deepEqual(resolveSessionFolder({ sdkFolder: "/gone/worktree", headFolders: ["/work/website"], folderExists }), {
    folder: "/work/website",
    source: "transcript",
    exists: true
  });
  assert.deepEqual(resolveSessionFolder({ sdkFolder: "/gone/worktree", headFolders: ["/gone/too"], folderExists }), {
    folder: "/gone/worktree",
    source: "sdk",
    exists: false
  });
  assert.deepEqual(resolveSessionFolder({ folderExists }), { folder: null, source: "none", exists: false });
  assert.deepEqual(resolveSessionFolder(), { folder: null, source: "none", exists: false });
});

test("a project folder name is decoded by walking the disk, dashes in names included", () => {
  const tree = {
    "/": ["Users", "private"],
    "/Users": ["ula"],
    "/Users/ula": ["Documents"],
    "/Users/ula/Documents": ["projects"],
    "/Users/ula/Documents/projects": ["claude", "my-app", "my"],
    "/Users/ula/Documents/projects/my": ["other"]
  };
  const listFolder = (folder) => tree[folder] || [];
  assert.equal(encodeProjectFolderName("/Users/ula/Documents/projects/claude"), "-Users-ula-Documents-projects-claude");
  assert.equal(decodeProjectFolderName("-Users-ula-Documents-projects-claude", listFolder), "/Users/ula/Documents/projects/claude");
  assert.equal(decodeProjectFolderName("-Users-ula-Documents-projects-my-app", listFolder), "/Users/ula/Documents/projects/my-app");
  assert.equal(decodeProjectFolderName("-Users-ula-Documents-projects-my-other", listFolder), "/Users/ula/Documents/projects/my/other");
  assert.equal(decodeProjectFolderName("-private-gone-scratch", listFolder), null);
  assert.equal(decodeProjectFolderName("not-encoded", listFolder), null);
});

test("the transcript is read past the SDK's 64 KiB, across chunk edges, and its tail too", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-session-folder-"));
  const transcriptPath = path.join(folder, "fork.jsonl");
  const filler = `{"type":"file-history-snapshot","snapshot":"${"x".repeat(1900)}"}`;
  const lines = ['{"type":"custom-title","customTitle":"summary"}'];
  // About 400 KiB of lines with no folder, as in the real "Summary" fork —
  // the first `cwd` lands past the first 256 KiB chunk.
  while (lines.join("\n").length < 400 * 1024) {
    lines.push(filler);
  }
  lines.push('{"type":"user","cwd":"/Users/ula/Documents/projects/claude","uuid":"first"}');
  for (let count = 0; count < 50; count += 1) {
    lines.push(filler);
  }
  lines.push('{"type":"assistant","cwd":"/work/website","uuid":"last"}');
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
  const found = readTranscriptFolders(transcriptPath);
  assert.equal(found.headFolders[0], "/Users/ula/Documents/projects/claude");
  assert.deepEqual(found.tailFolders, ["/work/website"]);
  assert.deepEqual(readTranscriptFolders(path.join(folder, "missing.jsonl")), { headFolders: [], tailFolders: [] });
  fs.rmSync(folder, { recursive: true, force: true });
});

test("the wait for a terminal ends: an error at once, silence after 15 seconds, output or an exit means ready", () => {
  const startedAt = 1000;
  assert.equal(OPENING_TIMEOUT_MILLISECONDS, 15000);
  assert.equal(openingState({ startedAt, now: startedAt + 14999 }), "opening");
  assert.equal(openingState({ startedAt, now: startedAt + 15000 }), "silent");
  assert.equal(openingState({ startedAt, now: startedAt + 10, error: "The folder does not exist: /gone" }), "failed");
  assert.equal(openingState({ startedAt, now: startedAt + 60000, firstOutputAt: startedAt + 300 }), "ready");
  assert.equal(openingState({ startedAt, now: startedAt + 60000, exited: true }), "ready");
  // No start time known: it never claims silence.
  assert.equal(openingState({ startedAt: 0, now: 999999 }), "opening");
});
