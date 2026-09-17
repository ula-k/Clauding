// ⌘V inside a terminal, and files dropped on the terminal pane.
//
// The rules live in lib/pasteSmart.js; this is the side that reads the real
// pasteboard, writes the real file and types into the real pty. The clipboard
// APIs only exist in the main process, which is why the renderer asks for
// this over IPC (terminal:paste-smart) instead of doing it itself — and why
// focus never leaves xterm.
//
// Ctrl+V is deliberately untouched: it goes straight through to the CLI,
// which has its own clipboard-image paste for the times when the raw image on
// the clipboard is what the user wants.
import { clipboard } from "electron";
import fs from "node:fs";
import { execFile } from "node:child_process";
import {
  decideClipboardPaste,
  filePathsFromFileUrlText,
  filePathsFromFilenamesData,
  savePastedImage,
  typedTextForPaths
} from "./lib/pasteSmart.js";

// Electron 44 replaced the old synchronous clipboard module with the web
// Async Clipboard API — `clipboard.read()` answers with ClipboardItems, and
// `readImage` / `readBuffer` / `availableFormats` are gone. Standard web types
// come through as they are ("text/uri-list", "image/png"), and every other
// macOS pasteboard flavor through Electron's own escape hatch, named
//   electron application/osclipboard;format="<the pasteboard type>"
// which is how NSFilenamesPboardType is read. A file copied in Finder carries
// both, and the plist one is the exact list of POSIX paths, so it comes first.
const FILENAMES_TYPE = 'electron application/osclipboard;format="NSFilenamesPboardType"';
const URI_LIST_TYPE = "text/uri-list";
// A macOS screenshot taken to the clipboard carries TIFF as well, but
// Chromium offers it as PNG under the standard type, so nothing else is read.
const PNG_TYPE = "image/png";
// Reading the pasteboard in the same breath as another process wrote it can
// catch it between two states: macOS clears the board before putting the new
// flavors in, so the snapshot `clipboard.read()` answers with can hold an
// item with no types at all, or still describe what was there a moment ago.
// `clipboard.has()` asks the board directly, so the two are compared and a
// snapshot that disagrees is taken again. Both were seen while the paste
// smoke run copied with `osascript` and pasted in the same breath; a person
// copying in Finder and then pressing Cmd+V is never that quick.
const SNAPSHOT_READS = 6;
const SNAPSHOT_WAIT_MILLISECONDS = 80;

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readItemsOnce() {
  try {
    return (await clipboard.read()) || [];
  } catch (error) {
    return [];
  }
}

async function boardHasType(type) {
  try {
    return Boolean(await clipboard.has(type));
  } catch (error) {
    return false;
  }
}

function itemsCarry(items, types) {
  return items.some((item) => types.some((type) => (item.types || []).includes(type)));
}

// The pasteboard as one paste sees it: one snapshot for every question, so
// the board is not read twice and cannot change halfway through a decision.
export async function readClipboardItems() {
  let items = [];
  for (let attempt = 0; attempt < SNAPSHOT_READS; attempt += 1) {
    items = await readItemsOnce();
    const describesSomething = items.length === 0 || items.some((item) => (item.types || []).length > 0);
    const filesAgree = !(await boardHasType(URI_LIST_TYPE)) || itemsCarry(items, [URI_LIST_TYPE, FILENAMES_TYPE]);
    const imageAgrees = !(await boardHasType(PNG_TYPE)) || itemsCarry(items, [PNG_TYPE]);
    if (describesSomething && filesAgree && imageAgrees) {
      return items;
    }
    await pause(SNAPSHOT_WAIT_MILLISECONDS);
  }
  return items;
}

async function bufferOfType(item, type) {
  try {
    const blob = await item.getType(type);
    return Buffer.from(await blob.arrayBuffer());
  } catch (error) {
    return null;
  }
}

async function textOfType(item, type) {
  const data = await bufferOfType(item, type);
  return data ? data.toString("utf8") : "";
}

function existsQuietly(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    return false;
  }
}

// Chromium's own view of the pasteboard turned out unreliable for the file
// flavors while the app stays active: pasting right after another process
// copied a file, it kept describing what was on the board a moment earlier,
// so half the pastes in the smoke run saw no file at all. The image flavor
// never misbehaved. So the files are asked of NSPasteboard itself, through
// one JavaScript-for-Automation script - about 70 ms, once per Cmd+V.
const PASTEBOARD_FILES_SCRIPT = [
  'ObjC.import("AppKit");',
  "const board = $.NSPasteboard.generalPasteboard;",
  "const collected = [];",
  'const plist = board.propertyListForType("NSFilenamesPboardType");',
  "if (!plist.isNil()) {",
  "  const unwrapped = ObjC.deepUnwrap(plist);",
  "  if (Array.isArray(unwrapped)) {",
  "    for (const entry of unwrapped) { collected.push(String(entry)); }",
  "  } else if (unwrapped) {",
  "    collected.push(String(unwrapped));",
  "  }",
  "}",
  "if (collected.length === 0) {",
  '  const single = board.stringForType("public.file-url");',
  "  if (!single.isNil()) { collected.push(String(ObjC.unwrap(single))); }",
  "}",
  'collected.join("\\n");'
].join("\n");
const PASTEBOARD_SCRIPT_TIMEOUT_MILLISECONDS = 2000;

function runPasteboardFilesScript() {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", PASTEBOARD_FILES_SCRIPT],
      { timeout: PASTEBOARD_SCRIPT_TIMEOUT_MILLISECONDS },
      (error, stdout) => {
        resolve(error ? "" : String(stdout || ""));
      }
    );
  });
}

// The files on the pasteboard, straight from macOS. One path per line, and a
// file URL where that is the only flavor there was. A flavor left behind by
// an earlier copy can name something that is gone, so only paths that still
// exist count - otherwise Cmd+V would type a dead path instead of text.
export async function readPasteboardFilePaths(platform = process.platform) {
  if (platform !== "darwin") {
    return [];
  }
  const printed = await runPasteboardFilesScript();
  return printed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^file:\/\//i.test(line) ? filePathsFromFileUrlText(line)[0] : line))
    .filter((filePath) => filePath && existsQuietly(filePath));
}

// The files in one of Chromium's pasteboard snapshots: the fallback for the
// reader above, for a Mac where that script cannot run at all.
export async function readClipboardFilePaths(items, platform = process.platform) {
  if (platform !== "darwin") {
    return [];
  }
  const found = [];
  for (const item of items || []) {
    const types = item.types || [];
    if (found.length === 0 && types.includes(FILENAMES_TYPE)) {
      found.push(...filePathsFromFilenamesData(await textOfType(item, FILENAMES_TYPE)));
    }
    if (found.length === 0 && types.includes(URI_LIST_TYPE)) {
      found.push(...filePathsFromFileUrlText(await textOfType(item, URI_LIST_TYPE)));
    }
  }
  return found.filter((filePath) => existsQuietly(filePath));
}

// The raw image in one pasteboard snapshot as PNG bytes, or null.
export async function readClipboardImagePng(items) {
  for (const item of items || []) {
    if ((item.types || []).includes(PNG_TYPE)) {
      const pngData = await bufferOfType(item, PNG_TYPE);
      if (pngData && pngData.length > 0) {
        return pngData;
      }
    }
  }
  return null;
}

// One paste. `filePaths` is what was dropped on the pane (the clipboard is
// not looked at then); without it the clipboard decides. The answer says what
// happened, and `kind: "text"` means nothing was typed — the caller lets
// xterm paste the text itself, with the bracketed-paste markers the CLI
// expects.
export async function smartPaste({
  filePaths = null,
  pastedDirectory,
  writeToTerminal,
  platform = process.platform,
  when = new Date()
}) {
  const dropped = (Array.isArray(filePaths) ? filePaths : [])
    .filter((filePath) => typeof filePath === "string" && filePath.trim() !== "");
  if (dropped.length > 0) {
    writeToTerminal(typedTextForPaths(dropped));
    return { kind: "files", filePaths: dropped, source: "drop" };
  }
  // One snapshot for every question asked of Chromium's clipboard: reading it
  // twice would double the chance of catching the board mid-write.
  const items = await readClipboardItems();
  const decision = await decideClipboardPaste({
    async readFilePaths() {
      const fromBoard = await readPasteboardFilePaths(platform);
      return fromBoard.length > 0 ? fromBoard : readClipboardFilePaths(items, platform);
    },
    readImagePng: () => readClipboardImagePng(items)
  });
  if (decision.kind === "files") {
    writeToTerminal(typedTextForPaths(decision.filePaths));
    return { kind: "files", filePaths: decision.filePaths, source: "clipboard" };
  }
  if (decision.kind === "image") {
    const savedPath = savePastedImage({ pastedDirectory, pngData: decision.pngData, when });
    writeToTerminal(typedTextForPaths([savedPath]));
    return { kind: "image", filePaths: [savedPath], source: "clipboard" };
  }
  return { kind: "text", filePaths: [], source: "clipboard" };
}
