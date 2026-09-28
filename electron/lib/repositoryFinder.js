// `clauding repos find`: the git checkouts in the places people usually keep
// them, so the setup agent can list them instead of guessing a path.
//
// Only folders are read — nothing is opened, run or changed. A folder is a
// repository when it holds `.git` (a folder, or the file a worktree has).
// The walk stops at a repository (its insides are not searched for more)
// and never goes into the folders below, which hold other people's code or
// build output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where to look, under the home folder. A setting would not help here: the
// agent asks about anything it does not find, and `clauding repos find
// <folder>` searches any folder the user names.
export const USUAL_REPOSITORY_ROOTS = ["Documents", "Projects", "projects", "Developer", "src", "code", "work", "git", "repos", "Sites"];
export const REPOSITORY_SEARCH_DEPTH = 3;
const MAXIMUM_REPOSITORIES = 200;
const SKIPPED_FOLDERS = new Set(["node_modules", ".Trash", "Library", "vendor", ".cache", "dist", "build", "Pods", ".venv", "venv"]);

function entriesOf(folder, readDirectory) {
  try {
    return readDirectory(folder, { withFileTypes: true });
  } catch (error) {
    return [];
  }
}

// → [{ path, name }], sorted by path. `readDirectory` and `homeDirectory`
// are parameters so the dry tests can hand in a folder of their own.
export function findRepositories({
  roots = null,
  homeDirectory = os.homedir(),
  depth = REPOSITORY_SEARCH_DEPTH,
  readDirectory = fs.readdirSync
} = {}) {
  const startFolders = (roots && roots.length > 0 ? roots : USUAL_REPOSITORY_ROOTS.map((name) => path.join(homeDirectory, name)))
    .map((folder) => path.resolve(folder));
  const seen = new Set();
  const found = [];
  function walk(folder, remaining) {
    if (found.length >= MAXIMUM_REPOSITORIES || seen.has(folder)) {
      return;
    }
    seen.add(folder);
    const entries = entriesOf(folder, readDirectory);
    if (entries.some((entry) => entry.name === ".git")) {
      found.push({ path: folder, name: path.basename(folder) });
      return;
    }
    if (remaining <= 0) {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_FOLDERS.has(entry.name)) {
        walk(path.join(folder, entry.name), remaining - 1);
      }
    }
  }
  for (const folder of startFolders) {
    // "Projects" and "projects" are one folder on a case-insensitive disk.
    let realFolder = folder;
    try {
      realFolder = fs.realpathSync.native(folder);
    } catch (error) {
      continue;
    }
    walk(realFolder, depth);
  }
  return found.sort((first, second) => first.path.localeCompare(second.path));
}
