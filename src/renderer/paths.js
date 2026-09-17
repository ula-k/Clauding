// Renderer-side twin of projectFolderLabel() in electron/projects.js, for
// paths the renderer only has as a raw string (a folder picked in the dialog).
//
// The renderer has no `os.homedir()`, so the home folder is recognized by its
// shape: "/Users/<name>" on macOS, "/home/<name>" on Linux, and
// "C:\Users\<name>" on Windows. Either separator is accepted, because the
// string may have been written on either system.
const HOME_FOLDER_PATTERN = /^(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/]+/;

export function separatorOf(folderPath) {
  return folderPath.includes("\\") ? "\\" : "/";
}

export function segmentsOf(folderPath) {
  return folderPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .filter((segment) => !/^[A-Za-z]:$/.test(segment));
}

export function folderLabel(folderPath) {
  if (!folderPath) {
    return "";
  }
  const separator = separatorOf(folderPath);
  const homeRelative = folderPath.replace(HOME_FOLDER_PATTERN, "~");
  if (homeRelative === "~") {
    return "~";
  }
  if (homeRelative.startsWith(`~${separator}`) && segmentsOf(homeRelative.slice(2)).length <= 2) {
    return homeRelative;
  }
  const segments = segmentsOf(folderPath);
  if (segments.length <= 2) {
    return `${separator}${segments.join(separator)}`;
  }
  return `…${separator}${segments.slice(-2).join(separator)}`;
}

// "/Users/you/.claude/skills/skill-maker" -> "~/.claude/skills/skill-maker"
// "C:\Users\you\.claude\skills\skill-maker" -> "~\.claude\skills\skill-maker"
export function shortenHomeFolder(folderPath) {
  return String(folderPath || "").replace(HOME_FOLDER_PATTERN, "~");
}

// The folder one level up, whichever separator the path was written with.
export function parentFolderOf(filePath) {
  const text = String(filePath || "");
  const lastSeparator = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return lastSeparator <= 0 ? "" : text.slice(0, lastSeparator);
}

// The address a <webview> is given for a local file.
//   /Users/me/page.html        -> file:///Users/me/page.html
//   C:\Users\me\page.html      -> file:///C:/Users/me/page.html
// A Windows path needs the third slash and forward separators; without them
// the guest reads the drive letter as a URL scheme and shows nothing.
export function fileUrlFor(filePath) {
  const text = String(filePath || "");
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    return `file:///${encodeURI(text.replace(/\\/g, "/"))}`;
  }
  return `file://${encodeURI(text)}`;
}

// The address line over the panel, split so the folder can be dimmed:
//   "/Users/<you>/Desktop/page.html"      -> "/Users/<you>/Desktop/" + "page.html"
//   "C:\Users\<you>\Desktop\page.html"    -> "C:\Users\<you>\Desktop\" + "page.html"
//   "https://example.com/docs/"           -> "https://example.com/" + "docs/"
export function splitAddress(target) {
  const withoutTrailingSlash = target.length > 1 ? target.replace(/[\\/]$/, "") : target;
  const lastSeparator = Math.max(withoutTrailingSlash.lastIndexOf("/"), withoutTrailingSlash.lastIndexOf("\\"));
  if (lastSeparator <= 0 || (target.startsWith("http") && lastSeparator < target.indexOf("//") + 2)) {
    return { folder: "", name: target };
  }
  return {
    folder: withoutTrailingSlash.slice(0, lastSeparator + 1),
    name: withoutTrailingSlash.slice(lastSeparator + 1)
  };
}

// The last part of a path: the file name, or the folder's own name.
export function lastSegmentOf(fullPath) {
  const segments = segmentsOf(String(fullPath || ""));
  return segments.length > 0 ? segments[segments.length - 1] : "";
}
