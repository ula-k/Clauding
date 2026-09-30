// Dev-only automation (CLAUDING_SMOKE_RESTORE=1, then =2 with the same
// --user-data-dir): the terminals open when the app closed are offered back,
// and a session is never resumed twice at once.
//   phase 1: opens a terminal in CLAUDING_SMOKE_RESTORE_FOLDER (a scratch
//            folder), gets "ok" out of it so there is a conversation to
//            resume, prints open-terminals.json and quits the ordinary way;
//   phase 2: (a fresh start) checks that nothing was spawned, that the row
//            says "was open" and is selected with its note -> restore-offer.png;
//            then clicks the row twice fast and also asks the main process
//            for the same resume twice at once, straight over IPC (past the
//            window's own guard) — exactly one `claude --resume <id>` may
//            exist afterwards -> restore-resumed.png.
// Screenshots go to CLAUDING_SMOKE_FOLDER. The restore folder must not be
// inside CLAUDING_SMOKE_FOLDER, or the list hides the session in phase 2.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { smokeFolderPath } from "./smokeFolder.js";
import { OPEN_TERMINALS_FILE_NAME } from "./openTerminals.js";

const SMOKE_DIRECTORY = smokeFolderPath();
const RESTORE_FOLDER = process.env.CLAUDING_SMOKE_RESTORE_FOLDER || path.join(os.tmpdir(), "clauding-smoke", "restore-work");
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
  console.log(`[restore-smoke] screenshot written to ${filePath}`);
}

async function waitUntil(condition, timeoutMilliseconds, description) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await wait(500);
  }
  throw new Error(`timed out waiting for ${description}`);
}

// Every `claude` on this machine resuming this session, however started.
function resumeProcessesFor(sessionId) {
  const listing = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return listing
    .split("\n")
    .filter((line) => line.includes(`--resume ${sessionId}`) && !line.includes(" ps -axo"))
    .map((line) => line.trim());
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
      registry.write(terminalId, `${DOWN_ARROW}\r`);
    }
    return Boolean(record.sessionId) && record.registryStatus === "idle";
  }, 90000, "the Claude Code prompt");
  await wait(1500);
}

async function phaseOne({ window, registry, sendCommand, userDataDirectory, quit }) {
  fs.mkdirSync(RESTORE_FOLDER, { recursive: true });
  await wait(3000);
  const opened = registry.open({ workingDirectory: RESTORE_FOLDER, columns: 120, rows: 40 });
  sendCommand({ action: "show-terminal", terminalId: opened.terminalId });
  await waitForPrompt(registry, opened.terminalId);
  registry.write(opened.terminalId, "Reply with exactly: ok");
  await wait(600);
  registry.write(opened.terminalId, "\r");
  let sawBusy = false;
  await waitUntil(() => {
    const record = registry.get(opened.terminalId);
    sawBusy = sawBusy || (record && record.registryStatus === "busy");
    return sawBusy && record.registryStatus === "idle";
  }, 180000, "the answer");
  await wait(2000);
  const record = registry.get(opened.terminalId);
  console.log(`[restore-smoke] phase 1 session ${record.sessionId}, answer tail: ${registry.recentPlainOutput(opened.terminalId, 600).slice(-200)}`);
  await wait(1500);
  console.log(`[restore-smoke] open-terminals.json before quit: ${fs.readFileSync(path.join(userDataDirectory, OPEN_TERMINALS_FILE_NAME), "utf8")}`);
  quit();
}

async function phaseTwo({ window, registry, userDataDirectory, quit }) {
  console.log(`[restore-smoke] open-terminals.json at start: ${fs.readFileSync(path.join(userDataDirectory, OPEN_TERMINALS_FILE_NAME), "utf8")}`);
  const stored = JSON.parse(fs.readFileSync(path.join(userDataDirectory, OPEN_TERMINALS_FILE_NAME), "utf8"));
  const sessionId = stored.terminals[0].sessionId;
  const rowSelector = `[data-session-row="${sessionId}"]`;
  await waitUntil(
    () => window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-row-was-open="${sessionId}"]'))`),
    30000,
    "the row to say was open"
  );
  await wait(1500);
  const middleMode = await window.webContents.executeJavaScript(
    `(() => { const note = document.querySelector("[data-middle-mode]"); return note ? note.getAttribute("data-middle-mode") + " | " + note.textContent : "none"; })()`
  );
  console.log(`[restore-smoke] after start: terminals ${registry.list().length}, resume processes ${resumeProcessesFor(sessionId).length}, middle column: ${middleMode}`);
  await capture(window, "restore-offer.png");

  // Two fast clicks on the row, and two resumes asked of the main process at
  // once, past the window's own guard.
  await window.webContents.executeJavaScript(
    `(() => { const row = document.querySelector(${JSON.stringify(rowSelector)}); row.click(); row.click(); return true; })()`
  );
  const direct = await window.webContents.executeJavaScript(
    `Promise.all([1, 2].map(() => window.clauding.openTerminal({ workingDirectory: ${JSON.stringify(RESTORE_FOLDER)}, resumeSessionId: ${JSON.stringify(sessionId)}, columns: 120, rows: 40 }))).then((answers) => answers.map((answer) => ({ terminalId: answer.terminalId, reused: Boolean(answer.reused), refused: Boolean(answer.refused) })))`
  );
  console.log(`[restore-smoke] two direct opens answered: ${JSON.stringify(direct)}`);
  await wait(6000);
  const processes = resumeProcessesFor(sessionId);
  console.log(`[restore-smoke] RESUME PROCESSES: ${processes.length}\n${processes.join("\n")}`);
  console.log(`[restore-smoke] terminals in the registry: ${registry.list().length}`);
  const terminal = registry.list().find((record) => record.sessionId === sessionId);
  await waitForPrompt(registry, terminal.terminalId);
  await capture(window, "restore-resumed.png");
  registry.write(terminal.terminalId, ESCAPE);
  await wait(600);
  registry.write(terminal.terminalId, "/exit\r");
  await wait(4000);
  quit();
}

export async function runRestoreSmoke(options) {
  const phase = process.env.CLAUDING_SMOKE_RESTORE;
  try {
    if (phase === "2") {
      await phaseTwo(options);
    } else {
      await phaseOne(options);
    }
  } catch (error) {
    console.log(`[restore-smoke] phase ${phase} failed: ${error && error.message ? error.message : error}`);
    await capture(options.window, `restore-failed-${phase}.png`);
    for (const record of options.registry.list()) {
      options.registry.close(record.terminalId);
    }
    await wait(1500);
    options.quit();
  }
}
