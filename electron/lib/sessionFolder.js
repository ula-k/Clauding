// Which folder a session's `claude --resume` is started in, when the SDK
// does not say.
//
// Why this exists: the SDK's `listSessions` takes a session's `cwd` from the
// first 64 KiB of its transcript only. A long conversation that was renamed
// or forked starts with a `custom-title` line and then hundreds of kilobytes
// of agent and file-history lines before the first line that carries a
// `cwd` — "summary", "media" and "progress status" had theirs 110–420 KiB
// in. The SDK then reports no folder, the row says "unknown", a click
// quietly opened nothing and the middle column sat on "Opening a terminal…"
// for good.
//
// The folder is worked out along one chain, first answer that exists on
// disk wins:
//
//   project     the folder the transcript is filed under. The CLI files a
//               conversation in ~/.claude/projects/<the start folder with
//               every non-alphanumeric character turned into "-">, and keeps
//               writing there; resuming from that same folder keeps it so.
//               The SDK's `cwd`, when it encodes to exactly that name, is
//               taken as is (decoding is ambiguous: "my-app" vs "my/app");
//               otherwise the name is decoded by walking the disk.
//   sdk         the SDK's own `cwd`
//   transcript  the first `cwd` in the transcript's head (read further than
//               the SDK does), then the last one in its tail
//
// When no candidate exists, the first one is still returned (`exists:
// false`) so the window can say which folder is gone; with none at all the
// source is "none".
//
// Pure on purpose: electron/sessions.js does the reading, and
// test/sessionFolder.test.js checks the decisions.

const CWD_PATTERN = /"cwd":("(?:[^"\\]|\\.)*")/g;

// Every `cwd` value in a piece of a transcript, in the order they appear. A
// line cut in half at the edge of the piece simply does not match.
export function cwdValuesInText(text) {
  const values = [];
  for (const match of String(text || "").matchAll(CWD_PATTERN)) {
    try {
      const value = JSON.parse(match[1]);
      if (typeof value === "string" && value.trim()) {
        values.push(value);
      }
    } catch (error) {
      // Half a string at the edge of the piece read.
    }
  }
  return values;
}

// The CLI names a project folder after the working directory with every
// character that is not a letter or a digit turned into "-".
export function encodeProjectFolderName(folder) {
  return String(folder || "").replace(/[^a-zA-Z0-9]/g, "-");
}

// The way back is ambiguous ("my-app" and "my/app" encode the same), so it
// walks the disk: from "/" it takes, level by level, the entry whose encoded
// path is still a prefix of the name. `listFolder(path)` answers the names
// of the folders inside `path` ([] when there are none). Null when nothing
// on disk matches the whole name.
export function decodeProjectFolderName(encodedName, listFolder, separator = "/") {
  const wanted = String(encodedName || "");
  if (!wanted.startsWith("-") || typeof listFolder !== "function") {
    return null;
  }
  const maximumSteps = 64;
  function walk(currentPath, steps) {
    if (encodeProjectFolderName(currentPath) === wanted) {
      return currentPath;
    }
    if (steps >= maximumSteps) {
      return null;
    }
    let names = [];
    try {
      names = listFolder(currentPath) || [];
    } catch (error) {
      return null;
    }
    for (const name of names) {
      const candidate = currentPath.endsWith(separator) ? `${currentPath}${name}` : `${currentPath}${separator}${name}`;
      const encoded = encodeProjectFolderName(candidate);
      if (encoded === wanted || wanted.startsWith(`${encoded}-`)) {
        const found = walk(candidate, steps + 1);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }
  return walk(separator, 0);
}

// The chain itself. Every input is optional; `folderExists(path)` is asked
// about each candidate. `projectFolderName` is the name of the folder the
// transcript sits in; `decodeProjectFolder(name)` turns it back into a path
// (or null) and is only called when the SDK's folder does not match it.
// Answers { folder, source, exists }.
export function resolveSessionFolder({
  projectFolderName = null,
  decodeProjectFolder = () => null,
  sdkFolder = null,
  headFolders = [],
  tailFolders = [],
  folderExists = () => true
} = {}) {
  let projectFolder = null;
  if (projectFolderName) {
    projectFolder =
      sdkFolder && encodeProjectFolderName(sdkFolder) === projectFolderName ? sdkFolder : decodeProjectFolder(projectFolderName);
  }
  const candidates = [
    { folder: projectFolder, source: "project" },
    { folder: sdkFolder, source: "sdk" },
    { folder: headFolders.length > 0 ? headFolders[0] : null, source: "transcript" },
    { folder: tailFolders.length > 0 ? tailFolders[tailFolders.length - 1] : null, source: "transcript" }
  ].filter((candidate) => typeof candidate.folder === "string" && candidate.folder.trim());
  if (candidates.length === 0) {
    return { folder: null, source: "none", exists: false };
  }
  for (const candidate of candidates) {
    if (folderExists(candidate.folder)) {
      return { ...candidate, exists: true };
    }
  }
  return { ...candidates[0], exists: false };
}
