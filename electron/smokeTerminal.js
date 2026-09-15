// Dev-only automation (CLAUDING_SMOKE_TERMINAL=1). Opens a terminal in a
// scratch folder (never this repository), waits for the Claude Code prompt
// and walks through stage 4:
//   1. asks the CLI to run `clauding open <plan page>` and reply "pong"
//      (answers the CLI's permission prompt with Yes) -> stage4-panel.png:
//      the terminal in the middle and the page in the right panel;
//   2. runs bin/clauding itself with the terminal's id to open a Markdown
//      file -> stage4-md.png (a Markdown tab);
//   3. asks what app it runs inside and which command opens a file on the
//      right, and prints the answer (proves the preamble reached the CLI);
//   4. switches to another session and back, reloads the renderer;
//   5. /exit, then clicks the session's row (now in Recent): the click must
//      spawn `claude --resume` on its own -> stage4-click.png.
// Screenshots go to CLAUDING_SMOKE_FOLDER (default: the OS temporary
// folder). Costs a few cents.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
// NEVER this repository: a smoke session runs `claude` for real, and one that
// was pointed at the app's own folder edited the app's own code. The default
// is a scratch folder, created here if it does not exist.
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const SMOKE_PAGE = process.env.CLAUDING_SMOKE_PAGE || path.join(SMOKE_WORKING_DIRECTORY, "smoke-page.html");
const SMOKE_MARKDOWN = process.env.CLAUDING_SMOKE_MARKDOWN || path.join(SMOKE_WORKING_DIRECTORY, "smoke-notes.md");
const SMOKE_URL = process.env.CLAUDING_SMOKE_URL || "https://example.com/";
const OPEN_PROMPT = `Run: clauding open ${SMOKE_PAGE} — then reply with exactly: pong`;
const PREAMBLE_PROMPT = "What app are you running inside and what command opens a file on the right? Reply in one line.";
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
  console.log(`[smoke] screenshot written to ${filePath}`);
}

// Polls until `condition()` is true; rejects after the timeout.
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
      console.log("[smoke] answering the trust dialog with Yes");
      registry.write(terminalId, `${DOWN_ARROW}\r`);
    }
    return Boolean(record.sessionId) && record.registryStatus === "idle";
  }, 60000, "the Claude Code prompt");
  await wait(1500);
}

// Sends a prompt and waits for the turn to finish, pressing Enter ("Yes")
// on the CLI's permission prompt when it shows up.
async function runTurn(registry, terminalId, prompt) {
  // A long chunk counts as a paste for the CLI (Enter inside it becomes a
  // newline), so the text and the Enter are sent separately.
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
      console.log("[smoke] answering the permission prompt with Yes");
      registry.write(terminalId, "\r");
    }
    return sawBusy && record.registryStatus === "idle";
  }, 180000, `the turn "${prompt.slice(0, 30)}…" to finish`);
  await wait(3000);
}

// The scratch folder and the two files the smoke opens in the panel; the
// app repository is never touched.
function prepareSmokeFolder() {
  fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
  if (!fs.existsSync(SMOKE_PAGE)) {
    fs.writeFileSync(SMOKE_PAGE, "<!doctype html><title>Clauding smoke</title><h1>Clauding smoke page</h1>\n");
  }
  if (!fs.existsSync(SMOKE_MARKDOWN)) {
    fs.writeFileSync(SMOKE_MARKDOWN, "# Clauding smoke notes\n\nA Markdown file for the right panel.\n");
  }
}

function runCommandLine(commandDirectory, commandArguments, terminalId) {
  return new Promise((resolve) => {
    execFile(
      path.join(commandDirectory, "clauding"),
      commandArguments,
      {
        cwd: SMOKE_WORKING_DIRECTORY,
        env: { ...process.env, CLAUDING_TERMINAL_ID: terminalId }
      },
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

export async function runTerminalSmoke({ window, registry, panelTabs, commandDirectory, sendCommand, quit }) {
  let terminalId = null;
  try {
    prepareSmokeFolder();
    await wait(3000);
    const opened = registry.open({ workingDirectory: SMOKE_WORKING_DIRECTORY, columns: 120, rows: 40 });
    terminalId = opened.terminalId;
    sendCommand({ action: "show-terminal", terminalId });
    console.log(`[smoke] terminal ${terminalId} opened, pid ${opened.pid}`);

    await waitForPrompt(registry, terminalId);
    const linked = registry.get(terminalId);
    console.log(`[smoke] prompt ready, session ${linked.sessionId}`);

    // 1. The CLI opens the plan page on the right through `clauding open`.
    await runTurn(registry, terminalId, OPEN_PROMPT);
    await waitUntil(() => panelTabs.get(linked.sessionId).tabs.some((tab) => tab.target === SMOKE_PAGE), 5000, "the panel tab");
    console.log(`[smoke] panel tabs: ${JSON.stringify(panelTabs.get(linked.sessionId).tabs.map((tab) => tab.target))}`);
    await wait(3000);
    await capture(window, "stage4-panel.png");

    // 2. bin/clauding straight from here, with the terminal's id: a Markdown tab.
    const commandResult = await runCommandLine(commandDirectory, ["open", path.relative(SMOKE_WORKING_DIRECTORY, SMOKE_MARKDOWN)], terminalId);
    console.log(`[smoke] clauding open the Markdown file -> exit ${commandResult.code}: ${commandResult.stdout || commandResult.stderr}`);
    const tabsResult = await runCommandLine(commandDirectory, ["tabs"], terminalId);
    console.log(`[smoke] clauding tabs ->\n${tabsResult.stdout || tabsResult.stderr}`);
    await wait(2500);
    await capture(window, "stage4-md.png");
    const urlResult = await runCommandLine(commandDirectory, ["open", SMOKE_URL], terminalId);
    console.log(`[smoke] clauding open ${SMOKE_URL} -> exit ${urlResult.code}: ${urlResult.stdout || urlResult.stderr}`);
    await wait(4000);
    await capture(window, "stage4-url.png");

    // 3. Does the CLI know where it runs?
    await runTurn(registry, terminalId, PREAMBLE_PROMPT);
    // The transcript reader is gone with the read-only preview, so the
    // answer is read straight off the terminal's own output.
    const answer = registry.recentPlainOutput(terminalId, 2000);
    console.log(`[smoke] preamble answer (terminal output tail): ${answer.slice(-400)}`);

    // 4. Switch to another session and back, then reload the renderer: the
    // same terminal (and its panel tabs) must come back.
    // A row that is running outside the app: clicking it can never spawn a
    // `claude` of its own, so the switch cannot start work in someone's
    // project folder. (Falls back to any other row if nothing is running.)
    const otherRowSelector = `[data-session-row][data-running-elsewhere="1"]:not([data-session-row="${linked.sessionId}"])`;
    let clickedOther = await clickInWindow(window, otherRowSelector);
    if (!clickedOther) {
      console.log("[smoke] nothing is running outside the app; switching to the next row instead");
      clickedOther = await clickInWindow(window, `[data-session-row]:not([data-session-row="${linked.sessionId}"])`);
    }
    await wait(2500);
    const clickedBack = await clickInWindow(window, `[data-session-row="${linked.sessionId}"]`);
    await wait(1500);
    console.log(`[smoke] switched away (${clickedOther}) and back (${clickedBack}); terminals alive: ${registry.list().length}`);
    window.webContents.reload();
    await wait(3000);
    const clickedAfterReload = await clickInWindow(window, `[data-session-row="${linked.sessionId}"]`);
    await wait(2000);
    console.log(`[smoke] reloaded renderer, re-selected the session (${clickedAfterReload})`);
    await capture(window, "stage4-reloaded.png");

    // Close the other terminals a click may have opened in step 4.
    for (const record of registry.list()) {
      if (record.terminalId !== terminalId) {
        registry.close(record.terminalId);
      }
    }
    await leaveTerminal(registry, terminalId);
    console.log("[smoke] claude exited cleanly");
    terminalId = null;
    await wait(2500);

    // 5. The session is idle now: clicking its row must resume it here, no button.
    const clickedRow = await clickInWindow(window, `[data-session-row="${linked.sessionId}"]`);
    if (!clickedRow) {
      throw new Error("the session row is not on screen");
    }
    await waitUntil(() => registry.list().some((record) => record.resumeSessionId === linked.sessionId), 5000, "the click to spawn a terminal");
    terminalId = registry.list().find((record) => record.resumeSessionId === linked.sessionId).terminalId;
    await waitForPrompt(registry, terminalId);
    const resumed = registry.get(terminalId);
    console.log(
      `[smoke] click resumed: pid ${resumed.pid}, session ${resumed.sessionId}, same=${resumed.sessionId === linked.sessionId}, openedByClick=${resumed.openedByClick}`
    );
    await wait(1500);
    await capture(window, "stage4-click.png");
    await leaveTerminal(registry, terminalId);
    terminalId = null;
    await wait(800);
    quit();
  } catch (error) {
    console.log(`[smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "stage4-failed.png");
    for (const record of registry.list()) {
      registry.close(record.terminalId);
    }
    await wait(1000);
    quit();
  }
}
