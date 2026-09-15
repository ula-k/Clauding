import path from "node:path";
import os from "node:os";

// Soft palette, one colour per project directory. Kept here rather than in
// CSS so the main process can ship a ready-to-use index to the renderer.
export const PROJECT_COLOR_COUNT = 10;

function hashText(text) {
  let hash = 5381;
  for (let position = 0; position < text.length; position += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(position)) >>> 0;
  }
  return hash;
}

export function projectColorIndex(workingDirectory) {
  if (!workingDirectory) {
    return 0;
  }
  return hashText(workingDirectory) % PROJECT_COLOR_COUNT;
}

// "/Users/<you>/Documents/projects/website" -> "website"
// "/Users/<you>/Documents/projects/notes/.claude/worktrees/new-idea" -> "notes › new-idea"
export function projectShortName(workingDirectory) {
  if (!workingDirectory) {
    return "unknown";
  }
  const segments = workingDirectory.split(path.sep).filter(Boolean);
  const worktreeMarker = segments.lastIndexOf("worktrees");
  if (
    worktreeMarker > 0 &&
    segments[worktreeMarker - 1] === ".claude" &&
    worktreeMarker + 1 < segments.length
  ) {
    const repositoryName = segments[worktreeMarker - 2] || "repo";
    const worktreeName = segments.slice(worktreeMarker + 1).join("/");
    return `${repositoryName} › ${worktreeName}`;
  }
  if (segments.length === 0) {
    return "/";
  }
  return segments[segments.length - 1];
}

// "/Users/<you>/Documents/projects/website" -> "~/Documents/projects/website"
export function shortenHomePath(fullPath) {
  if (typeof fullPath !== "string") {
    return "";
  }
  const home = os.homedir();
  if (fullPath === home) {
    return "~";
  }
  if (fullPath.startsWith(home + path.sep)) {
    return "~" + fullPath.slice(home.length);
  }
  return fullPath;
}

// A label that reads as a folder, not a word:
//   "/Users/<you>/Documents/projects/website"                      -> "…/projects/website"
//   "/Users/<you>/Desktop/notes"                                   -> "~/Desktop/notes"
//   "/Users/<you>/Documents/projects/website/.claude/worktrees/fix-7" -> "…/website › fix-7"
export function projectFolderLabel(workingDirectory) {
  if (!workingDirectory) {
    return "unknown";
  }
  const segments = workingDirectory.split(path.sep).filter(Boolean);
  const worktreeMarker = segments.lastIndexOf("worktrees");
  if (
    worktreeMarker > 0 &&
    segments[worktreeMarker - 1] === ".claude" &&
    worktreeMarker + 1 < segments.length
  ) {
    const repositoryName = segments[worktreeMarker - 2] || "repo";
    const worktreeName = segments.slice(worktreeMarker + 1).join("/");
    return `…/${repositoryName} › ${worktreeName}`;
  }
  const homeRelative = shortenHomePath(workingDirectory);
  if (homeRelative === "~") {
    return "~";
  }
  if (homeRelative.startsWith("~/")) {
    const homeSegments = homeRelative.slice(2).split("/").filter(Boolean);
    if (homeSegments.length <= 2) {
      return homeRelative;
    }
  }
  if (segments.length <= 2) {
    return "/" + segments.join("/");
  }
  return `…/${segments.slice(-2).join("/")}`;
}
