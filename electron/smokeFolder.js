// Where the app's own smoke runs work. Everything they write — the pages
// they open in the panel, the `claude` conversations they start — lands in
// this one throw-away folder, never in a real project, and the session list
// hides it (see isScratchWorkingDirectory in sessions.js).
//
// The smoke runs themselves are macOS-only (they photograph the window); this
// module is not, because the session list asks it on every row whatever
// system it is on.
import os from "node:os";
import path from "node:path";
import { isInsideFolder, withoutPrivatePrefix as stripPrivatePrefix } from "./lib/platformPaths.js";

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
// so paths are compared with the prefix taken off. There is nothing like it
// on Windows, so there the path is left exactly as it was given.
export function withoutPrivatePrefix(folder, platform = process.platform) {
  return stripPrivatePrefix(folder, platform);
}

// Is this working directory the smoke folder itself or something inside it?
export function isInsideSmokeFolder(workingDirectory, platform = process.platform) {
  const candidate = withoutPrivatePrefix(workingDirectory, platform);
  if (!candidate) {
    return false;
  }
  return [smokeFolderPath(), smokeWorkingDirectory()]
    .map((root) => withoutPrivatePrefix(root, platform))
    .some((root) => isInsideFolder(candidate, root, platform));
}
