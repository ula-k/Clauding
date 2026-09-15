// Dev-only automation (CLAUDING_SMOKE_FORK=1) for the Fork button. Everything
// happens in a scratch folder — never this repository — and the Fork itself is
// pressed in the real UI (`[data-fork-button]`), so the whole renderer → IPC →
// terminal registry path is exercised, not a shortcut through the registry.
//
//   1. opens a terminal in the scratch folder, waits for the prompt and asks
//      the CLI to reply "pong" so there is a conversation worth copying;
//   2. puts that session into a group of its own, so the group rule can be
//      checked afterwards;
//   3. presses Fork -> a second terminal, a new session id, the original left
//      running -> fork-both.png (both rows in the list, the fork's terminal
//      showing the inherited conversation);
//   4. clicks the original row again -> fork-original.png (still alive, its
//      scrollback intact);
//   5. makes the original busy (counting slowly) and forks it while it counts
//      -> fork-busy.png, printing whatever the CLI said about the session
//      being in use.
// Screenshots go to CLAUDING_SMOKE_FOLDER. Costs a few cents.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
// NEVER this repository: the smoke runs `claude` for real.
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const PONG_PROMPT = "Reply with exactly: pong";
const COUNT_PROMPT =
  "Count out loud from 1 to 40, one number per line, and wait about one second between the numbers. No tools, just the numbers.";
const FORK_GROUP_NAME = "Fork smoke";
const ESCAPE = "\x1b";
const DOWN_ARROW = "\x1b[B";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function capture(window, fileName) {
  if (!window || window.isDestroyed()) {
    return;
  }
  fs.mkdirSync(SMOKE_DIRECTORY, { recursive: true });
  const image = await window.webContents.capturePage();
  const filePath = path.join(SMOKE_DIRECTORY, fileName);
  fs.writeFileSync(filePath, image.toPNG());
  console.log(`[fork-smoke] screenshot written to ${filePath}`);
}

async function waitUntil(condition, timeoutMilliseconds, description) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await wait(500);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function clickInWindow(window, selector) {
  return window.webContents.executeJavaScript(
    `(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (target) { target.click(); } return Boolean(target); })()`
  );
}

function readRowTitles(window) {
  return window.webContents.executeJavaScript(
    '(() => Array.from(document.querySelectorAll("[data-session-row]")).map((row) => row.textContent.trim()))()'
  );
}

async function waitForPrompt(registry, terminalId) {
  let trustAnswered = false;
  await waitUntil(() => {
    const record = registry.get(terminalId);
    if (!record) {
      throw new Error("the terminal exited before the prompt appeared");
    }
    if (!trustAnswered && registry.recentPlainOutput(terminalId).includes("trust this folder")) {
      trustAnswered = true;
      console.log("[fork-smoke] answering the trust dialog with Yes");
      registry.write(terminalId, `${DOWN_ARROW}\r`);
    }
    return Boolean(record.sessionId) && record.registryStatus === "idle";
  }, 90000, "the Claude Code prompt");
  await wait(1500);
}

// Sends a prompt; `waitForIdle` false returns as soon as the CLI is busy,
// which is what the busy-session fork test needs.
async function sendPrompt(registry, terminalId, prompt, { waitForIdle = true } = {}) {
  registry.write(terminalId, prompt);
  await wait(600);
  registry.write(terminalId, "\r");
  let sawBusy = false;
  await waitUntil(() => {
    const record = registry.get(terminalId);
    if (!record) {
      throw new Error("the terminal exited mid-turn");
    }
    if (record.registryStatus === "busy") {
      sawBusy = true;
    }
    return waitForIdle ? sawBusy && record.registryStatus === "idle" : sawBusy;
  }, 180000, `the turn "${prompt.slice(0, 30)}…"`);
  if (waitForIdle) {
    await wait(2500);
  }
}

function prepareSmokeFolder() {
  fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
}

async function leaveTerminal(registry, terminalId) {
  if (!registry.get(terminalId)) {
    return;
  }
  registry.write(terminalId, ESCAPE);
  await wait(600);
  registry.write(terminalId, "/exit\r");
  try {
    await waitUntil(() => registry.get(terminalId) === null, 20000, "claude to exit");
  } catch (error) {
    registry.close(terminalId);
  }
}

// The terminal the Fork button just created: a fork record whose origin is
// the session we forked and whose own session id is already known.
function forkTerminalOf(registry, originalSessionId) {
  return (
    registry
      .list()
      .find((record) => record.forkedFromSessionId === originalSessionId && record.sessionId && !record.exited) || null
  );
}

export async function runForkSmoke({ window, registry, sessionGroups, sendCommand, quit }) {
  const openedTerminalIds = [];
  let borrowedGroupId = null;
  try {
    prepareSmokeFolder();
    await wait(3000);

    // 1. A session with something in it.
    const opened = registry.open({ workingDirectory: SMOKE_WORKING_DIRECTORY, columns: 120, rows: 40 });
    openedTerminalIds.push(opened.terminalId);
    sendCommand({ action: "show-terminal", terminalId: opened.terminalId });
    console.log(`[fork-smoke] original terminal ${opened.terminalId} opened, pid ${opened.pid}`);
    await waitForPrompt(registry, opened.terminalId);
    const original = registry.get(opened.terminalId);
    console.log(`[fork-smoke] prompt ready, session ${original.sessionId}`);
    await sendPrompt(registry, opened.terminalId, PONG_PROMPT);
    console.log(`[fork-smoke] original answered: ${registry.recentPlainOutput(opened.terminalId, 600).slice(-200)}`);

    // 2. A group of its own, so the "fork joins the original's group" rule is testable.
    const forkGroup = sessionGroups.createGroup(FORK_GROUP_NAME);
    borrowedGroupId = forkGroup.id;
    sessionGroups.assignSession(original.sessionId, forkGroup.id);
    console.log(`[fork-smoke] original put into group "${FORK_GROUP_NAME}" (${forkGroup.id})`);
    await wait(1500);

    // 3. The Fork button in the real header.
    const pressedFork = await clickInWindow(window, "[data-fork-button]");
    if (!pressedFork) {
      throw new Error("the Fork button is not on screen");
    }
    console.log("[fork-smoke] Fork pressed");
    await waitUntil(() => forkTerminalOf(registry, original.sessionId) !== null, 60000, "the fork to register a session id");
    const fork = forkTerminalOf(registry, original.sessionId);
    openedTerminalIds.push(fork.terminalId);
    console.log(
      `[fork-smoke] fork terminal ${fork.terminalId}, pid ${fork.pid}, session ${fork.sessionId}, ` +
        `different from the original: ${fork.sessionId !== original.sessionId}, name "${fork.sessionName}"`
    );
    const originalStillAlive = registry.get(opened.terminalId);
    console.log(
      `[fork-smoke] original terminal still alive: ${Boolean(originalStillAlive && !originalStillAlive.exited)}, ` +
        `pid ${originalStillAlive && originalStillAlive.pid}`
    );
    await waitForPrompt(registry, fork.terminalId);
    const forkOutput = registry.recentPlainOutput(fork.terminalId, 4000);
    console.log(`[fork-smoke] fork carries the conversation (says "pong"): ${forkOutput.includes("pong")}`);
    await wait(4000);
    console.log(`[fork-smoke] rows on screen: ${JSON.stringify(await readRowTitles(window))}`);
    await capture(window, "fork-both.png");

    const membership = sessionGroups.get().membership;
    console.log(
      `[fork-smoke] fork's group: ${membership[fork.sessionId]} (original's: ${membership[original.sessionId]}), ` +
        `same: ${membership[fork.sessionId] === membership[original.sessionId]}`
    );

    // 4. Back to the original: still running, scrollback intact.
    const clickedOriginal = await clickInWindow(window, `[data-session-row="${original.sessionId}"]`);
    await wait(2500);
    const originalReplay = registry.replay(opened.terminalId);
    console.log(
      `[fork-smoke] back on the original (clicked: ${clickedOriginal}), scrollback ${originalReplay.length} characters, ` +
        `still has the "pong" turn: ${originalReplay.includes(PONG_PROMPT)}`
    );
    await capture(window, "fork-original.png");

    // 5. Fork while the original is busy.
    console.log("[fork-smoke] making the original busy…");
    await sendPrompt(registry, opened.terminalId, COUNT_PROMPT, { waitForIdle: false });
    await wait(2500);
    const busyRecord = registry.get(opened.terminalId);
    console.log(`[fork-smoke] original status before the second fork: ${busyRecord.registryStatus}`);
    const pressedBusyFork = await clickInWindow(window, "[data-fork-button]");
    if (!pressedBusyFork) {
      throw new Error("the Fork button is not on screen while the original is busy");
    }
    await wait(12000);
    const busyForks = registry.list().filter((record) => record.forkedFromSessionId === original.sessionId);
    const busyFork = busyForks.find((record) => record.terminalId !== fork.terminalId) || null;
    if (busyFork) {
      openedTerminalIds.push(busyFork.terminalId);
      console.log(
        `[fork-smoke] busy-session fork: terminal ${busyFork.terminalId}, pid ${busyFork.pid}, ` +
          `session ${busyFork.sessionId || "(not registered yet)"}, status ${busyFork.registryStatus}`
      );
      console.log(`[fork-smoke] busy-session fork output tail: ${registry.recentPlainOutput(busyFork.terminalId, 4000).slice(-1200)}`);
    } else {
      console.log("[fork-smoke] the busy-session fork produced no terminal record");
    }
    const originalDuringBusyFork = registry.get(opened.terminalId);
    console.log(
      `[fork-smoke] original during the busy fork: alive ${Boolean(originalDuringBusyFork)}, ` +
        `status ${originalDuringBusyFork && originalDuringBusyFork.registryStatus}`
    );
    await capture(window, "fork-busy.png");

    // Tidy up: stop the counting, close everything the smoke opened.
    registry.write(opened.terminalId, ESCAPE);
    await wait(1500);
    for (const terminalId of openedTerminalIds) {
      await leaveTerminal(registry, terminalId);
    }
    // The smoke borrowed a group from the user's list; give it back.
    if (borrowedGroupId) {
      sessionGroups.deleteGroup(borrowedGroupId);
      console.log("[fork-smoke] the borrowed group was deleted again");
    }
    await wait(1000);
    quit();
  } catch (error) {
    console.log(`[fork-smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "fork-failed.png");
    for (const record of registry.list()) {
      registry.close(record.terminalId);
    }
    if (borrowedGroupId) {
      sessionGroups.deleteGroup(borrowedGroupId);
    }
    await wait(1000);
    quit();
  }
}
