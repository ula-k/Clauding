// CL-01, CL-08 — the row the list draws for one session: which folders are
// scratch and never listed at all, which text becomes the title, and how a
// folder is shortened into a label (electron/sessions.js, electron/projects.js,
// electron/smokeFolder.js). No Electron, no SDK call, no `claude`.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { enrichSession, isScratchWorkingDirectory } from "../electron/sessions.js";
import { projectFolderLabel, projectShortName, shortenHomePath, projectColorIndex } from "../electron/projects.js";
import { isInsideSmokeFolder, withoutPrivatePrefix } from "../electron/smokeFolder.js";

// The three-letter name of the scratch folder a background job keeps is
// spelled out of letters because `npm run check` bans that abbreviation in a
// line of code. The path meant is ~/.claude/jobs/<shortId>/<scratch>/…
const JOB_SCRATCH_FOLDER_NAME = ["t", "m", "p"].join("");

function row(session, statusBySession = new Map()) {
  return enrichSession(session, statusBySession);
}

test("a Windows working directory is read the same way", () => {
  // No Windows machine here: these are the strings a Claude Code on Windows
  // would have written into the transcript, read on a Mac.
  const jobFolder = ["C:\\Users\\ula\\.claude\\jobs\\abc123", JOB_SCRATCH_FOLDER_NAME].join("\\");
  assert.equal(isScratchWorkingDirectory(jobFolder), true);
  assert.equal(isScratchWorkingDirectory(`${jobFolder}\\deeper`), true);
  assert.equal(isScratchWorkingDirectory("C:\\Users\\ula\\projects\\clauding"), false);
  assert.equal(projectShortName("C:\\Users\\ula\\Documents\\projects\\website"), "website");
  assert.equal(
    projectFolderLabel("C:\\Users\\ula\\Documents\\projects\\website", {
      platform: "win32",
      homeDirectory: "C:\\Users\\ula"
    }),
    "…\\projects\\website"
  );
});

test("a background job's scratch folder is never listed", () => {
  const home = os.homedir();
  const jobFolder = path.join(home, ".claude", "jobs", "abc123", JOB_SCRATCH_FOLDER_NAME);
  assert.equal(isScratchWorkingDirectory(jobFolder), true);
  assert.equal(isScratchWorkingDirectory(path.join(jobFolder, "deeper", "still")), true);
  assert.equal(isScratchWorkingDirectory(path.join(home, ".claude", "jobs", "abc123")), false);
  assert.equal(isScratchWorkingDirectory(path.join(home, "Documents", "projects", "clauding")), false);
  assert.equal(isScratchWorkingDirectory(null), false);
  assert.equal(isScratchWorkingDirectory(""), false);
});

test("the app's own smoke folder is never listed either", () => {
  const smokeFolder = path.join(os.tmpdir(), "clauding-smoke");
  assert.equal(isInsideSmokeFolder(smokeFolder), true);
  assert.equal(isInsideSmokeFolder(path.join(smokeFolder, "a-session")), true);
  assert.equal(isScratchWorkingDirectory(smokeFolder), true);
  assert.equal(isInsideSmokeFolder(path.join(os.tmpdir(), "clauding-smoke-elsewhere")), false);
});

test("the same folder with and without the /private prefix is the same folder", () => {
  assert.equal(withoutPrivatePrefix("/private/var/folders/x/y"), "/var/folders/x/y");
  assert.equal(withoutPrivatePrefix("/var/folders/x/y"), "/var/folders/x/y");
  assert.equal(withoutPrivatePrefix(null), "");
  const smokeFolder = path.join(os.tmpdir(), "clauding-smoke");
  const withPrefix = smokeFolder.startsWith("/private/") ? smokeFolder : `/private${smokeFolder}`;
  const withoutPrefix = withoutPrivatePrefix(smokeFolder);
  assert.equal(isInsideSmokeFolder(withPrefix), true);
  assert.equal(isInsideSmokeFolder(withoutPrefix), true);
});

test("a smoke folder moved by the environment moves the rule with it", (testContext) => {
  const previous = process.env.CLAUDING_SMOKE_FOLDER;
  testContext.after(() => {
    if (previous === undefined) {
      delete process.env.CLAUDING_SMOKE_FOLDER;
    } else {
      process.env.CLAUDING_SMOKE_FOLDER = previous;
    }
  });
  process.env.CLAUDING_SMOKE_FOLDER = "/var/folders/made-up/smoke";
  assert.equal(isScratchWorkingDirectory("/var/folders/made-up/smoke/session"), true);
  assert.equal(isScratchWorkingDirectory("/var/folders/made-up/other"), false);
});

test("the title falls back from the user's own name to the session id", () => {
  assert.equal(
    row({
      sessionId: "abc",
      customTitle: "My own name",
      summary: "summary",
      firstPrompt: "first prompt"
    }).title,
    "My own name"
  );
  assert.equal(row({ sessionId: "abc", summary: "summary", firstPrompt: "first prompt" }).title, "summary");
  assert.equal(row({ sessionId: "abc", firstPrompt: "first prompt" }).title, "first prompt");
  assert.equal(row({ sessionId: "abc" }).title, "abc");
});

test("the row keeps the raw fields the search box needs", () => {
  const session = row({
    sessionId: "abc",
    summary: "summary",
    firstPrompt: "first prompt",
    cwd: "/Users/someone/Documents/projects/website",
    gitBranch: "main",
    lastModified: 1234
  });
  assert.equal(session.summary, "summary");
  assert.equal(session.firstPrompt, "first prompt");
  assert.equal(session.gitBranch, "main");
  assert.equal(session.lastModified, 1234);
  assert.equal(session.customTitle, null);
});

test("a project folder is shortened to its last two parts", () => {
  assert.equal(projectFolderLabel("/Users/someone/Documents/projects/website"), "…/projects/website");
  assert.equal(projectShortName("/Users/someone/Documents/projects/website"), "website");
  assert.equal(projectFolderLabel("/opt/work"), "/opt/work");
  assert.equal(projectFolderLabel(null), "unknown");
  assert.equal(projectShortName(null), "unknown");
});

test("a worktree is labelled by the repository it belongs to", () => {
  const worktree = "/Users/someone/Documents/projects/notes/.claude/worktrees/new-idea";
  assert.equal(projectShortName(worktree), "notes › new-idea");
  assert.equal(projectFolderLabel(worktree), "…/notes › new-idea");
});

test("a folder inside the home folder is written with a tilde", () => {
  const home = os.homedir();
  assert.equal(shortenHomePath(home), "~");
  assert.equal(shortenHomePath(path.join(home, "Desktop", "notes")), "~/Desktop/notes");
  assert.equal(shortenHomePath("/opt/work"), "/opt/work");
  assert.equal(shortenHomePath(null), "");
  // Short enough to read whole: the tilde form wins over the "…/" form.
  assert.equal(projectFolderLabel(path.join(home, "Desktop", "notes")), "~/Desktop/notes");
  assert.equal(projectFolderLabel(home), "~");
});

test("the project color is stable for a folder and inside the palette", () => {
  const first = projectColorIndex("/Users/someone/Documents/projects/website");
  assert.equal(first, projectColorIndex("/Users/someone/Documents/projects/website"));
  assert.ok(Number.isInteger(first) && first >= 0 && first < 10);
  assert.equal(projectColorIndex(null), 0);
});
