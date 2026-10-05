// Dev-only automation (CLAUDING_SMOKE_MOD=1) for the Clauding mod
// (builtin/mod/clauding-mod/), against a real `claude`, in a scratch git
// repository only (CLAUDING_SMOKE_MOD_REPO, default
// <system temporary folder>/clauding-smoke/mod-scratch, created afresh):
//
//   1. a terminal in the scratch repository, "Reply with exactly: ok" — the
//      mod's states must go working → done; "Ask me one question and wait."
//      — needs-answer, and how long after the turn's last message the app
//      had it is printed (the state log);
//   2. a second terminal on screen, then the first one finishes a turn off
//      screen — the toast (and the macOS notification) -> mod-toast.png;
//   3. the status line and the context bar in the terminal -> mod-statusline.png;
//   4. "run git reset --hard" — the guard's question appears
//      -> mod-guard.png, Cancel is chosen and Claude must say it was
//      declined; asked again, Run is chosen, the permission prompt is
//      answered and the reset happens -> mod-guard-run.png.
// Screenshots go to CLAUDING_SMOKE_FOLDER. Run it with its own profile
// (`--user-data-dir`). Costs a few cents.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { smokeFolderPath } from "./smokeFolder.js";
import { currentClaudeHome } from "./claudeHome.js";

const SMOKE_DIRECTORY = smokeFolderPath();
const REPOSITORY = process.env.CLAUDING_SMOKE_MOD_REPO || path.join(os.tmpdir(), "clauding-smoke", "mod-scratch");
const BRANCH = "CU-86modtest1";
const DOWN_ARROW = "\x1b[B";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stamp(time = Date.now()) {
  return new Date(time).toISOString().slice(11, 23);
}

async function capture(window, fileName) {
  if (!window || window.isDestroyed()) {
    return;
  }
  fs.mkdirSync(SMOKE_DIRECTORY, { recursive: true });
  const image = await window.webContents.capturePage();
  const filePath = path.join(SMOKE_DIRECTORY, fileName);
  fs.writeFileSync(filePath, image.toPNG());
  console.log(`[mod-smoke] screenshot written to ${filePath}`);
}

async function waitUntil(condition, timeoutMilliseconds, description) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await wait(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function git(argumentsList) {
  return execFileSync("git", ["-c", "user.name=Clauding smoke", "-c", "user.email=smoke@example.invalid", ...argumentsList], {
    cwd: REPOSITORY,
    encoding: "utf8"
  });
}

// A fresh repository on a CU- branch, with one uncommitted change for the
// reset to throw away.
function prepareRepository() {
  fs.rmSync(REPOSITORY, { recursive: true, force: true });
  fs.mkdirSync(REPOSITORY, { recursive: true });
  git(["init", "-q"]);
  git(["checkout", "-q", "-b", BRANCH]);
  fs.writeFileSync(path.join(REPOSITORY, "notes.txt"), "first line\n");
  git(["add", "notes.txt"]);
  git(["commit", "-q", "-m", "Scratch commit"]);
  fs.writeFileSync(path.join(REPOSITORY, "notes.txt"), "first line\nan uncommitted second line\n");
}

// Every change of a terminal's mod state, with the time the app had it.
function startStateLog(registry, terminalId, label) {
  const entries = [];
  let last = null;
  const timer = setInterval(() => {
    const record = registry.get(terminalId);
    const modState = record ? record.modState : null;
    const key = modState ? `${modState.state}|${modState.detail}|${modState.changedAt}` : "none";
    if (key !== last) {
      last = key;
      if (modState) {
        entries.push(modState);
        console.log(`[mod-smoke] ${label} state ${stamp(modState.changedAt)} ${modState.state}${modState.detail ? ` (${modState.detail})` : ""}`);
      }
    }
  }, 50);
  return {
    entries,
    stop() {
      clearInterval(timer);
    }
  };
}

function currentState(registry, terminalId) {
  const record = registry.get(terminalId);
  return record && record.modState ? record.modState : null;
}

// The trust dialog of a new folder is answered with Yes: the arrow and the
// Enter go in separately, after the dialog has had time to take keys, and
// again if it is still there a few seconds later.
async function waitForPrompt(registry, terminalId) {
  let answeredAt = 0;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const record = registry.get(terminalId);
    if (!record) {
      throw new Error("the terminal exited before the prompt appeared");
    }
    if (record.sessionId && record.registryStatus === "idle") {
      await wait(1500);
      return;
    }
    const tail = registry.recentPlainOutput(terminalId, 1500);
    if (tail.includes("trust this folder") && Date.now() - answeredAt > 6000) {
      answeredAt = Date.now();
      console.log("[mod-smoke] answering the trust dialog with Yes");
      await wait(1500);
      registry.write(terminalId, DOWN_ARROW);
      await wait(500);
      registry.write(terminalId, "\r");
    }
    await wait(200);
  }
  throw new Error("timed out waiting for the Claude Code prompt");
}

async function typePrompt(registry, terminalId, prompt) {
  registry.write(terminalId, prompt);
  await wait(600);
  registry.write(terminalId, "\r");
}

// The time of the last assistant message in the session's transcript.
function lastAssistantTime(sessionId) {
  const projectsFolder = path.join(currentClaudeHome(), "projects");
  for (const folder of fs.readdirSync(projectsFolder)) {
    const filePath = path.join(projectsFolder, folder, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    for (let position = lines.length - 1; position >= 0; position -= 1) {
      try {
        const entry = JSON.parse(lines[position]);
        if (entry.type === "assistant" && entry.timestamp) {
          return Date.parse(entry.timestamp);
        }
      } catch (error) {
        // A half-written line.
      }
    }
  }
  return null;
}

async function runTurn(registry, terminalId, prompt, wantedState, label) {
  const sentAt = Date.now();
  await typePrompt(registry, terminalId, prompt);
  await waitUntil(() => {
    const now = currentState(registry, terminalId);
    return now && now.state === wantedState && now.changedAt > sentAt;
  }, 180000, `${label}: ${wantedState}`);
  const reached = currentState(registry, terminalId);
  const record = registry.get(terminalId);
  // The transcript line is written a moment after the turn ends: read it
  // once it is there, and compare its time with when the app had the state.
  await wait(2500);
  const messageTime = lastAssistantTime(record.sessionId);
  if (messageTime) {
    console.log(
      `[mod-smoke] ${label}: last assistant message ${stamp(messageTime)}, app had "${reached.state}" at ${stamp(reached.changedAt)} ` +
        `(${reached.changedAt - messageTime} ms later)`
    );
  }
  return reached;
}

// The guard's question is open when the mod reports needs-answer with the
// guard's own words in it.
async function answerGuard(registry, terminalId, optionNumber, label) {
  await waitUntil(() => {
    const now = currentState(registry, terminalId);
    return now && now.detail.startsWith("Clauding guard");
  }, 180000, `${label}: the guard's question`);
  await wait(1200);
  return async () => {
    registry.write(terminalId, String(optionNumber));
    await wait(500);
    registry.write(terminalId, "\r");
  };
}

async function leaveTerminal(registry, terminalId) {
  if (!registry.get(terminalId)) {
    return;
  }
  registry.write(terminalId, "\x1b");
  await wait(500);
  registry.write(terminalId, "/exit\r");
  try {
    await waitUntil(() => registry.get(terminalId) === null || registry.get(terminalId).exited, 20000, "claude to exit");
  } catch (error) {
    registry.close(terminalId);
  }
}

export async function runModSmoke({ window, registry, sendCommand, quit }) {
  const opened = [];
  const logs = [];
  try {
    prepareRepository();
    console.log(`[mod-smoke] scratch repository ${REPOSITORY} on ${BRANCH}`);
    await wait(2500);

    // 1. working → done, then needs-answer.
    const first = registry.open({ workingDirectory: REPOSITORY, columns: 150, rows: 44 });
    opened.push(first.terminalId);
    console.log(`[mod-smoke] terminal A ${first.terminalId}: claude ${first.commandArguments.join(" ")}`);
    sendCommand({ action: "show-terminal", terminalId: first.terminalId });
    const logA = startStateLog(registry, first.terminalId, "A");
    logs.push(logA);
    await waitForPrompt(registry, first.terminalId);
    console.log(`[mod-smoke] A session ${registry.get(first.terminalId).sessionId}`);
    await runTurn(registry, first.terminalId, "Reply with exactly: ok", "done", "turn 1");
    await wait(1500);
    await runTurn(registry, first.terminalId, "Ask me one question and wait.", "needs-answer", "turn 2");
    await wait(3000);
    // Claude may ask in its question dialog: answer it, then have it ask in
    // plain text, where the turn's end is what the mod reads.
    if (registry.recentPlainOutput(first.terminalId, 2500).includes("Enter to select")) {
      console.log("[mod-smoke] the question came as a dialog; choosing its first option");
      const pressedAt = Date.now();
      registry.write(first.terminalId, "1");
      await wait(500);
      registry.write(first.terminalId, "\r");
      await waitUntil(() => {
        const now = currentState(registry, first.terminalId);
        return Boolean(now) && (now.state === "done" || now.state === "needs-answer") && now.changedAt > pressedAt + 600;
      }, 120000, "the turn after the dialog");
      await wait(1500);
    }
    await runTurn(
      registry,
      first.terminalId,
      "Ask me one short question in plain text, without any tool or dialog, and wait for my answer.",
      "needs-answer",
      "turn 2b (plain text)"
    );
    await wait(3000);
    await capture(window, "mod-statusline.png");

    // 2. another terminal on screen; A finishes off screen.
    const second = registry.open({ workingDirectory: REPOSITORY, columns: 150, rows: 44 });
    opened.push(second.terminalId);
    sendCommand({ action: "show-terminal", terminalId: second.terminalId });
    const logB = startStateLog(registry, second.terminalId, "B");
    logs.push(logB);
    await waitForPrompt(registry, second.terminalId);
    console.log("[mod-smoke] B is on screen; A answers its question off screen");
    await runTurn(registry, first.terminalId, "Blue. Now reply with exactly: thanks", "done", "turn 3 (off screen)");
    await wait(1200);
    await capture(window, "mod-toast.png");

    // 4. the guard: Cancel, then Run.
    sendCommand({ action: "show-terminal", terminalId: first.terminalId });
    await wait(2000);
    await typePrompt(
      registry,
      first.terminalId,
      "Use the Bash tool to run exactly this command and nothing else: git reset --hard"
    );
    const pressCancel = await answerGuard(registry, first.terminalId, 1, "guard 1");
    await capture(window, "mod-guard.png");
    await pressCancel();
    console.log("[mod-smoke] Cancel chosen");
    await waitUntil(() => {
      const now = currentState(registry, first.terminalId);
      return now && (now.state === "done" || now.state === "needs-answer") && !now.detail.startsWith("Clauding guard");
    }, 180000, "the turn after Cancel");
    await wait(1500);
    console.log(`[mod-smoke] after Cancel, Claude said: ${registry.recentPlainOutput(first.terminalId, 3000).slice(-700)}`);
    console.log(`[mod-smoke] git status after Cancel: ${git(["status", "--porcelain"]).trim() || "(clean)"}`);

    await typePrompt(registry, first.terminalId, "I changed my mind: run git reset --hard with the Bash tool now.");
    const pressRun = await answerGuard(registry, first.terminalId, 2, "guard 2");
    await pressRun();
    console.log("[mod-smoke] Run chosen");
    // The usual permission prompt may follow the guard: answer Yes.
    const deadline = Date.now() + 180000;
    let permissionAnswered = false;
    while (Date.now() < deadline) {
      const now = currentState(registry, first.terminalId);
      if (now && now.state === "needs-permission" && !permissionAnswered) {
        permissionAnswered = true;
        await wait(1000);
        console.log("[mod-smoke] permission prompt: answering Yes");
        registry.write(first.terminalId, "1");
        await wait(400);
        registry.write(first.terminalId, "\r");
      }
      if (now && (now.state === "done" || (now.state === "needs-answer" && !now.detail.startsWith("Clauding guard")))) {
        break;
      }
      await wait(150);
    }
    await wait(2000);
    console.log(`[mod-smoke] after Run, Claude said: ${registry.recentPlainOutput(first.terminalId, 3000).slice(-700)}`);
    console.log(`[mod-smoke] git status after Run: ${git(["status", "--porcelain"]).trim() || "(clean)"}`);
    await capture(window, "mod-guard-run.png");

    for (const log of logs) {
      log.stop();
    }
    console.log(
      `[mod-smoke] state log A: ${logA.entries.map((entry) => `${stamp(entry.changedAt)} ${entry.state}`).join(" → ")}`
    );
    for (const terminalId of opened) {
      await leaveTerminal(registry, terminalId);
    }
    await wait(1000);
    console.log("[mod-smoke] done");
    quit();
  } catch (error) {
    console.log(`[mod-smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "mod-failed.png");
    for (const terminalId of opened) {
      console.log(`[mod-smoke] ${terminalId} output tail: ${registry.recentPlainOutput(terminalId, 3000).slice(-1200)}`);
    }
    for (const log of logs) {
      log.stop();
    }
    for (const record of registry.list()) {
      registry.close(record.terminalId);
    }
    await wait(1000);
    quit();
  }
}
