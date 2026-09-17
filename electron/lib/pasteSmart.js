// What a paste into a terminal means: the decision itself, the quoting, and
// the little folder of pasted images. No Electron here, so every rule can be
// checked by test/pasteSmart.test.js without a window or a pasteboard; who
// reads the real clipboard is electron/pasteSmart.js.
//
// Why the file flavor wins. Copying a screenshot *file* in Finder puts three
// things on the pasteboard: the file's URL, its name — and, as the image
// flavor, the file type's **icon**. Reading the image therefore hands back a
// 39 kB "PNG document" icon rather than the picture, which is exactly what
// Claude Code reported receiving. So a clipboard that carries files types
// their paths and lets the CLI read the files itself, the way dragging a file
// into Terminal.app does. Only a clipboard with a raw image and no file at
// all (a screenshot taken straight to the clipboard) is written out to a PNG
// and typed as the path of that file. Anything else is ordinary text, which
// xterm still pastes itself.
import fs from "node:fs";
import path from "node:path";
import { filePathFromUrl } from "../panelTabs.js";

// How many images <userData>/pasted/ keeps. The folder is a scratch pad for
// clipboard screenshots, not an archive: the oldest ones are thrown away.
export const PASTED_FILES_KEPT = 50;

// POSIX single quotes: everything between them is literal, so spaces, `$`,
// backticks and unicode need nothing done to them, and the only character
// that has to be escaped is the single quote itself — by closing the quoting,
// putting in a backslashed quote and opening it again.
export function quotePathForShell(filePath) {
  const text = String(filePath || "");
  if (text === "") {
    return "";
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// What is written to the pty: every path quoted, separated by spaces and
// followed by one more space, so the cursor lands after the path and the
// user can keep typing their question. Never a newline — nothing is
// submitted on their behalf.
export function typedTextForPaths(filePaths) {
  const quoted = (Array.isArray(filePaths) ? filePaths : [])
    .filter((filePath) => typeof filePath === "string" && filePath.trim() !== "")
    .map(quotePathForShell);
  return quoted.length === 0 ? "" : `${quoted.join(" ")} `;
}

// The file URLs on the clipboard ("text/uri-list", and the "Apple URL
// pasteboard type" flavor behind it): one per line, and only the file ones.
export function filePathsFromFileUrlText(text) {
  return String(text || "")
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => /^file:\/\//i.test(line))
    .map((line) => filePathFromUrl(line));
}

// The macOS "NSFilenamesPboardType" flavor: an XML property list holding one
// <string> per file, which is what a file copied in Finder carries (checked
// against the real pasteboard, Electron 44). Anything that is not such a
// plist falls back to the file URLs above.
export function filePathsFromFilenamesData(data) {
  const text = String(data || "");
  if (!/<plist/i.test(text)) {
    return [];
  }
  const paths = [];
  for (const match of text.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    const filePath = match[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (filePath !== "") {
      paths.push(filePath);
    }
  }
  return paths;
}

function twoDigits(number) {
  return String(number).padStart(2, "0");
}

// <yyyy-mm-dd-hhmmss>.png, in local time: the name says when the image was
// pasted, and sorting the folder by name sorts it by age.
export function pastedImageFileName(when = new Date()) {
  const year = when.getFullYear();
  const month = twoDigits(when.getMonth() + 1);
  const day = twoDigits(when.getDate());
  const hours = twoDigits(when.getHours());
  const minutes = twoDigits(when.getMinutes());
  const seconds = twoDigits(when.getSeconds());
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}.png`;
}

// Which files in <userData>/pasted/ are over the limit. Names are
// timestamps, so the newest ones are simply the last ones by name; anything
// that is not one of ours is left alone.
export function pastedFilesToRemove(fileNames, keepCount = PASTED_FILES_KEPT) {
  const ours = (Array.isArray(fileNames) ? fileNames : [])
    .filter((fileName) => /^\d{4}-\d{2}-\d{2}-\d{6}\.png$/.test(String(fileName)))
    .sort();
  const overTheLimit = ours.length - Math.max(0, keepCount);
  return overTheLimit > 0 ? ours.slice(0, overTheLimit) : [];
}

// Keeps <userData>/pasted/ down to the newest `keepCount` images and answers
// with the names it threw away.
export function prunePastedFolder(pastedDirectory, keepCount = PASTED_FILES_KEPT) {
  let fileNames = [];
  try {
    fileNames = fs.readdirSync(pastedDirectory);
  } catch (error) {
    return [];
  }
  const removed = [];
  for (const fileName of pastedFilesToRemove(fileNames, keepCount)) {
    try {
      fs.unlinkSync(path.join(pastedDirectory, fileName));
      removed.push(fileName);
    } catch (error) {
      // Already gone, or not ours to delete; nothing to clean up.
    }
  }
  return removed;
}

// A raw clipboard image written out, so the CLI has a file to read.
export function savePastedImage({ pastedDirectory, pngData, when = new Date(), keepCount = PASTED_FILES_KEPT }) {
  fs.mkdirSync(pastedDirectory, { recursive: true });
  const filePath = path.join(pastedDirectory, pastedImageFileName(when));
  fs.writeFileSync(filePath, pngData);
  prunePastedFolder(pastedDirectory, keepCount);
  return filePath;
}

// Files first, then an image, then text. The readers are handed in so this
// decision can be made with plain values instead of a real pasteboard:
// `readFilePaths()` answers with the paths on the clipboard (or none), and
// `readImagePng()` with the PNG bytes of a raw image (or null). Both may
// answer with a promise — the real ones do, because Electron 44's clipboard
// is the asynchronous web API — and a plain value is just as welcome.
export async function decideClipboardPaste({ readFilePaths, readImagePng }) {
  const filePaths = (typeof readFilePaths === "function" ? await readFilePaths() : null) || [];
  if (filePaths.length > 0) {
    return { kind: "files", filePaths };
  }
  const pngData = typeof readImagePng === "function" ? await readImagePng() : null;
  if (pngData && pngData.length > 0) {
    return { kind: "image", pngData };
  }
  return { kind: "text" };
}
