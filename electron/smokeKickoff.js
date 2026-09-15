// Dev-only automation (CLAUDING_SMOKE_KICKOFF=1) for the two meta actions —
// "Harvest skills" and "Create agent from this conversation" — and the thing
// that was broken about them: the fork used to sit at an empty prompt
// because its job was only in the system prompt. Both buttons are pressed in
// the real UI, so renderer → IPC → terminal registry → pty is exercised.
//
//   1. a session in the scratch folder with one turn in it ("pong"), so
//      there is a conversation worth forking;
//   2. Harvest skills -> the fork must start working on its own: its
//      kickoffState goes to "sent" and the CLI goes busy without anybody
//      typing -> harvest-kickoff.png;
//   3. back to the original, then Create agent -> the same again ->
//      create-agent-kickoff.png.
// Everything the forks write lands in the scratch folder: the isolated
// profile this runs with points agentsRoot and skillsRoot there.
// Screenshots go to CLAUDING_SMOKE_FOLDER. Costs a few cents.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
// NEVER this repository: the smoke runs `claude` for real.
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const PONG_PROMPT = "Reply with exactly: pong";
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
  console.log(`[kickoff-smoke] screenshot written to ${filePath}`);
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

async function waitForPrompt(registry, terminalId) {
  let trustAnswered = false;
  await waitUntil(() => {
    const record = registry.get(terminalId);
    if (!record) {
      throw new Error("the terminal exited before the prompt appeared");
    }
    if (!trustAnswered && registry.recentPlainOutput(terminalId).includes("trust this folder")) {
      trustAnswered = true;
      console.log("[kickoff-smoke] answering the trust dialog with Yes");
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
    if (!record) {
      throw new Error("the terminal exited mid-turn");
    }
    if (record.registryStatus === "busy") {
      sawBusy = true;
    }
    return sawBusy && record.registryStatus === "idle";
  }, 180000, `the turn "${prompt.slice(0, 30)}…"`);
  await wait(2500);
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

// The terminal one of the two buttons has just created.
function newForkOf(registry, originalSessionId, knownTerminalIds) {
  return (
    registry
      .list()
      .find(
        (record) =>
          record.forkedFromSessionId === originalSessionId && !record.exited && !knownTerminalIds.has(record.terminalId)
      ) || null
  );
}

// Presses one of the two buttons and watches what the fork does with itself:
// the kickoff has to be sent, and the CLI has to go busy without a keystroke
// from anybody.
async function runMetaAction({ window, registry, original, knownTerminalIds, buttonSelector, label, screenshot }) {
  const pressed = await clickInWindow(window, buttonSelector);
  if (!pressed) {
    throw new Error(`the ${label} button is not on screen`);
  }
  console.log(`[kickoff-smoke] ${label} pressed`);
  await waitUntil(() => newForkOf(registry, original.sessionId, knownTerminalIds) !== null, 90000, `the ${label} fork`);
  const fork = newForkOf(registry, original.sessionId, knownTerminalIds);
  knownTerminalIds.add(fork.terminalId);
  console.log(`[kickoff-smoke] ${label} fork terminal ${fork.terminalId}, pid ${fork.pid}, kickoff ${fork.kickoffState}`);
  await waitUntil(() => {
    const record = registry.get(fork.terminalId);
    return Boolean(record) && record.kickoffState === "sent";
  }, 120000, `the ${label} kickoff to be typed in`);
  const afterKickoff = registry.get(fork.terminalId);
  console.log(
    `[kickoff-smoke] ${label} kickoff sent, session ${afterKickoff.sessionId}, ` +
      `input seen so far (xterm's own answers included): ${afterKickoff.receivedInput}`
  );
  // Working on its own: busy, then an answer.
  let sawBusy = false;
  await waitUntil(() => {
    const record = registry.get(fork.terminalId);
    if (!record) {
      throw new Error(`the ${label} fork exited`);
    }
    if (record.registryStatus === "busy") {
      sawBusy = true;
    }
    return sawBusy;
  }, 120000, `the ${label} fork to start working`);
  console.log(`[kickoff-smoke] ${label} fork went busy on its own`);
  await wait(45000);
  const record = registry.get(fork.terminalId);
  console.log(`[kickoff-smoke] ${label} fork status now: ${record && record.registryStatus}`);
  console.log(`[kickoff-smoke] ${label} fork output tail: ${registry.recentPlainOutput(fork.terminalId, 5000).slice(-1500)}`);
  await capture(window, screenshot);
  return fork;
}

export async function runKickoffSmoke({ window, registry, settings, sendCommand, quit }) {
  const openedTerminalIds = [];
  try {
    fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
    const current = settings.get();
    console.log(`[kickoff-smoke] agentsRoot ${current.agentsRoot}, skillsRoot ${current.skillsRoot}`);
    await wait(3000);

    const opened = registry.open({ workingDirectory: SMOKE_WORKING_DIRECTORY, columns: 120, rows: 40 });
    openedTerminalIds.push(opened.terminalId);
    sendCommand({ action: "show-terminal", terminalId: opened.terminalId });
    await waitForPrompt(registry, opened.terminalId);
    const original = registry.get(opened.terminalId);
    console.log(`[kickoff-smoke] original session ${original.sessionId}`);
    await sendPrompt(registry, opened.terminalId, PONG_PROMPT);
    console.log(`[kickoff-smoke] original answered: ${registry.recentPlainOutput(opened.terminalId, 600).slice(-160)}`);

    const knownTerminalIds = new Set(openedTerminalIds);
    const harvest = await runMetaAction({
      window,
      registry,
      original,
      knownTerminalIds,
      buttonSelector: "[data-harvest-skills-button]",
      label: "Harvest skills",
      screenshot: "harvest-kickoff.png"
    });
    openedTerminalIds.push(harvest.terminalId);

    // Back to the original: the second button forks the same conversation.
    await clickInWindow(window, `[data-session-row="${original.sessionId}"]`);
    await wait(2500);
    const createAgent = await runMetaAction({
      window,
      registry,
      original,
      knownTerminalIds,
      buttonSelector: "[data-create-agent-button]",
      label: "Create agent",
      screenshot: "create-agent-kickoff.png"
    });
    openedTerminalIds.push(createAgent.terminalId);

    console.log(
      `[kickoff-smoke] sessions: original ${original.sessionId}, harvest ${registry.get(harvest.terminalId) && registry.get(harvest.terminalId).sessionId}, ` +
        `create-agent ${registry.get(createAgent.terminalId) && registry.get(createAgent.terminalId).sessionId}`
    );
    for (const terminalId of openedTerminalIds) {
      await leaveTerminal(registry, terminalId);
    }
    await wait(1000);
    quit();
  } catch (error) {
    console.log(`[kickoff-smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "kickoff-failed.png");
    for (const record of registry.list()) {
      registry.close(record.terminalId);
    }
    await wait(1000);
    quit();
  }
}
