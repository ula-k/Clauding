// Turning a session's working directory into what the list shows: a short
// name, a color and a folder label.
//
// The path may have been written on either system, so the folders are split
// on both separators (folderSegments in lib/platformPaths.js) and a Windows
// drive letter is dropped — "C:\Users\ula\Documents\projects\website" reads
// as "…\projects\website", the same shape a Mac path gets.
import os from "node:os";
import {
  folderSegments,
  pathFor,
  shortenHomePath as shortenHomePathFor
} from "./lib/platformPaths.js";

// Soft palette, one color per project directory. Kept here rather than in
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

// The worktree shape, on either system:
//   …/notes/.claude/worktrees/new-idea   ->  { repository: "notes", worktree: "new-idea" }
function worktreeParts(segments) {
  const marker = segments.lastIndexOf("worktrees");
  if (marker <= 0 || segments[marker - 1] !== ".claude" || marker + 1 >= segments.length) {
    return null;
  }
  return {
    repository: segments[marker - 2] || "repo",
    worktree: segments.slice(marker + 1).join("/")
  };
}

// "/Users/<you>/Documents/projects/website" -> "website"
// "/Users/<you>/Documents/projects/notes/.claude/worktrees/new-idea" -> "notes › new-idea"
export function projectShortName(workingDirectory) {
  if (!workingDirectory) {
    return "unknown";
  }
  const segments = folderSegments(workingDirectory);
  const worktree = worktreeParts(segments);
  if (worktree) {
    return `${worktree.repository} › ${worktree.worktree}`;
  }
  if (segments.length === 0) {
    return "/";
  }
  return segments[segments.length - 1];
}

// "/Users/<you>/Documents/projects/website" -> "~/Documents/projects/website"
// "C:\Users\<you>\Documents\projects\website" -> "~\Documents\projects\website"
export function shortenHomePath(fullPath, options = {}) {
  return shortenHomePathFor(fullPath, { homeDirectory: os.homedir(), ...options });
}

// A label that reads as a folder, not a word:
//   "/Users/<you>/Documents/projects/website"                      -> "…/projects/website"
//   "/Users/<you>/Desktop/notes"                                   -> "~/Desktop/notes"
//   "/Users/<you>/Documents/projects/website/.claude/worktrees/fix-7" -> "…/website › fix-7"
export function projectFolderLabel(workingDirectory, options = {}) {
  if (!workingDirectory) {
    return "unknown";
  }
  const platform = options.platform || process.platform;
  const separator = pathFor(platform).sep;
  const segments = folderSegments(workingDirectory);
  const worktree = worktreeParts(segments);
  if (worktree) {
    return `…${separator}${worktree.repository} › ${worktree.worktree}`;
  }
  const homeRelative = shortenHomePath(workingDirectory, options);
  if (homeRelative === "~") {
    return "~";
  }
  if (homeRelative.startsWith(`~${separator}`)) {
    const homeSegments = folderSegments(homeRelative.slice(2));
    if (homeSegments.length <= 2) {
      return homeRelative;
    }
  }
  if (segments.length <= 2) {
    return `${separator}${segments.join(separator)}`;
  }
  return `…${separator}${segments.slice(-2).join(separator)}`;
}
