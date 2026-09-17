// Dev-only automation (CLAUDING_SMOKE_AGENT_START=1) for the first message a
// session started *as an agent* gets. It is the proof that clicking an agent
// in the Agents tab produces a session that says who it is instead of an
// empty prompt with a colored chip over it:
//
//   1. writes a small agent definition into the scratch folder, adds it
//      through the real store and points its last working directory at the
//      scratch folder, so the sheet opens on it;
//   2. clicks the agent's row in the Agents tab -> the "+ New" sheet with
//      the agent already picked -> "Start", which is the app's own path
//      through the renderer and the real openTerminal IPC;
//   3. waits for the CLI's prompt, photographs the header while the chip
//      still says "starting…", and waits for the app to type the first
//      message in by itself (kickoffState "sent");
//   4. waits out the answer and prints it: the definition's one rule makes
//      it begin with SCRATCH, so the printed reply says by itself whether
//      the definition really arrived;
//   5. exits the terminal and deletes the agent it added.
//
// Everything it touches is its own: the definition folder, the agent and the
// session all live in CLAUDING_SMOKE_FOLDER. Run it with its own profile
// (--user-data-dir) so the real agents.json is never written to. Costs a few
// cents, because the session is a real `claude`.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
// NEVER this repository: the smoke runs `claude` for real.
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const DEFINITION_FOLDER = path.join(SMOKE_DIRECTORY, "scratch-starter");
const AGENT_NAME = "Scratch Starter";
const AGENT_EMOJI = "🚀";
const ESCAPE = "\x1b";
const DOWN_ARROW = "\x1b[B";

// The definition the smoke starts a session as. Its one visible rule is in
// every reply, so the answer on screen proves the definition was read.
function writeDefinitionFolder() {
  fs.mkdirSync(DEFINITION_FOLDER, { recursive: true });
  fs.writeFileSync(
    path.join(DEFINITION_FOLDER, "scratch-starter.md"),
    [
      "# Agent: Scratch Starter",
      "",
      "🚀 You are a throw-away agent used to check that a new session knows who it is.",
      "",
      "## Rules",
      "",
      "- Always begin replies with the word SCRATCH.",
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
  console.log(`[agent-start-smoke] screenshot written to ${filePath}`);
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

// The trust dialog is answered as often as it is still on screen: the CLI
// draws it a moment before it listens, so a single Down+Enter can land in
// nothing at all and the terminal then waits for ever.
async function waitForPrompt(registry, terminalId) {
  let lastTrustAnswerAt = 0;
  await waitUntil(() => {
    const record = registry.get(terminalId);
    if (!record) {
      throw new Error("the terminal exited before the prompt appeared");
    }
    const onScreen = registry.recentPlainOutput(terminalId, 2000);
    if (onScreen.includes("trust this folder") && Date.now() - lastTrustAnswerAt > 8000) {
      lastTrustAnswerAt = Date.now();
      console.log("[agent-start-smoke] answering the trust dialog with Yes");
      registry.write(terminalId, DOWN_ARROW);
      setTimeout(() => registry.write(terminalId, "\r"), 500);
    }
    return Boolean(record.sessionId) && record.registryStatus === "idle";
  }, 120000, "the Claude Code prompt");
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

// A folder Claude has never been started in greets the first session with
// the trust dialog, and answering it is somebody typing — which is exactly
// what cancels a kickoff (looksTypedByHand in lib/terminalKickoff.js). So a
// throw-away terminal takes the dialog first and is closed again; the
// session under test then comes up at a clean prompt with nobody having
// touched the keyboard.
async function acceptTrustInAThrowawayTerminal(registry, sendCommand) {
  const warmUp = registry.open({ workingDirectory: SMOKE_WORKING_DIRECTORY, columns: 100, rows: 30 });
  sendCommand({ action: "show-terminal", terminalId: warmUp.terminalId });
  console.log(`[agent-start-smoke] warm-up terminal ${warmUp.terminalId} takes the trust dialog`);
  try {
    await waitForPrompt(registry, warmUp.terminalId);
  } catch (error) {
    console.log(`[agent-start-smoke] warm-up output: ${registry.recentPlainOutput(warmUp.terminalId, 1500)}`);
    throw error;
  }
  await leaveTerminal(registry, warmUp.terminalId);
  await wait(1500);
}

export async function runAgentStartSmoke({ window, registry, agents, sendCommand, quit }) {
  let addedAgentId = null;
  let terminalId = null;
  try {
    fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
    writeDefinitionFolder();
    await wait(3500);

    const added = agents.addAgent({
      name: AGENT_NAME,
      emoji: AGENT_EMOJI,
      definitionFolder: DEFINITION_FOLDER,
      definitionFile: path.join(DEFINITION_FOLDER, "scratch-starter.md")
    });
    addedAgentId = added.id;
    // So the sheet opens on the scratch folder and never on a real project.
    agents.rememberWorkingDirectory(added.id, SMOKE_WORKING_DIRECTORY);
    console.log(`[agent-start-smoke] agent added: ${added.emoji} "${added.name}" (${added.id})`);
    await wait(1500);
    await acceptTrustInAThrowawayTerminal(registry, sendCommand);

    // 1. The Agents tab, the agent's row, and the sheet it opens.
    await clickInWindow(window, "[data-agents-tab]");
    await wait(1200);
    if (!(await clickInWindow(window, `[data-agent-row="${added.id}"]`))) {
      throw new Error("the agent's row is not in the Agents tab");
    }
    await wait(1200);
    const sheetState = await runInWindow(
      window,
      `(() => {
        const select = document.querySelector("[data-new-session-agent]");
        if (!select) { return "no sheet"; }
        const folder = document.querySelector(".sheet-folder.is-selected");
        return JSON.stringify({
          agent: select.selectedOptions[0].textContent,
          folder: folder ? folder.innerText.trim() : null
        });
      })()`
    );
    console.log(`[agent-start-smoke] "+ New" sheet: ${sheetState}`);
    if (sheetState === "no sheet") {
      throw new Error("clicking the agent's row did not open the \"+ New\" sheet");
    }

    // 2. Start: the renderer's own path through the real openTerminal IPC.
    const terminalsBefore = new Set(registry.list().map((record) => record.terminalId));
    if (!(await clickInWindow(window, "[data-new-confirm]"))) {
      throw new Error("the sheet has no Start button");
    }
    let started = null;
    await waitUntil(async () => {
      started = registry.list().find((record) => !terminalsBefore.has(record.terminalId) && !record.exited) || null;
      return Boolean(started);
    }, 30000, "the new terminal");
    terminalId = started.terminalId;
    sendCommand({ action: "show-terminal", terminalId });
    console.log(
      `[agent-start-smoke] terminal ${terminalId} started as agent ${started.agentId}, ` +
        `name "${started.sessionName}", kickoffState ${started.kickoffState}`
    );
    if (started.agentId !== added.id) {
      throw new Error("the new terminal does not carry the agent");
    }
    if (started.kickoffState !== "waiting") {
      throw new Error("a session started as an agent should be waiting to be given its first message");
    }

    // 3. The chip says "starting…" for as long as the message has not gone.
    const startingNote = await runInWindow(
      window,
      '(() => { const note = document.querySelector("[data-agent-chip-starting]"); return note ? note.innerText : null; })()'
    );
    console.log(`[agent-start-smoke] header chip note while the message is waiting: ${JSON.stringify(startingNote)}`);
    if (!startingNote) {
      throw new Error("the header chip does not say the session is starting");
    }
    await capture(window, "agent-start-waiting.png");

    // 4. The app types the message in by itself — nobody touches the keyboard.
    await waitForPrompt(registry, terminalId);
    await waitUntil(() => {
      const record = registry.get(terminalId);
      return Boolean(record) && record.kickoffState === "sent";
    }, 90000, "the first message to be typed in");
    console.log("[agent-start-smoke] the app typed the first message in by itself");
    await waitForTurn(registry, terminalId, "the answer to the first message");
    const answer = registry.recentPlainOutput(terminalId, 4000).slice(-1200);
    console.log(`[agent-start-smoke] answer: ${answer}`);
    if (!answer.includes("SCRATCH")) {
      throw new Error("the answer does not follow the definition (no SCRATCH in it)");
    }
    const afterAnswer = await runInWindow(
      window,
      `JSON.stringify({
        chip: (document.querySelector('.transcript-header [data-agent-chip="${added.id}"]') || { innerText: null }).innerText,
        startingNote: Boolean(document.querySelector("[data-agent-chip-starting]"))
      })`
    );
    console.log(`[agent-start-smoke] after the answer: ${afterAnswer}`);
    if (JSON.parse(afterAnswer).startingNote) {
      throw new Error("the chip still says the session is starting after the message went");
    }
    await capture(window, "agent-start.png");

    await leaveTerminal(registry, terminalId);
    terminalId = null;
    agents.deleteAgent(addedAgentId);
    addedAgentId = null;
    console.log("[agent-start-smoke] the smoke agent was removed again");
    await wait(1000);
    quit();
  } catch (error) {
    console.log(`[agent-start-smoke] failed: ${error && error.message ? error.message : error}`);
    if (terminalId && registry.get(terminalId)) {
      const record = registry.get(terminalId);
      console.log(
        `[agent-start-smoke] terminal state: session ${record.sessionId}, status ${record.registryStatus}, ` +
          `kickoffState ${record.kickoffState}`
      );
      console.log(`[agent-start-smoke] last output: ${registry.recentPlainOutput(terminalId, 2000)}`);
    }
    await capture(window, "agent-start-failed.png");
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
