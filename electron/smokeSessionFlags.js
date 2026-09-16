// Dev-only automation (CLAUDING_SMOKE_SESSION_FLAGS=1) for "Extra claude
// flags…" on a session that already exists — the half that was missing:
// until now the flags of a conversation could only be typed before it
// started, so a running session could not be given a Telegram channel.
//
//   1. opens a terminal in the scratch folder and waits until it has a
//      session id;
//   2. opens the header's "…" menu and picks "Extra claude flags…" ->
//      the dialog, photographed as session-flags-dialog.png, with nothing
//      written yet;
//   3. presses Cancel and checks session-flags.json is still empty;
//   4. opens it again, types a flag in and presses "Save and restart
//      terminal": the store is written, the old pty is hung up and a new
//      `claude --resume <the same id>` carries the new flag — the composed
//      command line is printed and checked;
//   5. writes session-flags.json by hand and checks the running app picks
//      the change up by itself (the file watcher);
//   6. exits the terminal and takes its line out of the store again.
//
// With CLAUDING_DRY_SPAWN=1 nothing is spawned: the command lines are
// composed and checked, which is enough for steps 1–5 and costs nothing.
// Without it the run is real (a few cents) and the restarted terminal's own
// output is printed, so the `claude` banner shows the flag took effect.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
// NEVER this repository: a real run spawns `claude` here.
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const DRY_SESSION_ID = "dry-session-for-session-flags";
// Harmless and visible: the CLI's own banner says which model it runs.
const TYPED_FLAGS = process.env.CLAUDING_SMOKE_SESSION_FLAGS_TEXT || "--model sonnet";
const HAND_EDITED_FLAGS = "--channels plugin:telegram@claude-plugins-official";
const HELLO_PROMPT = "Say hello in one short line.";
const ESCAPE = "\x1b";
const DOWN_ARROW = "\x1b[B";

function wait(milliseconds) {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

async function capture(window, fileName) {
  if (!window || window.isDestroyed()) {
    return;
  }
  fs.mkdirSync(SMOKE_DIRECTORY, { recursive: true });
  window.webContents.invalidate();
  await wait(400);
  const image = await window.webContents.capturePage();
  const filePath = path.join(SMOKE_DIRECTORY, fileName);
  fs.writeFileSync(filePath, image.toPNG());
  console.log(`[session-flags-smoke] screenshot written to ${filePath}`);
}

function runInWindow(window, script) {
  return window.webContents.executeJavaScript(script);
}

function clickInWindow(window, selector) {
  return runInWindow(
    window,
    `(() => {
      const target = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((node) => node.offsetParent !== null) || document.querySelector(${JSON.stringify(selector)});
      if (target) { target.click(); }
      return Boolean(target);
    })()`
  );
}

function isOnScreen(window, selector) {
  return runInWindow(window, `Boolean(document.querySelector(${JSON.stringify(selector)}))`);
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

async function waitForPrompt(registry, terminalId) {
  let trustAnswered = false;
  await waitUntil(() => {
    const record = registry.get(terminalId);
    if (!record) {
      throw new Error("the terminal exited before the prompt appeared");
    }
    if (!trustAnswered && registry.recentPlainOutput(terminalId).includes("trust this folder")) {
      trustAnswered = true;
      console.log("[session-flags-smoke] answering the trust dialog with Yes");
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
  await wait(2000);
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

// The header's "…" menu, then the flags item in it.
async function openFlagsDialog(window) {
  await clickInWindow(window, "[data-header-menu-button]");
  await wait(800);
  const picked = await clickInWindow(window, '[data-menu-item="session-flags"]');
  if (!picked) {
    throw new Error('"Extra claude flags…" is not in the header menu');
  }
  await wait(900);
  if (!(await isOnScreen(window, "[data-session-flags-dialog]"))) {
    throw new Error("the flags dialog did not open");
  }
}

export async function runSessionFlagsSmoke({ window, registry, sessionFlags, sessionFlagsPath, dryRun, sendCommand, quit }) {
  let terminalId = null;
  let sessionId = null;
  try {
    fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
    await wait(2500);

    // A dry run never links a session id of its own, so it resumes an
    // invented one — everything after this point is the same either way.
    const opened = registry.open({
      workingDirectory: SMOKE_WORKING_DIRECTORY,
      resumeSessionId: dryRun ? DRY_SESSION_ID : null,
      columns: 120,
      rows: 40
    });
    terminalId = opened.terminalId;
    sendCommand({ action: "show-terminal", terminalId });
    if (dryRun) {
      sessionId = DRY_SESSION_ID;
      await wait(2000);
    } else {
      await waitForPrompt(registry, terminalId);
      sessionId = registry.get(terminalId).sessionId;
      await sendPrompt(registry, terminalId, HELLO_PROMPT);
    }
    console.log(`[session-flags-smoke] session ${sessionId} in ${SMOKE_WORKING_DIRECTORY}`);
    sessionFlags.remember(sessionId, "");

    // 1. The dialog itself, and nothing written by opening it.
    await openFlagsDialog(window);
    await capture(window, "session-flags-dialog.png");
    const shown = await runInWindow(
      window,
      `JSON.stringify({
        title: document.querySelector("[data-session-flags-dialog] .assign-dialog-title").innerText,
        field: document.querySelector("[data-session-flags-input]").value,
        effective: document.querySelector("[data-session-flags-effective]").innerText,
        saveOnly: Boolean(document.querySelector("[data-session-flags-save-only]")),
        saveAndRestart: Boolean(document.querySelector("[data-session-flags-save-restart]"))
      })`
    );
    console.log(`[session-flags-smoke] dialog: ${shown}`);
    const parsedDialog = JSON.parse(shown);
    if (!parsedDialog.saveOnly || !parsedDialog.saveAndRestart) {
      throw new Error("a session open in one of our terminals must be offered the restart");
    }

    // 2. Cancel writes nothing.
    await clickInWindow(window, "[data-session-flags-cancel]");
    await wait(1200);
    if (sessionFlags.flagsFor(sessionId)) {
      throw new Error("Cancel wrote the flags anyway");
    }
    if (!registry.get(terminalId)) {
      throw new Error("Cancel closed the terminal");
    }

    // 3. Type a flag in and save with the restart.
    await openFlagsDialog(window);
    await runInWindow(window, '(() => { document.querySelector("[data-session-flags-input]").focus(); return true; })()');
    await wait(300);
    window.webContents.insertText(TYPED_FLAGS);
    await wait(600);
    await capture(window, "session-flags-typed.png");
    await clickInWindow(window, "[data-session-flags-save-restart]");
    console.log(`[session-flags-smoke] pressed "Save and restart terminal" with ${TYPED_FLAGS}`);
    await waitUntil(() => sessionFlags.flagsFor(sessionId) === TYPED_FLAGS, 10000, "session-flags.json to be written");
    console.log(`[session-flags-smoke] session-flags.json: ${JSON.stringify(sessionFlags.get().sessionFlags)}`);

    const oldTerminalId = terminalId;
    let restarted = null;
    await waitUntil(async () => {
      restarted =
        registry.list().find((record) => record.terminalId !== oldTerminalId && record.sessionId === sessionId && !record.exited) ||
        null;
      return Boolean(restarted);
    }, 60000, "the restarted terminal");
    terminalId = restarted.terminalId;
    const commandLine = restarted.commandArguments.join(" ");
    console.log(`[session-flags-smoke] restarted: claude ${commandLine}`);
    if (registry.get(oldTerminalId)) {
      throw new Error("the old terminal is still running");
    }
    if (!commandLine.includes(`--resume ${sessionId}`)) {
      throw new Error(`the restart is not a resume of the same session: ${commandLine}`);
    }
    if (!commandLine.includes(TYPED_FLAGS)) {
      throw new Error(`the new flags are not on the command line: ${commandLine}`);
    }
    if (!dryRun) {
      await waitForPrompt(registry, terminalId);
      // The CLI's own banner names the model it is running, so the output
      // of the restarted terminal is the proof the flag took effect.
      console.log(`[session-flags-smoke] banner: ${registry.recentPlainOutput(terminalId, 4000).slice(0, 900)}`);
      await capture(window, "session-flags-restarted.png");
    }

    // 4. The file itself, edited behind the app's back: the watcher.
    fs.writeFileSync(
      sessionFlagsPath,
      `${JSON.stringify({ version: 1, sessionFlags: { [sessionId]: HAND_EDITED_FLAGS } }, null, 2)}\n`
    );
    await waitUntil(() => sessionFlags.flagsFor(sessionId) === HAND_EDITED_FLAGS, 15000, "the hand-edited file to be re-read");
    console.log(`[session-flags-smoke] a hand edit of session-flags.json was picked up without a restart: ${sessionFlags.flagsFor(sessionId)}`);

    if (!dryRun) {
      await leaveTerminal(registry, terminalId);
    } else {
      registry.close(terminalId);
    }
    terminalId = null;
    sessionFlags.remember(sessionId, "");
    console.log("[session-flags-smoke] the flags of an existing session can be changed and take effect on a restart");
    await wait(1000);
    quit();
  } catch (error) {
    console.log(`[session-flags-smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "session-flags-failed.png");
    if (terminalId) {
      registry.close(terminalId);
    }
    if (sessionId) {
      sessionFlags.remember(sessionId, "");
    }
    await wait(1000);
    quit();
  }
}
