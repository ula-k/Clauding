// Dev-only automation (CLAUDING_SMOKE_PASTE=1). Pasting a file into a
// terminal, for real, in a scratch folder — never this repository:
//   1. photographs the window and saves it as a PNG file, so there is a real
//      picture on disk to paste;
//   2. puts that FILE on the clipboard the way Finder does (NSPasteboard
//      writeObjects with its file URL, checked until the board really holds
//      it — AppleScript's own `set the clipboard to (POSIX file …)` lands a
//      beat late every few runs) and clicks Edit → Paste itself — the very
//      handler ⌘V runs, focus resolution included: the pty must receive the
//      quoted path;
//   3. does it again with the paths a drop hands over (a name with a space),
//      which is the drag-and-drop route through the same code;
//   4. puts the RAW image on the clipboard (`«class PNGf»`) and pastes: a
//      file has to appear under <userData>/pasted/ and its path be typed;
//   5. asks Claude what is in the image at that path and prints the answer —
//      which is the whole point: the CLI reads the file, not a 39 kB icon;
//   6. and, before all that, plain text on the clipboard: ⌘V must still be
//      the ordinary paste, which xterm does itself.
// Screenshots go to CLAUDING_SMOKE_FOLDER (default: the OS temporary
// folder). Costs a few cents.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";
import { readPasteboardFilePaths } from "./pasteSmart.js";

const SMOKE_DIRECTORY = smokeFolderPath();
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
// A name with a space in it: if the quoting is wrong, the CLI sees two words.
const SOURCE_IMAGE = path.join(SMOKE_WORKING_DIRECTORY, "pasted shot.png");
const IMAGE_QUESTION = "What is in the image at that path? One line.";
const CLIPBOARD_SETTLE_MILLISECONDS = 400;
const ESCAPE = "\x1b";
const DOWN_ARROW = "\x1b[B";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Copies with `osascript` and waits a moment, the way a hand would. The file
// flavors are read straight from NSPasteboard, so even pasting in the same
// breath works, but the image one goes through Chromium's clipboard, whose
// view of the board needs a beat after another process wrote it.
async function copyWithOsascript(script) {
  const result = await new Promise((resolve) => {
    execFile("osascript", ["-e", script], (error, stdout, stderr) => {
      resolve({ failed: Boolean(error), output: String(stdout || stderr).trim() });
    });
  });
  await wait(CLIPBOARD_SETTLE_MILLISECONDS);
  return result;
}

// Puts one file on the clipboard the way Finder does, and does not come back
// until the pasteboard really holds it: the same reader the app uses says so.
async function copyFileToClipboard(filePath) {
  const script = [
    'ObjC.import("AppKit");',
    "const board = $.NSPasteboard.generalPasteboard;",
    "board.clearContents;",
    `board.writeObjects($([$.NSURL.fileURLWithPath(${JSON.stringify(filePath)})]));`,
    '"";'
  ].join("\n");
  await new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script], () => resolve());
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const onTheBoard = await readPasteboardFilePaths();
    if (onTheBoard.includes(filePath)) {
      return true;
    }
    await wait(200);
  }
  return false;
}

async function capture(window, fileName) {
  if (!window || window.isDestroyed()) {
    return null;
  }
  fs.mkdirSync(SMOKE_DIRECTORY, { recursive: true });
  const image = await window.webContents.capturePage();
  const filePath = path.join(SMOKE_DIRECTORY, fileName);
  fs.writeFileSync(filePath, image.toPNG());
  console.log(`[smoke] screenshot written to ${filePath}`);
  return filePath;
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

// Sends Enter on a prompt that already holds the pasted path plus a question,
// and waits for the turn to finish, answering the CLI's permission prompt.
async function finishTurn(registry, terminalId, description) {
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
  }, 180000, description);
  await wait(2500);
}

// The input line is cleared between pastes, so each one starts from scratch:
// Escape empties the CLI's prompt, Ctrl+U the line of anything that ignores it.
function clearPrompt(registry, terminalId) {
  registry.write(terminalId, ESCAPE);
  registry.write(terminalId, "\x15");
}

export async function runPasteSmoke({
  window,
  registry,
  pastedDirectory,
  // Edit → Paste's own handler: what ⌘V does, focus resolution and all.
  pasteThroughMenu,
  // The other way in: the paths a drop on the pane hands over.
  pasteIntoTerminal,
  sendCommand,
  quit
}) {
  let terminalId = null;
  try {
    fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
    await wait(3000);
    const opened = registry.open({ workingDirectory: SMOKE_WORKING_DIRECTORY, columns: 120, rows: 40 });
    terminalId = opened.terminalId;
    sendCommand({ action: "show-terminal", terminalId });
    console.log(`[smoke] terminal ${terminalId} opened, pid ${opened.pid}`);
    await waitForPrompt(registry, terminalId);

    // 0. Plain text: nothing is typed by us, xterm pastes it.
    const clipboardText = "hello from the clipboard";
    const textCopied = await copyWithOsascript(`set the clipboard to ${JSON.stringify(clipboardText)}`);
    console.log(`[smoke] osascript put text on the clipboard (failed=${textCopied.failed}) ${textCopied.output}`);
    await pasteThroughMenu();
    await wait(1200);
    const afterTextPaste = registry.recentPlainOutput(terminalId, 1200);
    console.log(
      `[smoke] text paste: the prompt holds it = ${afterTextPaste.includes(clipboardText)} …${afterTextPaste.slice(-120)}`
    );
    clearPrompt(registry, terminalId);
    await wait(500);

    // 1. A real picture on disk: the app's own window.
    const windowImage = await window.webContents.capturePage();
    fs.writeFileSync(SOURCE_IMAGE, windowImage.toPNG());
    console.log(`[smoke] source image: ${SOURCE_IMAGE} (${fs.statSync(SOURCE_IMAGE).size} bytes)`);

    // 2. The file on the clipboard, the way Finder copies it.
    const copied = await copyFileToClipboard(SOURCE_IMAGE);
    console.log(`[smoke] the file is on the clipboard: ${copied}`);
    await pasteThroughMenu();
    console.log("[smoke] Edit -> Paste clicked with the file on the clipboard");
    await wait(1500);
    const afterFilePaste = registry.recentPlainOutput(terminalId, 2000);
    console.log(`[smoke] the prompt now reads: …${afterFilePaste.slice(-160)}`);

    // 5a. The CLI reads the file at the path it was handed.
    registry.write(terminalId, ` ${IMAGE_QUESTION}`);
    await wait(600);
    await finishTurn(registry, terminalId, "the answer about the pasted file");
    console.log(`[smoke] answer about the pasted FILE: ${registry.recentPlainOutput(terminalId, 2500).slice(-500)}`);
    await capture(window, "paste-file.png");

    // 3. The same write a drop on the pane asks for.
    clearPrompt(registry, terminalId);
    await wait(500);
    const dropResult = await pasteIntoTerminal(terminalId, [SOURCE_IMAGE]);
    console.log(`[smoke] dropped path -> ${JSON.stringify(dropResult)}`);
    await wait(1200);
    console.log(`[smoke] the prompt now reads: …${registry.recentPlainOutput(terminalId, 1200).slice(-160)}`);

    // 4. A raw image on the clipboard, with no file flavor at all.
    clearPrompt(registry, terminalId);
    await wait(500);
    const before = fs.existsSync(pastedDirectory) ? fs.readdirSync(pastedDirectory) : [];
    const rawCopied = await copyWithOsascript(
      `set the clipboard to (read (POSIX file ${JSON.stringify(SOURCE_IMAGE)}) as «class PNGf»)`
    );
    console.log(`[smoke] osascript put the raw image on the clipboard (failed=${rawCopied.failed}) ${rawCopied.output}`);
    await pasteThroughMenu();
    console.log("[smoke] Edit -> Paste clicked with the raw image on the clipboard");
    const after = fs.existsSync(pastedDirectory) ? fs.readdirSync(pastedDirectory) : [];
    console.log(`[smoke] ${pastedDirectory}: ${before.length} file(s) before, ${after.length} after (${after.join(", ")})`);
    await wait(1500);
    console.log(`[smoke] the prompt now reads: …${registry.recentPlainOutput(terminalId, 1200).slice(-160)}`);

    // 5b. And the CLI reads that saved file too.
    registry.write(terminalId, ` ${IMAGE_QUESTION}`);
    await wait(600);
    await finishTurn(registry, terminalId, "the answer about the saved clipboard image");
    console.log(`[smoke] answer about the SAVED clipboard image: ${registry.recentPlainOutput(terminalId, 2500).slice(-500)}`);
    await capture(window, "paste-image.png");

    registry.write(terminalId, ESCAPE);
    await wait(400);
    registry.write(terminalId, "/exit\r");
    await wait(2000);
    for (const record of registry.list()) {
      registry.close(record.terminalId);
    }
    await wait(1000);
    quit();
  } catch (error) {
    console.log(`[smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "paste-failed.png");
    for (const record of registry.list()) {
      registry.close(record.terminalId);
    }
    await wait(1000);
    quit();
  }
}
