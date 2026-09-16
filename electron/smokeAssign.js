// Dev-only automation (CLAUDING_SMOKE_ASSIGN=1) for "Assign to agent".
// It is the one hook that proves the whole path end to end, with a real
// `claude` session in the scratch folder (a few cents):
//
//   1. writes a small agent definition into the scratch folder and adds it
//      through the real store;
//   2. opens a real session there, says hello and waits for the answer;
//   3. opens the header's "…" menu and picks that agent -> the dialog,
//      photographed as assign-dialog.png, with nothing written yet;
//   4. presses Cancel and checks that agents.json is still empty and that
//      neither the row badge nor the header chip has appeared;
//   5. opens the dialog again and presses "Assign and restart terminal
//      now": the old pty is hung up, a new `claude --resume` takes the same
//      session over with the definition in its prompt file, the app types
//      the assignment message in by itself, and the answer that comes back
//      is printed -> assign-restarted.png;
//   6. exits the terminal and deletes the agent it added.
//
// Everything it touches is its own: the definition folder, the agent and
// the session all live in CLAUDING_SMOKE_FOLDER. Run it with its own
// profile (--user-data-dir) so the real agents.json is never written to.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
// NEVER this repository: the smoke runs `claude` for real.
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const DEFINITION_FOLDER = path.join(SMOKE_DIRECTORY, "scratch-reviewer");
const AGENT_EMOJI = "🧪";
const AGENT_COLOR = "--project-color-3";
const HELLO_PROMPT = "Say hello in one short line.";
const ESCAPE = "\x1b";
const DOWN_ARROW = "\x1b[B";

// The definition the smoke assigns. Its one rule is visible in the answer,
// so the printed reply says by itself whether the definition really was
// loaded into the restarted terminal.
function writeDefinitionFolder() {
  fs.mkdirSync(DEFINITION_FOLDER, { recursive: true });
  fs.writeFileSync(
    path.join(DEFINITION_FOLDER, "scratch-reviewer.md"),
    [
      "# Agent: Scratch Reviewer",
      "",
      "🧪 You review scratch work.",
      "",
      "## Rules",
      "",
      "- Begin every single reply with the word SCRATCH.",
      "- Never write more than two sentences."
    ].join("\n")
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  console.log(`[assign-smoke] screenshot written to ${filePath}`);
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
      console.log("[assign-smoke] answering the trust dialog with Yes");
      registry.write(terminalId, `${DOWN_ARROW}\r`);
    }
    return Boolean(record.sessionId) && record.registryStatus === "idle";
  }, 90000, "the Claude Code prompt");
  await wait(1500);
}

async function waitForTurn(registry, terminalId, description) {
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
  }, 180000, description);
  await wait(3000);
}

async function sendPrompt(registry, terminalId, prompt) {
  registry.write(terminalId, prompt);
  await wait(600);
  registry.write(terminalId, "\r");
  await waitForTurn(registry, terminalId, `the turn "${prompt.slice(0, 30)}…"`);
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

// The header's "…" menu, its "Assign agent ▸" submenu, then this agent's
// item in that submenu.
async function openAssignDialog(window, agentId, item = null) {
  await clickInWindow(window, "[data-header-menu-button]");
  await wait(800);
  await clickInWindow(window, '[data-menu-item="assign-agent"]');
  await wait(500);
  const picked = await clickInWindow(window, `[data-menu-item="${item || `assign-${agentId}`}"]`);
  if (!picked) {
    throw new Error("the agent is not in the header menu");
  }
  await wait(900);
  if (!(await isOnScreen(window, "[data-assign-dialog]"))) {
    throw new Error("the assign dialog did not open");
  }
}

export async function runAssignSmoke({ window, registry, agents, sendCommand, quit }) {
  let addedAgentId = null;
  let terminalId = null;
  try {
    fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
    writeDefinitionFolder();
    await wait(3500);

    const added = agents.addAgent({
      name: "Scratch Reviewer",
      emoji: AGENT_EMOJI,
      color: AGENT_COLOR,
      definitionFolder: DEFINITION_FOLDER,
      definitionFile: path.join(DEFINITION_FOLDER, "scratch-reviewer.md")
    });
    addedAgentId = added.id;
    console.log(`[assign-smoke] agent added: ${added.emoji} "${added.name}" (${added.id})`);

    // A real session with no agent at all: the one "Assign to agent" is for.
    const opened = registry.open({ workingDirectory: SMOKE_WORKING_DIRECTORY, columns: 120, rows: 40 });
    terminalId = opened.terminalId;
    sendCommand({ action: "show-terminal", terminalId });
    await waitForPrompt(registry, terminalId);
    const sessionId = registry.get(terminalId).sessionId;
    console.log(`[assign-smoke] session ${sessionId} in ${SMOKE_WORKING_DIRECTORY}`);
    await sendPrompt(registry, terminalId, HELLO_PROMPT);

    // 1. The dialog itself: open, and nothing written by opening it.
    await openAssignDialog(window, added.id);
    await capture(window, "assign-dialog.png");
    const buttons = await runInWindow(
      window,
      `JSON.stringify({
        title: document.querySelector("[data-assign-dialog] .assign-dialog-title").innerText,
        cancel: Boolean(document.querySelector("[data-assign-cancel]")),
        assignOnly: Boolean(document.querySelector("[data-assign-only]")),
        assignAndRestart: Boolean(document.querySelector("[data-assign-restart]"))
      })`
    );
    console.log(`[assign-smoke] dialog: ${buttons}`);
    const parsedButtons = JSON.parse(buttons);
    if (!parsedButtons.cancel || !parsedButtons.assignOnly || !parsedButtons.assignAndRestart) {
      throw new Error("the open terminal's dialog should offer all three choices");
    }
    if (Object.keys(agents.get().sessionAgents).length > 0) {
      throw new Error("opening the dialog already wrote a link");
    }

    // 2. Cancel: nothing written, nothing on screen.
    await clickInWindow(window, "[data-assign-cancel]");
    await wait(1500);
    const afterCancel = await runInWindow(
      window,
      `JSON.stringify({
        dialog: Boolean(document.querySelector("[data-assign-dialog]")),
        chip: Boolean(document.querySelector(".transcript-header [data-agent-chip]")),
        badge: Boolean(document.querySelector('[data-session-row] [data-agent-badge="${added.id}"]'))
      })`
    );
    console.log(`[assign-smoke] after Cancel: ${afterCancel} agents.json sessionAgents: ${JSON.stringify(agents.get().sessionAgents)}`);
    const parsedCancel = JSON.parse(afterCancel);
    if (parsedCancel.dialog || parsedCancel.chip || parsedCancel.badge) {
      throw new Error("Cancel left something on screen");
    }
    if (Object.keys(agents.get().sessionAgents).length > 0) {
      throw new Error("Cancel wrote the link anyway — the bug is back");
    }
    if (!registry.get(terminalId)) {
      throw new Error("Cancel closed the terminal");
    }
    await capture(window, "assign-cancelled.png");

    // 3. Assign and restart: the same session comes back in a new pty, with
    //    the definition in its prompt file and the first message typed in.
    await openAssignDialog(window, added.id);
    await clickInWindow(window, "[data-assign-restart]");
    console.log("[assign-smoke] pressed \"Assign and restart terminal now\"");
    if (agents.get().sessionAgents[sessionId] !== added.id) {
      await wait(1500);
    }
    if (agents.get().sessionAgents[sessionId] !== added.id) {
      throw new Error("the link was not written");
    }
    const oldTerminalId = terminalId;
    let restarted = null;
    await waitUntil(async () => {
      restarted =
        registry.list().find((record) => record.terminalId !== oldTerminalId && record.sessionId === sessionId && !record.exited) ||
        null;
      return Boolean(restarted);
    }, 60000, "the restarted terminal");
    terminalId = restarted.terminalId;
    console.log(`[assign-smoke] restarted as terminal ${terminalId}, session ${restarted.sessionId}, agent ${restarted.agentId}`);
    if (restarted.sessionId !== sessionId) {
      throw new Error("the restart did not keep the session");
    }
    if (restarted.agentId !== added.id) {
      throw new Error("the restarted terminal does not carry the agent");
    }
    if (registry.get(oldTerminalId)) {
      throw new Error("the old terminal is still running");
    }
    await waitForPrompt(registry, terminalId);
    // The app types the assignment message in by itself — nobody touches
    // the keyboard here.
    await waitUntil(() => {
      const record = registry.get(terminalId);
      return Boolean(record) && record.kickoffState === "sent";
    }, 90000, "the assignment message to be typed in");
    console.log("[assign-smoke] the app typed the assignment message in by itself");
    await waitForTurn(registry, terminalId, "the answer to the assignment message");
    console.log(`[assign-smoke] answer: ${registry.recentPlainOutput(terminalId, 4000).slice(-900)}`);
    const afterRestart = await runInWindow(
      window,
      `JSON.stringify({
        chip: (document.querySelector('.transcript-header [data-agent-chip="${added.id}"]') || { innerText: null }).innerText,
        pendingHint: Boolean(document.querySelector("[data-agent-chip-pending]")),
        badge: Boolean(document.querySelector('[data-session-row] [data-agent-badge="${added.id}"]'))
      })`
    );
    console.log(`[assign-smoke] after the restart: ${afterRestart}`);
    await capture(window, "assign-restarted.png");
    const parsedRestart = JSON.parse(afterRestart);
    if (!parsedRestart.chip || !parsedRestart.badge) {
      throw new Error("the agent chip or the row badge is missing after the restart");
    }
    if (parsedRestart.pendingHint) {
      throw new Error("a restarted terminal must not say the definition is still waiting");
    }

    // 4. The other half of the promise: "Assign only" leaves the terminal
    //    alone, says so on the chip, and the *next* resume the app starts
    //    for that session is where the definition (and the same message)
    //    finally arrive.
    await openAssignDialog(window, added.id, "assign-none");
    await clickInWindow(window, "[data-assign-remove]");
    await wait(1500);
    if (agents.get().sessionAgents[sessionId]) {
      throw new Error("Remove did not take the assignment off");
    }
    await openAssignDialog(window, added.id);
    await clickInWindow(window, "[data-assign-only]");
    await wait(1500);
    if (agents.get().sessionAgents[sessionId] !== added.id) {
      throw new Error("\"Assign only\" did not write the link");
    }
    const afterAssignOnly = await runInWindow(
      window,
      `JSON.stringify({
        chip: Boolean(document.querySelector('.transcript-header [data-agent-chip="${added.id}"]')),
        pendingHint: (document.querySelector("[data-agent-chip-pending]") || { innerText: null }).innerText
      })`
    );
    console.log(`[assign-smoke] after "Assign only": ${afterAssignOnly}`);
    if (!JSON.parse(afterAssignOnly).pendingHint) {
      throw new Error("the chip does not say the definition is waiting for the next resume");
    }
    await capture(window, "assign-only.png");
    const restartedTerminalId = terminalId;
    if (registry.get(restartedTerminalId).terminalId !== terminalId) {
      throw new Error("\"Assign only\" restarted the terminal after all");
    }

    // Close the pane and click the row: that is a resume from the app.
    await leaveTerminal(registry, terminalId);
    terminalId = null;
    await wait(2500);
    const clickedRow = await clickInWindow(window, `[data-session-row="${sessionId}"]`);
    console.log(`[assign-smoke] clicked the row to resume the session: ${clickedRow}`);
    if (!clickedRow) {
      // A session in the scratch folder is deliberately kept out of the
      // list (see "Scratch sessions are never listed"), so there is no row
      // to click here and the resume half cannot be driven from the UI.
      // Everything up to it has been checked; say so rather than fail.
      console.log("[assign-smoke] no row for a scratch session: the resume half has to be tried by hand");
      agents.deleteAgent(addedAgentId);
      addedAgentId = null;
      await wait(1000);
      quit();
      return;
    }
    let resumed = null;
    await waitUntil(async () => {
      resumed = registry.list().find((record) => record.sessionId === sessionId && !record.exited) || null;
      return Boolean(resumed);
    }, 60000, "the resumed terminal");
    terminalId = resumed.terminalId;
    console.log(`[assign-smoke] resumed as terminal ${terminalId}, agent ${resumed.agentId}`);
    await waitForPrompt(registry, terminalId);
    await waitUntil(() => {
      const record = registry.get(terminalId);
      return Boolean(record) && record.kickoffState === "sent";
    }, 90000, "the assignment message on the resume");
    await waitForTurn(registry, terminalId, "the answer after the resume");
    console.log(`[assign-smoke] answer after the resume: ${registry.recentPlainOutput(terminalId, 4000).slice(-700)}`);
    const afterResume = await runInWindow(
      window,
      '(() => JSON.stringify({ pendingHint: Boolean(document.querySelector("[data-agent-chip-pending]")) }))()'
    );
    console.log(`[assign-smoke] after the resume: ${afterResume}`);
    await capture(window, "assign-resumed.png");

    await leaveTerminal(registry, terminalId);
    terminalId = null;
    agents.deleteAgent(addedAgentId);
    addedAgentId = null;
    console.log("[assign-smoke] the smoke agent was removed again");
    await wait(1000);
    quit();
  } catch (error) {
    console.log(`[assign-smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "assign-failed.png");
    if (terminalId) {
      registry.close(terminalId);
    }
    if (addedAgentId) {
      agents.deleteAgent(addedAgentId);
    }
    await wait(1000);
    quit();
  }
}
