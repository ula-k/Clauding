// Dev-only automation (CLAUDING_SMOKE_PREAMBLE=1): proves the preamble
// reaches a **resumed** session, not only a fresh one. The bug it guards
// against: the CLI records a conversation's system prompt on its first
// request and replays that recording on every `--resume`, so without
// `--system-prompt-snapshot off` a session that was not born inside Clauding
// never learns about the right panel (one published a claude.ai Artifact
// instead of running `clauding open`).
//
// Steps, in a scratch folder (never this repository):
//   1. open a brand-new terminal, ask what app it runs inside and which
//      command opens a file on the right, print the answer;
//   2. /exit, then click the session's row: the click resumes it through the
//      real code path;
//   3. ask the same question again — the answer must still name Clauding and
//      `clauding open`;
//   4. run bin/clauding from a plain environment (no CLAUDING_TERMINAL_ID)
//      while that resumed session is the one on screen: the tab must land in
//      its panel through the "current session" fallback;
//   5. screenshot -> preamble-resume.png in CLAUDING_SMOKE_FOLDER.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const SMOKE_PAGE = process.env.CLAUDING_SMOKE_PAGE || path.join(SMOKE_WORKING_DIRECTORY, "smoke-page.html");
const PREAMBLE_QUESTION = "What app are you running inside and which exact command opens a file on the right? One line.";
const DOWN_ARROW = "\x1b[B";
const ESCAPE = "\x1b";

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
  console.log(`[preamble-smoke] screenshot written to ${filePath}`);
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
      console.log("[preamble-smoke] answering the trust dialog with Yes");
      registry.write(terminalId, `${DOWN_ARROW}\r`);
    }
    return Boolean(record.sessionId) && record.registryStatus === "idle";
  }, 60000, "the Claude Code prompt");
  await wait(1500);
}

async function runTurn(registry, terminalId, prompt) {
  registry.write(terminalId, prompt);
  await wait(600);
  registry.write(terminalId, "\r");
  let sawBusy = false;
  let lastPermissionAnswerAt = 0;
  await waitUntil(() => {
    const record = registry.get(terminalId);
    if (!record) {
      throw new Error("the terminal exited mid-turn");
    }
    if (record.registryStatus === "busy") {
      sawBusy = true;
    }
    const recent = registry.recentPlainOutput(terminalId, 1500);
    if (/Do you want to proceed\?/.test(recent) && Date.now() - lastPermissionAnswerAt > 4000) {
      lastPermissionAnswerAt = Date.now();
      console.log("[preamble-smoke] answering the permission prompt with Yes");
      registry.write(terminalId, "\r");
    }
    return sawBusy && record.registryStatus === "idle";
  }, 180000, `the turn "${prompt.slice(0, 30)}…" to finish`);
  await wait(3000);
}

// Exactly what a plain shell does: the `clauding` command with no
// CLAUDING_TERMINAL_ID in its environment.
function runCommandWithoutTerminalId(commandDirectory, commandArguments) {
  const environment = { ...process.env };
  delete environment.CLAUDING_TERMINAL_ID;
  return new Promise((resolve) => {
    execFile(
      path.join(commandDirectory, "clauding"),
      commandArguments,
      { cwd: SMOKE_WORKING_DIRECTORY, env: environment },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
      }
    );
  });
}

async function leaveTerminal(registry, terminalId) {
  registry.write(terminalId, ESCAPE);
  await wait(400);
  registry.write(terminalId, "/exit\r");
  await waitUntil(() => registry.get(terminalId) === null, 20000, "claude to exit");
}

export async function runPreambleSmoke({ window, registry, panelTabs, commandDirectory, sendCommand, quit }) {
  let terminalId = null;
  try {
    fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
    if (!fs.existsSync(SMOKE_PAGE)) {
      fs.writeFileSync(SMOKE_PAGE, "<!doctype html><title>Clauding smoke</title><h1>Clauding smoke page</h1>\n");
    }
    await wait(3000);

    // 1. A brand-new session.
    const opened = registry.open({ workingDirectory: SMOKE_WORKING_DIRECTORY, columns: 120, rows: 40 });
    terminalId = opened.terminalId;
    sendCommand({ action: "show-terminal", terminalId });
    await waitForPrompt(registry, terminalId);
    const linked = registry.get(terminalId);
    console.log(`[preamble-smoke] new session ${linked.sessionId} (pid ${linked.pid})`);
    await runTurn(registry, terminalId, PREAMBLE_QUESTION);
    console.log(`[preamble-smoke] NEW ANSWER: ${registry.recentPlainOutput(terminalId, 2500).slice(-600)}`);
    await capture(window, "preamble-new.png");

    // 2. Leave, then resume by clicking the row — the path a real click takes.
    await leaveTerminal(registry, terminalId);
    terminalId = null;
    await wait(3000);
    const clickedRow = await clickInWindow(window, `[data-session-row="${linked.sessionId}"]`);
    if (!clickedRow) {
      throw new Error("the session row is not on screen");
    }
    await waitUntil(
      () => registry.list().some((record) => record.resumeSessionId === linked.sessionId),
      8000,
      "the click to spawn a terminal"
    );
    terminalId = registry.list().find((record) => record.resumeSessionId === linked.sessionId).terminalId;
    await waitForPrompt(registry, terminalId);
    const resumed = registry.get(terminalId);
    console.log(`[preamble-smoke] resumed by click: session ${resumed.sessionId}, same=${resumed.sessionId === linked.sessionId}`);

    // 3. The same question in the resumed conversation.
    await runTurn(registry, terminalId, PREAMBLE_QUESTION);
    console.log(`[preamble-smoke] RESUMED ANSWER: ${registry.recentPlainOutput(terminalId, 2500).slice(-600)}`);

    // 4. `clauding open` from a plain environment, no terminal id at all.
    // The row is clicked once more first, so the session on screen is beyond
    // doubt this one (anything else on this Mac may have moved the selection).
    await clickInWindow(window, `[data-session-row="${resumed.sessionId}"]`);
    await wait(2000);
    const planPage = process.env.CLAUDING_SMOKE_PLAN_PAGE || SMOKE_PAGE;
    const commandResult = await runCommandWithoutTerminalId(commandDirectory, ["open", planPage]);
    console.log(
      `[preamble-smoke] clauding open without CLAUDING_TERMINAL_ID -> exit ${commandResult.code}: ${commandResult.stdout || commandResult.stderr}`
    );
    await waitUntil(
      () => panelTabs.get(resumed.sessionId).tabs.some((tab) => tab.target === planPage),
      6000,
      "the tab to appear in the resumed session's panel"
    );
    console.log(
      `[preamble-smoke] tabs of the resumed session: ${JSON.stringify(panelTabs.get(resumed.sessionId).tabs.map((tab) => tab.target))}`
    );
    await wait(4000);
    await capture(window, "preamble-resume.png");

    await leaveTerminal(registry, terminalId);
    terminalId = null;
    await wait(800);
    quit();
  } catch (error) {
    console.log(`[preamble-smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "preamble-failed.png");
    for (const record of registry.list()) {
      registry.close(record.terminalId);
    }
    await wait(1000);
    quit();
  }
}
