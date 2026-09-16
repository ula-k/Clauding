// "Check for new version…" in the Clauding menu.
//
// The app is not shipped through an update server: it runs from a git
// checkout that the user (or `npm run install-app`) built themselves. So a
// version check is a `git fetch` and a comparison against `origin/main`, and
// an update is the four commands they would type by hand — pull, install,
// build, install-app.
//
// Nothing here knows about Electron: the decision is one pure function
// (`updatePlan`, covered by test/updater.test.js) and the rest is running
// commands. The dialogs and the progress sheet live in electron/main.js and
// electron/updateSheet.js.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// The checkout the app runs from: electron/ is one folder down from it.
export function projectRootFolder() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export const FETCH_TIMEOUT_MILLISECONDS = 30000;
// A build or an npm install is allowed to take its time.
export const STEP_TIMEOUT_MILLISECONDS = 600000;
// How often the quiet check at startup is allowed to run.
export const QUIET_CHECK_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1000;

// What the user would have to do in a terminal when the checkout is not in a
// state the app may touch.
export const UPDATE_BY_HAND_ADVICE =
  "Local changes or another branch — update from a terminal: " +
  "git pull && npm install && npm run build && npm run install-app";

function runCommand(command, commandArguments, { cwd, timeout }) {
  return new Promise((resolve) => {
    execFile(
      command,
      commandArguments,
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (error, standardOutput, standardError) => {
        resolve({
          ok: !error,
          output: String(standardOutput || ""),
          errorOutput: String(standardError || ""),
          message: error ? String(error.message || error) : ""
        });
      }
    );
  });
}

// The last few lines of whatever a failed step said, for the error dialog.
export function lastLinesOf(text, howMany = 12) {
  return String(text || "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-howMany)
    .join("\n");
}

export function localVersion(projectRoot = projectRootFolder()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version || "";
  } catch (error) {
    return "";
  }
}

export function isGitCheckout(projectRoot = projectRootFolder()) {
  return fs.existsSync(path.join(projectRoot, ".git"));
}

// Everything the plan needs, read from git. The fetch is read-only: it moves
// origin/main and touches nothing in the working tree.
export async function readRemoteState(projectRoot = projectRootFolder()) {
  if (!isGitCheckout(projectRoot)) {
    return { ok: false, reason: "notACheckout", projectRoot };
  }
  const fetched = await runCommand("git", ["fetch", "origin"], {
    cwd: projectRoot,
    timeout: FETCH_TIMEOUT_MILLISECONDS
  });
  if (!fetched.ok) {
    return {
      ok: false,
      reason: "fetchFailed",
      projectRoot,
      details: lastLinesOf(`${fetched.errorOutput}\n${fetched.message}`)
    };
  }
  const branchResult = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: projectRoot,
    timeout: FETCH_TIMEOUT_MILLISECONDS
  });
  const statusResult = await runCommand("git", ["status", "--porcelain"], {
    cwd: projectRoot,
    timeout: FETCH_TIMEOUT_MILLISECONDS
  });
  const behindResult = await runCommand("git", ["rev-list", "--count", "HEAD..origin/main"], {
    cwd: projectRoot,
    timeout: FETCH_TIMEOUT_MILLISECONDS
  });
  const remotePackage = await runCommand("git", ["show", "origin/main:package.json"], {
    cwd: projectRoot,
    timeout: FETCH_TIMEOUT_MILLISECONDS
  });
  let remoteVersion = "";
  try {
    remoteVersion = JSON.parse(remotePackage.output).version || "";
  } catch (error) {
    remoteVersion = "";
  }
  return {
    ok: true,
    projectRoot,
    branch: branchResult.output.trim(),
    clean: statusResult.ok && statusResult.output.trim() === "",
    behindCount: Number(behindResult.output.trim()) || 0,
    localVersion: localVersion(projectRoot),
    remoteVersion
  };
}

// The whole decision, as a value: is there anything new, may the app update
// the checkout by itself, and what the dialog says. Pure, so the wording and
// the rules are checked without a network or a git repository.
export function updatePlan({ localVersion: installedVersion, remoteVersion, behindCount, clean, branch }) {
  const installed = String(installedVersion || "").trim();
  const available = String(remoteVersion || "").trim();
  const changeCount = Number(behindCount) || 0;
  if (changeCount <= 0) {
    return {
      updateAvailable: false,
      canUpdateInApp: false,
      blockedBy: null,
      newVersion: null,
      changeCount: 0,
      headline: `You're up to date (${installed})`,
      detail: ""
    };
  }
  const shownVersion = available && available !== installed ? available : installed;
  const changeWords = changeCount === 1 ? "1 new change" : `${changeCount} new changes`;
  let blockedBy = null;
  if (String(branch || "").trim() !== "main") {
    blockedBy = "branch";
  } else if (!clean) {
    blockedBy = "changes";
  }
  return {
    updateAvailable: true,
    canUpdateInApp: blockedBy === null,
    blockedBy,
    newVersion: shownVersion,
    changeCount,
    headline: `Clauding ${shownVersion} is available`,
    detail: `${changeWords} since your version (${installed}). Update now?`
  };
}

// The Clauding menu's item. Quiet checks only ever change this text — there
// is no badge, no banner and nothing new in the window.
export function updateMenuItemLabel(plan) {
  if (plan && plan.updateAvailable && plan.newVersion) {
    return `Update available (${plan.newVersion})…`;
  }
  return "Check for new version…";
}

// The four commands, in order. `onStep` is told which one is running so the
// progress sheet can say so.
export const UPDATE_STEPS = [
  { name: "git pull --ff-only", command: "git", commandArguments: ["pull", "--ff-only"] },
  { name: "npm install", command: "npm", commandArguments: ["install"] },
  { name: "npm run build", command: "npm", commandArguments: ["run", "build"] },
  { name: "npm run install-app", command: "npm", commandArguments: ["run", "install-app"] }
];

export async function runUpdateSteps({ projectRoot = projectRootFolder(), onStep = null } = {}) {
  for (const step of UPDATE_STEPS) {
    if (onStep) {
      onStep(step.name);
    }
    const result = await runCommand(step.command, step.commandArguments, {
      cwd: projectRoot,
      timeout: STEP_TIMEOUT_MILLISECONDS
    });
    if (!result.ok) {
      return {
        ok: false,
        failedStep: step.name,
        details: lastLinesOf(`${result.output}\n${result.errorOutput}\n${result.message}`)
      };
    }
  }
  return { ok: true };
}

// The once-a-day check remembers when it last ran, next to the app's other
// small files.
export function readLastQuietCheck(userDataFolder) {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(userDataFolder, "update-check.json"), "utf8"));
    return Number(stored.lastCheckedAt) || 0;
  } catch (error) {
    return 0;
  }
}

export function writeLastQuietCheck(userDataFolder, when = Date.now()) {
  try {
    fs.mkdirSync(userDataFolder, { recursive: true });
    fs.writeFileSync(
      path.join(userDataFolder, "update-check.json"),
      `${JSON.stringify({ lastCheckedAt: when }, null, 2)}\n`
    );
  } catch (error) {
    // A check that cannot be remembered simply runs again next time.
  }
}

export function quietCheckIsDue(lastCheckedAt, now = Date.now()) {
  return now - (Number(lastCheckedAt) || 0) >= QUIET_CHECK_INTERVAL_MILLISECONDS;
}
