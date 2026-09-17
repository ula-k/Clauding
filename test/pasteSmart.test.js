// Pasting a file into a terminal (electron/lib/pasteSmart.js): how a path is
// quoted before it is typed, which clipboard flavor wins, and how the folder
// of pasted images is kept small.
//
// Nothing here opens a window, reads a real pasteboard or spawns a `claude`:
// the clipboard readers are handed in as plain functions, and the pruning
// runs against a throw-away folder in the OS temporary directory.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PASTED_FILES_KEPT,
  decideClipboardPaste,
  filePathsFromFileUrlText,
  filePathsFromFilenamesData,
  pastedFilesToRemove,
  pastedImageFileName,
  prunePastedFolder,
  quotePathForShell,
  savePastedImage,
  typedTextForPaths
} from "../electron/lib/pasteSmart.js";

// ------------------------------------------------------------- quoting ---

test("a path with spaces comes out as one quoted word", () => {
  assert.equal(quotePathForShell("/Users/ula/Desktop/Screen Shot 1.png"), "'/Users/ula/Desktop/Screen Shot 1.png'");
});

test("a single quote in the name closes the quoting, escapes and reopens it", () => {
  assert.equal(quotePathForShell("/Users/ula/Ula's shot.png"), "'/Users/ula/Ula'\\''s shot.png'");
});

test("the characters a shell would otherwise read are left literal", () => {
  assert.equal(quotePathForShell('/Users/ula/Desktop/a "b" $HOME `now` (1).png'), '\'/Users/ula/Desktop/a "b" $HOME `now` (1).png\'');
});

test("unicode is not touched", () => {
  const filePath = "/Users/ula/Pulpit/zrzut ekranu — 屏幕截图.png";
  assert.equal(quotePathForShell(filePath), `'${filePath}'`);
});

test("nothing to quote gives an empty string", () => {
  assert.equal(quotePathForShell(""), "");
  assert.equal(quotePathForShell(null), "");
});

test("several paths are one space-separated line that ends in a space and no newline", () => {
  const typed = typedTextForPaths(["/Users/ula/one two.png", "/Users/ula/three.png"]);
  assert.equal(typed, "'/Users/ula/one two.png' '/Users/ula/three.png' ");
  assert.equal(typed.includes("\n"), false, "nothing is submitted on the user's behalf");
  assert.equal(typed.includes("\r"), false);
});

test("empty entries are dropped, and nothing at all types nothing", () => {
  assert.equal(typedTextForPaths(["/Users/ula/one.png", "", "   ", null]), "'/Users/ula/one.png' ");
  assert.equal(typedTextForPaths([]), "");
  assert.equal(typedTextForPaths(null), "");
});

// ------------------------------------------------------ clipboard flavors ---

test("the macOS file-url flavor is decoded into a POSIX path", () => {
  assert.deepEqual(filePathsFromFileUrlText("file:///Users/ula/Desktop/Screen%20Shot%201.png"), [
    "/Users/ula/Desktop/Screen Shot 1.png"
  ]);
});

test("several file URLs, one per line, come back in order; anything else is ignored", () => {
  assert.deepEqual(filePathsFromFileUrlText("file:///Users/ula/one.png\nnot a url\nfile:///Users/ula/two.png\n"), [
    "/Users/ula/one.png",
    "/Users/ula/two.png"
  ]);
  assert.deepEqual(filePathsFromFileUrlText(""), []);
});

test("the NSFilenamesPboardType property list gives every file it names", () => {
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<array>",
    "\t<string>/Users/ula/Desktop/first shot.png</string>",
    "\t<string>/Users/ula/Desktop/second &amp; third.png</string>",
    "</array>",
    "</plist>"
  ].join("\n");
  assert.deepEqual(filePathsFromFilenamesData(plist), [
    "/Users/ula/Desktop/first shot.png",
    "/Users/ula/Desktop/second & third.png"
  ]);
});

test("a flavor that is not a property list (an empty or binary one) gives nothing", () => {
  assert.deepEqual(filePathsFromFilenamesData(""), []);
  assert.deepEqual(filePathsFromFilenamesData("bplist00\u0000\u0000/Users/ula/x.png"), []);
});

// ------------------------------------------------------ the decision order ---

test("a file on the clipboard wins over the icon macOS puts there as the image", async () => {
  const decision = await decideClipboardPaste({
    readFilePaths: () => ["/Users/ula/Desktop/shot.png"],
    // The 39 kB "PNG document" icon: this is the bug, and it must not be read.
    readImagePng: () => Buffer.alloc(39000, 1)
  });
  assert.deepEqual(decision, { kind: "files", filePaths: ["/Users/ula/Desktop/shot.png"] });
});

test("the real readers answer with promises, and the order still holds", async () => {
  const filesFirst = await decideClipboardPaste({
    readFilePaths: async () => ["/Users/ula/Desktop/shot.png"],
    readImagePng: async () => Buffer.alloc(39000, 1)
  });
  assert.deepEqual(filesFirst, { kind: "files", filePaths: ["/Users/ula/Desktop/shot.png"] });
  const imageNext = await decideClipboardPaste({
    readFilePaths: async () => [],
    readImagePng: async () => Buffer.from([137, 80, 78, 71])
  });
  assert.equal(imageNext.kind, "image");
});

test("no file but a raw image on the clipboard is an image paste", async () => {
  const pngData = Buffer.from([137, 80, 78, 71]);
  const decision = await decideClipboardPaste({ readFilePaths: () => [], readImagePng: () => pngData });
  assert.deepEqual(decision, { kind: "image", pngData });
});

test("neither a file nor an image is a plain text paste, which xterm still does", async () => {
  assert.deepEqual(await decideClipboardPaste({ readFilePaths: () => [], readImagePng: () => null }), {
    kind: "text"
  });
  assert.deepEqual(await decideClipboardPaste({ readFilePaths: () => [], readImagePng: () => Buffer.alloc(0) }), {
    kind: "text"
  });
  assert.deepEqual(await decideClipboardPaste({}), { kind: "text" }, "no readers at all is text too");
});

// ------------------------------------------------------------ the folder ---

test("a pasted image is named after the moment it was pasted", () => {
  assert.equal(pastedImageFileName(new Date(2026, 8, 17, 9, 5, 3)), "2026-09-17-090503.png");
});

test("the folder keeps the newest 50 names and lists the older ones for removal", () => {
  const names = [];
  for (let minute = 0; minute < 60; minute += 1) {
    names.push(pastedImageFileName(new Date(2026, 8, 17, 10, minute, 0)));
  }
  const removed = pastedFilesToRemove(names.slice().reverse());
  assert.equal(PASTED_FILES_KEPT, 50);
  assert.equal(removed.length, 10);
  assert.deepEqual(removed, names.slice(0, 10), "the ten oldest go, whatever order they were listed in");
  assert.deepEqual(pastedFilesToRemove(names.slice(0, 50)), [], "exactly the limit removes nothing");
});

test("files that are not pasted images are never removed", () => {
  const names = ["notes.md", "screenshot.png", "2026-09-17-101500.png"];
  assert.deepEqual(pastedFilesToRemove(names, 0), ["2026-09-17-101500.png"]);
});

test("pruning a real folder deletes the oldest files and leaves the rest", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-pasted-"));
  const names = [];
  for (let second = 0; second < 5; second += 1) {
    const fileName = pastedImageFileName(new Date(2026, 8, 17, 10, 0, second));
    fs.writeFileSync(path.join(folder, fileName), "png");
    names.push(fileName);
  }
  fs.writeFileSync(path.join(folder, "keep-me.txt"), "not ours");
  const removed = prunePastedFolder(folder, 2);
  assert.deepEqual(removed, names.slice(0, 3));
  assert.deepEqual(fs.readdirSync(folder).sort(), ["2026-09-17-100003.png", "2026-09-17-100004.png", "keep-me.txt"]);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("pruning a folder that does not exist yet is quiet", () => {
  assert.deepEqual(prunePastedFolder(path.join(os.tmpdir(), "clauding-pasted-nowhere")), []);
});

test("saving a clipboard image creates the folder, writes the PNG and prunes", () => {
  const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clauding-userdata-")), "pasted");
  const first = savePastedImage({
    pastedDirectory: folder,
    pngData: Buffer.from([137, 80, 78, 71]),
    when: new Date(2026, 8, 17, 8, 30, 0),
    keepCount: 1
  });
  assert.equal(path.basename(first), "2026-09-17-083000.png");
  assert.equal(fs.readFileSync(first).length, 4);
  const second = savePastedImage({
    pastedDirectory: folder,
    pngData: Buffer.from([137, 80, 78, 71]),
    when: new Date(2026, 8, 17, 8, 30, 1),
    keepCount: 1
  });
  assert.deepEqual(fs.readdirSync(folder), [path.basename(second)], "only the newest one is kept");
  fs.rmSync(path.dirname(folder), { recursive: true, force: true });
});
