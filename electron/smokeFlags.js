// Dev-only automation (CLAUDING_SMOKE_FLAGS=1, together with
// CLAUDING_DRY_SPAWN=1) for the extra `claude` flags. Nothing is started:
// the dry run composes every command line exactly as it would and then does
// not spawn it, so this hook can read the command line of a new session, of
// a resume and of a fork and say whether the three levels arrived in it.
//
//   1. puts a global flag in settings.json (this profile's own),
//      adds an agent with a flag of its own, and opens a new session with a
//      third flag typed in the "+ New" sheet -> all three, in that order;
//   2. remembers a session's flags the way a linked terminal does, then
//      resumes that session -> the flags come back without anyone retyping
//      them, which is what keeps a --channels conversation on its channel;
//   3. forks the same session -> the copy carries them too.
//
// Run it with its own profile (--user-data-dir): it writes settings.json,
// agents.json and session-flags.json.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath, smokeWorkingDirectory } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
const SMOKE_WORKING_DIRECTORY = smokeWorkingDirectory();
const GLOBAL_FLAGS = "--model sonnet";
const AGENT_FLAGS = "--dangerously-skip-permissions";
const SESSION_FLAGS = "--channels plugin:telegram";
const RESUMED_SESSION_ID = "dry-session-for-flags";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function commandLineOf(record) {
  return record.commandArguments.join(" ");
}

function mustContain(record, wanted, description) {
  const line = commandLineOf(record);
  if (!line.includes(wanted)) {
    throw new Error(`${description}: "${wanted}" is not in ${line}`);
  }
}

function runInWindow(window, script) {
  return window.webContents.executeJavaScript(script);
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
  console.log(`[flags-smoke] screenshot written to ${filePath}`);
}

// The three fields really are on screen: the "+ New" sheet's, and the one in
// the settings popover the gear (and Clauding → Settings…) opens.
async function checkTheFields(window) {
  if (!window) {
    return;
  }
  await runInWindow(window, '(() => { const target = document.querySelector("[data-new-button]"); if (target) { target.click(); } return true; })()');
  await wait(900);
  const sheetField = await runInWindow(
    window,
    '(() => { const field = document.querySelector("[data-new-session-flags]"); return field ? field.placeholder : null; })()'
  );
  console.log(`[flags-smoke] "+ New" sheet field placeholder: ${JSON.stringify(sheetField)}`);
  await capture(window, "flags-new-session.png");
  await runInWindow(window, '(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()');
  await wait(600);
  await runInWindow(window, '(() => { const target = document.querySelector("[data-settings-button]"); if (target) { target.click(); } return true; })()');
  await wait(900);
  const settingsField = await runInWindow(
    window,
    '(() => { const field = document.querySelector("[data-settings-extra-flags]"); return field ? field.value : null; })()'
  );
  console.log(`[flags-smoke] settings field value: ${JSON.stringify(settingsField)}`);
  await capture(window, "flags-settings.png");
  if (sheetField === null || settingsField === null) {
    throw new Error("one of the flag fields is not on screen");
  }
}

export async function runFlagsSmoke({ window, registry, settings, agents, sessionFlags, quit }) {
  let addedAgentId = null;
  try {
    settings.update({ extraClaudeArguments: GLOBAL_FLAGS });
    console.log(`[flags-smoke] settings.json extraClaudeArguments: ${settings.get().extraClaudeArguments}`);

    const added = agents.addAgent({
      name: "Flagged",
      emoji: "🚩",
      color: "--project-color-5",
      definitionFolder: SMOKE_WORKING_DIRECTORY,
      definitionFile: `${SMOKE_WORKING_DIRECTORY}/flagged.md`,
      extraClaudeArguments: AGENT_FLAGS
    });
    addedAgentId = added.id;
    console.log(`[flags-smoke] agent flags: ${added.extraClaudeArguments}`);

    // 1. A new session: global, then the agent's, then the session's own.
    const started = registry.open({
      workingDirectory: SMOKE_WORKING_DIRECTORY,
      agentId: added.id,
      extraArguments: SESSION_FLAGS
    });
    console.log(`[flags-smoke] new session: claude ${commandLineOf(started)}`);
    mustContain(started, GLOBAL_FLAGS, "a new session misses the global flags");
    mustContain(started, AGENT_FLAGS, "a new session misses the agent's flags");
    mustContain(started, SESSION_FLAGS, "a new session misses the flags typed in the sheet");
    const order = started.extraArguments.join(" ");
    if (order !== `${GLOBAL_FLAGS} ${AGENT_FLAGS} ${SESSION_FLAGS}`) {
      throw new Error(`the three levels are not in order: ${order}`);
    }
    registry.close(started.terminalId);

    // 2. A resume. A dry run never links a session id, so the store is
    //    written here the way refreshLinks writes it for a real terminal.
    sessionFlags.remember(RESUMED_SESSION_ID, SESSION_FLAGS);
    const resumed = registry.open({
      workingDirectory: SMOKE_WORKING_DIRECTORY,
      resumeSessionId: RESUMED_SESSION_ID
    });
    console.log(`[flags-smoke] resume: claude ${commandLineOf(resumed)}`);
    mustContain(resumed, "--resume", "a resume is not a resume");
    mustContain(resumed, SESSION_FLAGS, "a resumed session lost the flags it was started with");
    registry.close(resumed.terminalId);

    // 3. A fork of the same session.
    const forked = registry.open({
      workingDirectory: SMOKE_WORKING_DIRECTORY,
      resumeSessionId: RESUMED_SESSION_ID,
      forkSession: true,
      sessionName: "a copy"
    });
    console.log(`[flags-smoke] fork: claude ${commandLineOf(forked)}`);
    mustContain(forked, "--fork-session", "the fork is not a fork");
    mustContain(forked, SESSION_FLAGS, "a fork lost the original's flags");
    registry.close(forked.terminalId);

    // 4. And what may never get through, however it was written down.
    settings.update({ extraClaudeArguments: "--resume somewhere-else --print" });
    const guarded = registry.open({ workingDirectory: SMOKE_WORKING_DIRECTORY });
    console.log(`[flags-smoke] with reserved flags in settings: claude ${commandLineOf(guarded)}`);
    if (settings.get().extraClaudeArguments !== "") {
      throw new Error("settings.json kept flags the app sets itself");
    }
    if (commandLineOf(guarded).includes("--print") || commandLineOf(guarded).includes("somewhere-else")) {
      throw new Error("a reserved flag reached the command line");
    }
    registry.close(guarded.terminalId);

    settings.update({ extraClaudeArguments: GLOBAL_FLAGS });
    await checkTheFields(window);
    console.log("[flags-smoke] all three levels arrive, and the reserved flags do not");
  } catch (error) {
    console.log(`[flags-smoke] failed: ${error && error.message ? error.message : error}`);
  } finally {
    if (addedAgentId) {
      agents.deleteAgent(addedAgentId);
    }
    await wait(500);
    quit();
  }
}
