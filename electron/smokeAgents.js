// Dev-only automation (CLAUDING_SMOKE_AGENTS=1) for the Agents feature.
// Everything it touches is its own: an agent it adds to the real store and
// removes again, and a `claude` session in a scratch folder — never one of
// the user's project folders, and never this repository.
//
//   1. inspects a definition folder (CLAUDING_SMOKE_AGENT_FOLDER; by default
//      a small example definition the smoke writes into the scratch folder,
//      and a folder given by hand is only ever read) and prints which .md
//      file and which name it suggests;
//   2. adds that agent through the real store and photographs the Agents
//      tab -> agents-list.png;
//   3. opens the "+ New" sheet with the agent preselected and drops its
//      select open -> agents-new.png;
//   4. starts a session with the agent in the scratch folder, asks it who it
//      is, prints the answer, and checks the row badge, the header chip, the
//      sessionAgents link and lastWorkingDirectory -> agents-session.png;
//   5. exits the terminal and deletes the agent it added.
// Screenshots go to CLAUDING_SMOKE_FOLDER. Costs a few cents.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
// NEVER this repository: the smoke runs `claude` for real.
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const DEFINITION_FOLDER =
  process.env.CLAUDING_SMOKE_AGENT_FOLDER || path.join(SMOKE_DIRECTORY, "spec-writer");
const USES_OWN_DEFINITION_FOLDER = !process.env.CLAUDING_SMOKE_AGENT_FOLDER;
const AGENT_EMOJI = process.env.CLAUDING_SMOKE_AGENT_EMOJI || "📐";
const IDENTITY_PROMPT = "Which agent are you and where does your definition live? One line.";
const ESCAPE = "\x1b";
const DOWN_ARROW = "\x1b[B";

// The example definition the smoke inspects when no folder was given: the
// same shape a real one has — a folder whose .md file is named after it, with
// an "# Agent: …" heading and an emoji in the text. A folder given by hand
// is never written to.
function writeExampleDefinitionFolder() {
  if (!USES_OWN_DEFINITION_FOLDER || fs.existsSync(DEFINITION_FOLDER)) {
    return;
  }
  fs.mkdirSync(DEFINITION_FOLDER, { recursive: true });
  fs.writeFileSync(
    path.join(DEFINITION_FOLDER, `${path.basename(DEFINITION_FOLDER)}.md`),
    "# Agent: Spec Writer\n\n\u{1F4D0} You write short, precise feature specifications.\n"
  );
  fs.writeFileSync(
    path.join(DEFINITION_FOLDER, "notes.md"),
    "# Notes\n\nA second file, so the form's select has more than one choice.\n"
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
  console.log(`[agents-smoke] screenshot written to ${filePath}`);
}

function runInWindow(window, script) {
  return window.webContents.executeJavaScript(script);
}

function clickInWindow(window, selector) {
  return runInWindow(
    window,
    `(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (target) { target.click(); } return Boolean(target); })()`
  );
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
      console.log("[agents-smoke] answering the trust dialog with Yes");
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

export async function runAgentsSmoke({ window, registry, agents, sendCommand, quit }) {
  let addedAgentId = null;
  let openedTerminalId = null;
  try {
    fs.mkdirSync(SMOKE_WORKING_DIRECTORY, { recursive: true });
    writeExampleDefinitionFolder();
    await wait(3500);

    // 1. What the form would fill in for this folder.
    const inspection = await runInWindow(
      window,
      `window.clauding.inspectAgentFolder(${JSON.stringify(DEFINITION_FOLDER)})`
    );
    console.log(`[agents-smoke] folder: ${inspection.definitionFolder}`);
    console.log(`[agents-smoke] .md files there: ${inspection.markdownFiles.join(", ")}`);
    console.log(`[agents-smoke] suggested file: ${inspection.definitionFile}`);
    console.log(`[agents-smoke] suggested name: "${inspection.name}", suggested emoji: ${inspection.emoji}`);
    if (path.basename(inspection.definitionFile) !== `${path.basename(DEFINITION_FOLDER)}.md`) {
      throw new Error(`the suggested definition file is not ${path.basename(DEFINITION_FOLDER)}.md`);
    }
    if (!inspection.name) {
      throw new Error("no name was suggested from the definition file's heading");
    }

    // 2. The agent itself, through the real store.
    const added = agents.addAgent({
      name: inspection.name,
      emoji: AGENT_EMOJI,
      definitionFolder: inspection.definitionFolder,
      definitionFile: inspection.definitionFile
    });
    addedAgentId = added.id;
    console.log(`[agents-smoke] agent added: ${added.id} ${added.emoji} "${added.name}"`);
    await wait(1200);
    await clickInWindow(window, "[data-agents-tab]");
    await wait(1200);
    const agentRowText = await runInWindow(
      window,
      `(() => { const row = document.querySelector('[data-agent-row="${added.id}"]'); return row ? row.innerText.replace(/\\n/g, " | ") : null; })()`
    );
    console.log(`[agents-smoke] Agents tab row: ${agentRowText}`);
    await capture(window, "agents-list.png");

    // 2b. The form behind the row menu's "Edit", filled in from the store.
    await clickInWindow(window, `[data-agent-menu-button="${added.id}"]`);
    await wait(700);
    await runInWindow(
      window,
      `(() => {
        const items = Array.from(document.querySelectorAll(".popup-menu-item"));
        const item = items.find((node) => node.textContent.trim() === "Edit");
        if (!item) { return false; }
        item.click();
        return true;
      })()`
    );
    await wait(1200);
    const formState = await runInWindow(
      window,
      `(() => {
        const form = document.querySelector("[data-agent-form]");
        if (!form) { return "no form"; }
        const select = form.querySelector("[data-agent-file-select]");
        return JSON.stringify({
          name: form.querySelector("[data-agent-name-input]").value,
          emoji: form.querySelector("[data-agent-emoji-input]").value,
          file: select.value,
          fileOptions: Array.from(select.options).map((option) => option.value),
          emojiField: Boolean(form.querySelector("[data-agent-emoji-input]"))
        });
      })()`
    );
    console.log(`[agents-smoke] agent form: ${formState}`);
    await capture(window, "agents-form.png");
    await runInWindow(
      window,
      '(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()'
    );
    await wait(600);

    // 3. The "+ New" sheet with this agent preselected, its select open.
    await clickInWindow(window, `[data-agent-row="${added.id}"]`);
    await wait(1200);
    const sheetState = await runInWindow(
      window,
      `(() => {
        const select = document.querySelector("[data-new-session-agent]");
        if (!select) { return "no sheet"; }
        select.focus();
        const options = Array.from(select.options).map((option) => option.textContent);
        return JSON.stringify({ selected: select.selectedOptions[0].textContent, options });
      })()`
    );
    console.log(`[agents-smoke] "+ New" sheet agent select: ${sheetState}`);
    // A native <select> popup cannot be opened from script, so the shot
    // shows the sheet with the agent picked and the select focused.
    await capture(window, "agents-new.png");
    await runInWindow(
      window,
      '(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()'
    );
    await wait(600);

    // 4. A real session as this agent, in the scratch folder.
    const opened = registry.open({
      workingDirectory: SMOKE_WORKING_DIRECTORY,
      agentId: added.id,
      columns: 120,
      rows: 40
    });
    openedTerminalId = opened.terminalId;
    agents.rememberWorkingDirectory(added.id, opened.workingDirectory);
    sendCommand({ action: "show-terminal", terminalId: opened.terminalId });
    console.log(`[agents-smoke] terminal ${opened.terminalId} opened as the agent, name "${opened.sessionName}"`);
    await waitForPrompt(registry, opened.terminalId);
    const record = registry.get(opened.terminalId);
    console.log(`[agents-smoke] session ${record.sessionId}`);
    await sendPrompt(registry, opened.terminalId, IDENTITY_PROMPT);
    console.log(`[agents-smoke] answer: ${registry.recentPlainOutput(opened.terminalId, 2500).slice(-700)}`);

    const stored = agents.get();
    console.log(`[agents-smoke] sessionAgents link: ${stored.sessionAgents[record.sessionId]} (agent ${added.id})`);
    console.log(
      `[agents-smoke] lastWorkingDirectory: ${stored.agents.find((agent) => agent.id === added.id).lastWorkingDirectory}`
    );
    if (stored.sessionAgents[record.sessionId] !== added.id) {
      throw new Error("the session was not linked to the agent");
    }

    // Back to the session list: the badge lives on a row there, and the
    // Agents tab is still the one on screen from step 3.
    await clickInWindow(window, "[data-sessions-tab]");
    await wait(2500);
    const chips = await runInWindow(
      window,
      `(() => JSON.stringify({
        badgeOnRow: Boolean(document.querySelector('[data-session-row] [data-agent-badge="${added.id}"]')),
        chipInHeader: Boolean(document.querySelector('.transcript-header [data-agent-chip="${added.id}"]')),
        headerChipText: (document.querySelector(".transcript-header [data-agent-chip]") || { innerText: null }).innerText
      }))()`
    );
    console.log(`[agents-smoke] chips: ${chips}`);
    await capture(window, "agents-session.png");
    const parsedChips = JSON.parse(chips);
    if (!parsedChips.badgeOnRow || !parsedChips.chipInHeader) {
      throw new Error("the agent badge or the header chip is missing");
    }

    await leaveTerminal(registry, openedTerminalId);
    openedTerminalId = null;
    agents.deleteAgent(addedAgentId);
    addedAgentId = null;
    console.log("[agents-smoke] the smoke agent was removed again");
    await wait(1000);
    quit();
  } catch (error) {
    console.log(`[agents-smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "agents-failed.png");
    if (openedTerminalId) {
      registry.close(openedTerminalId);
    }
    if (addedAgentId) {
      agents.deleteAgent(addedAgentId);
    }
    await wait(1000);
    quit();
  }
}
