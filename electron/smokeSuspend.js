// Dev-only automation (CLAUDING_SMOKE_SUSPEND=1): a Ctrl+Z that got through
// anyway is undone by the main process on its own. Runs in the scratch
// folder only:
//   1. opens a terminal, waits for the Claude Code prompt;
//   2. writes the raw Ctrl+Z byte (0x1a) straight into the pty through the
//      registry — past the renderer's key handler, which would have turned
//      it into the CLI's undo — and watches `ps` until the process is
//      stopped (state T);
//   3. waits for the registry's watcher to continue it (state no longer T)
//      and says how long that took;
//   4. types "Reply with exactly: ok", prints the answer and photographs the
//      window -> ctrl-z-recovered.png (CLAUDING_SMOKE_SCREENSHOT overrides
//      the path);
//   5. Terminal -> Restart terminal, the same thing the menu item runs: the
//      same terminal id must come back to its prompt.
// Screenshots go to CLAUDING_SMOKE_FOLDER. Costs a cent or two.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
// NEVER this repository: the smoke runs `claude` for real.
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const SCREENSHOT_PATH = process.env.CLAUDING_SMOKE_SCREENSHOT || path.join(SMOKE_DIRECTORY, "ctrl-z-recovered.png");
const OK_PROMPT = "Reply with exactly: ok";
const SUSPEND_BYTE = "\x1a";
const DOWN_ARROW = "\x1b[B";
const ESCAPE = "\x1b";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function capture(window, filePath) {
  if (!window || window.isDestroyed()) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const image = await window.webContents.capturePage();
  fs.writeFileSync(filePath, image.toPNG());
  console.log(`[suspend-smoke] screenshot written to ${filePath}`);
}

async function waitUntil(condition, timeoutMilliseconds, description, pollMilliseconds = 500) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await wait(pollMilliseconds);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function processState(processId) {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(processId)], { encoding: "utf8" }).trim();
  } catch (error) {
    return "";
  }
}

async function waitForPrompt(registry, terminalId) {
  let trustAnswered = false;
  await waitUntil(() => {
    const record = registry.get(terminalId);
    if (!record || record.exited) {
      throw new Error("the terminal exited before the prompt appeared");
    }
    if (!trustAnswered && registry.recentPlainOutput(terminalId).includes("trust this folder")) {
      trustAnswered = true;
      console.log("[suspend-smoke] answering the trust dialog with Yes");
      registry.write(terminalId, `${DOWN_ARROW}\r`);
    }
    return Boolean(record.sessionId) && record.registryStatus === "idle";
  }, 90000, "the Claude Code prompt");
  await wait(1500);
}

async function sendPrompt(registry, terminalId, prompt) {
  registry.write(terminalId, prompt);
  await wait(600);
  registry.write(terminalId, "\r");
  let sawBusy = false;
  await waitUntil(() => {
    const record = registry.get(terminalId);
    if (!record || record.exited) {
      throw new Error("the terminal exited mid-turn");
    }
    if (record.registryStatus === "busy") {
      sawBusy = true;
    }
    return sawBusy && record.registryStatus === "idle";
  }, 120000, `the turn "${prompt}"`);
  await wait(2000);
}

export async function runSuspendSmoke({ window, registry, sendCommand, quit }) {
  let terminalId = null;
  try {
    fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
    await wait(3000);
    const opened = registry.open({ workingDirectory: SMOKE_WORKING_DIRECTORY, columns: 120, rows: 40 });
    terminalId = opened.terminalId;
    sendCommand({ action: "show-terminal", terminalId });
    await waitForPrompt(registry, terminalId);
    const processId = registry.get(terminalId).pid;
    console.log(`[suspend-smoke] prompt ready, pid ${processId}, state ${processState(processId)}`);

    const sentAt = Date.now();
    registry.write(terminalId, SUSPEND_BYTE);
    // Under a pty with no shell the kernel drops the CLI's SIGTSTP (orphaned
    // process group), so "suspended" is usually its own sentence with the
    // process still in state S — the watcher handles both.
    let suspendedAt = 0;
    let suspendedHow = "";
    await waitUntil(() => {
      const state = processState(processId);
      const sentence = registry.recentPlainOutput(terminalId, 1500).includes("has been suspended");
      if (state.startsWith("T") || sentence) {
        suspendedAt = Date.now();
        suspendedHow = `state ${state}${sentence ? ", CLI printed its suspended sentence" : ""}`;
        return true;
      }
      return false;
    }, 5000, "the CLI to suspend after 0x1a", 50);
    console.log(`[suspend-smoke] SUSPENDED: ${suspendedHow}, ${suspendedAt - sentAt} ms after 0x1a`);
    await waitUntil(
      () => registry.recentPlainOutput(terminalId, 4000).includes("resumed automatically") && !processState(processId).startsWith("T"),
      5000,
      "the watcher to continue it",
      50
    );
    const resumedAt = Date.now();
    console.log(`[suspend-smoke] RESUMED: state ${processState(processId)}, note in the pane ${resumedAt - suspendedAt} ms after the suspend`);
    await wait(1500);
    console.log(`[suspend-smoke] pane after resume: ${registry.recentPlainOutput(terminalId, 800).slice(-400)}`);

    await sendPrompt(registry, terminalId, OK_PROMPT);
    console.log(`[suspend-smoke] ANSWER TAIL: ${registry.recentPlainOutput(terminalId, 1200).slice(-500)}`);
    await capture(window, SCREENSHOT_PATH);

    const before = registry.get(terminalId);
    const restart = registry.restartInPlace(terminalId);
    console.log(`[suspend-smoke] restart from the menu path: ${JSON.stringify(restart)}`);
    await waitUntil(() => {
      const record = registry.get(terminalId);
      return Boolean(record) && !record.exited && record.pid !== before.pid;
    }, 15000, "the same terminal id to get a new process");
    await waitForPrompt(registry, terminalId);
    const after = registry.get(terminalId);
    console.log(
      `[suspend-smoke] RESTARTED: same terminal ${after.terminalId === before.terminalId}, pid ${before.pid} -> ${after.pid}, ` +
        `session ${before.sessionId} -> ${after.sessionId}, arguments ${after.commandArguments.slice(0, 2).join(" ")}`
    );
    await capture(window, path.join(path.dirname(SCREENSHOT_PATH), "ctrl-z-restarted.png"));

    registry.write(terminalId, ESCAPE);
    await wait(600);
    registry.write(terminalId, "/exit\r");
    await wait(4000);
    quit();
  } catch (error) {
    console.log(`[suspend-smoke] failed: ${error && error.message ? error.message : error}`);
    if (terminalId) {
      console.log(`[suspend-smoke] pane tail: ${registry.recentPlainOutput(terminalId, 1200).slice(-600)}`);
    }
    await capture(window, path.join(path.dirname(SCREENSHOT_PATH), "ctrl-z-failed.png"));
    for (const record of registry.list()) {
      registry.close(record.terminalId);
    }
    await wait(1500);
    quit();
  }
}
