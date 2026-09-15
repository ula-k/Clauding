// Where the app's own smoke runs work. Everything they write — the pages
// they open in the panel, the `claude` conversations they start — lands in
// this one throw-away folder, never in a real project, and the session list
// hides it (see isScratchWorkingDirectory in sessions.js).
import os from "node:os";
import path from "node:path";

// The folder the smoke runs put their files in.
export function smokeFolderPath() {
  return process.env.CLAUDING_SMOKE_FOLDER || path.join(os.tmpdir(), "clauding-smoke");
}

// The folder a smoke run opens its terminals in. The same folder by default;
// CLAUDING_SMOKE_WORKING_DIRECTORY moves the sessions somewhere else without
// moving the files.
export function smokeWorkingDirectory() {
  return process.env.CLAUDING_SMOKE_WORKING_DIRECTORY || smokeFolderPath();
}

// macOS reports the same temporary folder both with and without the
// /private prefix (/var/folders/… is a symlink to /private/var/folders/…),
// so paths are compared with the prefix taken off.
export function withoutPrivatePrefix(folder) {
  const text = String(folder || "");
  return text.startsWith("/private/") ? text.slice("/private".length) : text;
}

// Is this working directory the smoke folder itself or something inside it?
export function isInsideSmokeFolder(workingDirectory) {
  const candidate = withoutPrivatePrefix(workingDirectory);
  if (!candidate) {
    return false;
  }
  return [smokeFolderPath(), smokeWorkingDirectory()]
    .map(withoutPrivatePrefix)
    .some((root) => candidate === root || candidate.startsWith(`${root}/`));
}
