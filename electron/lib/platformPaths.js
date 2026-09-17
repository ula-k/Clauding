// Every path the app builds that has to come out right on more than one
// operating system.
//
// The rule in here: nothing reads `process.platform` or `os.homedir()` on its
// own. Both are parameters with the real values as defaults, so the Windows
// code paths can be walked on a Mac by handing in `platform: "win32"` and a
// made-up home folder (see test/platform.test.js). `pathFor()` picks
// `path.win32` or `path.posix`, so a Windows path is built with backslashes
// even while the test runs on macOS.
//
// What is assumed about Windows, and is written down here because nobody has
// been able to try it yet: Claude Code for Windows keeps the same registries
// in the same shapes as on macOS, under `%USERPROFILE%\.claude` —
// `sessions\<pid>.json`, `jobs\<shortId>\state.json`, `projects\…` — and
// `%USERPROFILE%\.claude.json` holds the `projects` map. Only the folder
// separator changes.
import nodePath from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

export const WINDOWS = "win32";
export const MACOS = "darwin";

export function isWindows(platform = process.platform) {
  return platform === WINDOWS;
}

export function isMacOS(platform = process.platform) {
  return platform === MACOS;
}

// `path.win32` or `path.posix`, so the same function builds a Windows path on
// a Mac and a macOS path on Windows.
export function pathFor(platform = process.platform) {
  return isWindows(platform) ? nodePath.win32 : nodePath.posix;
}

// The separator used between the folders of a PATH-like list.
export function pathListSeparator(platform = process.platform) {
  return isWindows(platform) ? ";" : ":";
}

// Windows compares paths without caring about case; the other two do care.
export function samePath(first, second, platform = process.platform) {
  const left = String(first || "");
  const right = String(second || "");
  if (!isWindows(platform)) {
    return left === right;
  }
  return left.toLowerCase() === right.toLowerCase();
}

// Is `candidate` the folder `parent` itself, or something inside it?
export function isInsideFolder(candidate, parent, platform = process.platform) {
  const pathModule = pathFor(platform);
  const child = String(candidate || "");
  const root = String(parent || "");
  if (!child || !root) {
    return false;
  }
  if (samePath(child, root, platform)) {
    return true;
  }
  const rootWithSeparator = root.endsWith(pathModule.sep) ? root : `${root}${pathModule.sep}`;
  if (!isWindows(platform)) {
    return child.startsWith(rootWithSeparator);
  }
  return child.toLowerCase().startsWith(rootWithSeparator.toLowerCase());
}

// The three registries Claude Code keeps, plus the two files next to them.
// Read-only for this app, and assumed to be the same JSON on Windows.
export function claudeRegistryPaths({ platform = process.platform, homeDirectory = os.homedir() } = {}) {
  const pathModule = pathFor(platform);
  const claudeHome = pathModule.join(homeDirectory, ".claude");
  return {
    claudeHome,
    sessionsRegistryDirectory: pathModule.join(claudeHome, "sessions"),
    jobsRegistryDirectory: pathModule.join(claudeHome, "jobs"),
    projectsDirectory: pathModule.join(claudeHome, "projects"),
    skillsDirectory: pathModule.join(claudeHome, "skills"),
    pluginsDirectory: pathModule.join(claudeHome, "plugins"),
    configurationFile: pathModule.join(homeDirectory, ".claude.json")
  };
}

// Where Electron puts `app.getPath("userData")` for this app. The running app
// asks Electron itself; this is for `bin/clauding`, which has no Electron and
// still has to find the app's channel when CLAUDING_SOCKET is not set.
export function defaultUserDataDirectory({
  platform = process.platform,
  homeDirectory = os.homedir(),
  environment = process.env
} = {}) {
  const pathModule = pathFor(platform);
  if (isWindows(platform)) {
    const roamingFolder = environment.APPDATA || pathModule.join(homeDirectory, "AppData", "Roaming");
    return pathModule.join(roamingFolder, "Clauding");
  }
  if (isMacOS(platform)) {
    return pathModule.join(homeDirectory, "Library", "Application Support", "Clauding");
  }
  const configurationHome = environment.XDG_CONFIG_HOME || pathModule.join(homeDirectory, ".config");
  return pathModule.join(configurationHome, "Clauding");
}

// Windows has no Unix domain sockets; `net` listens on a named pipe instead,
// and a pipe name is not a file path — it is never created, chmod-ed or
// unlinked.
export const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
export const COMMAND_SOCKET_FILE_NAME = "clauding.sock";

function pipeSuffixFrom(userIdentifier, userDataDirectory) {
  const named = String(userIdentifier === null || userIdentifier === undefined ? "" : userIdentifier)
    .replace(/[^A-Za-z0-9_-]+/g, "")
    .slice(0, 32);
  if (named) {
    return named;
  }
  return createHash("sha256").update(String(userDataDirectory || "")).digest("hex").slice(0, 16);
}

// The address the `clauding` command connects to: a socket file inside the
// app's own data folder on macOS, a per-user named pipe on Windows.
export function commandChannelPath({
  platform = process.platform,
  userDataDirectory,
  userIdentifier = null
} = {}) {
  if (!isWindows(platform)) {
    return pathFor(platform).join(userDataDirectory, COMMAND_SOCKET_FILE_NAME);
  }
  return `${WINDOWS_PIPE_PREFIX}clauding-${pipeSuffixFrom(userIdentifier, userDataDirectory)}`;
}

// True when the address is a real file on disk: only then is there anything
// to delete before listening, or to chmod afterwards.
export function commandChannelIsFile(channelPath) {
  return !String(channelPath || "").startsWith(WINDOWS_PIPE_PREFIX);
}

// What is prepended to PATH so a window started from the Dock (or from the
// Start Menu) finds the same tools a terminal would. Homebrew and
// /usr/local/bin mean nothing on Windows.
export function shellPathFolders({ platform = process.platform, homeDirectory = os.homedir() } = {}) {
  const pathModule = pathFor(platform);
  if (isWindows(platform)) {
    return [pathModule.join(homeDirectory, ".local", "bin")];
  }
  return [pathModule.join(homeDirectory, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

// The files to look for before falling back to PATH, in order.
export function claudeBinaryCandidates({ platform = process.platform, homeDirectory = os.homedir() } = {}) {
  const pathModule = pathFor(platform);
  const localBinFolder = pathModule.join(homeDirectory, ".local", "bin");
  if (isWindows(platform)) {
    return [pathModule.join(localBinFolder, "claude.exe"), pathModule.join(localBinFolder, "claude.cmd")];
  }
  return [pathModule.join(localBinFolder, "claude")];
}

// The names to ask PATH about when none of the candidates above exists.
export function claudeBinaryNamesOnPath(platform = process.platform) {
  return isWindows(platform) ? ["claude.exe", "claude.cmd"] : ["claude"];
}

// macOS reports the same temporary folder both with and without the /private
// prefix (/var/folders/… is a symlink to /private/var/folders/…). Nothing
// like that exists on Windows, so this stays a macOS-only fix-up.
export function withoutPrivatePrefix(folder, platform = process.platform) {
  const text = String(folder || "");
  if (!isMacOS(platform)) {
    return text;
  }
  return text.startsWith("/private/") ? text.slice("/private".length) : text;
}

// "~" / "~/Documents" -> the real folder. A Windows path is left alone unless
// it really starts with a tilde.
export function expandHomeFolder(target, { platform = process.platform, homeDirectory = os.homedir() } = {}) {
  const text = String(target || "");
  if (text === "~") {
    return homeDirectory;
  }
  if (text.startsWith("~/") || (isWindows(platform) && text.startsWith("~\\"))) {
    return pathFor(platform).join(homeDirectory, text.slice(2));
  }
  return text;
}

// "C:\Users\ula\Documents\projects\website" -> "~\Documents\projects\website"
export function shortenHomePath(fullPath, { platform = process.platform, homeDirectory = os.homedir() } = {}) {
  if (typeof fullPath !== "string") {
    return "";
  }
  const pathModule = pathFor(platform);
  if (samePath(fullPath, homeDirectory, platform)) {
    return "~";
  }
  const homeWithSeparator = `${homeDirectory}${pathModule.sep}`;
  const startsAtHome = isWindows(platform)
    ? fullPath.toLowerCase().startsWith(homeWithSeparator.toLowerCase())
    : fullPath.startsWith(homeWithSeparator);
  return startsAtHome ? `~${fullPath.slice(homeDirectory.length)}` : fullPath;
}

// The folders of a path, whichever separator was used to write it. A session
// recorded on Windows has backslashes; one recorded on a Mac has slashes, and
// the list has to read both because the app may be looking at either.
export function folderSegments(fullPath) {
  return String(fullPath || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .filter((segment) => !/^[A-Za-z]:$/.test(segment));
}

// The drive of a Windows path ("C:"), or "" for anything else.
export function driveLetterOf(fullPath) {
  const match = /^([A-Za-z]:)/.exec(String(fullPath || ""));
  return match ? match[1] : "";
}
