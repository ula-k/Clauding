// The terminal registry: one pty per terminal the app opened, each running
// the Claude Code CLI. The renderer draws them with xterm.js; this side only
// spawns, forwards bytes in both directions, tracks which session each
// terminal ended up owning, and kills everything on quit.
//
// Session linking (verified with CLI 2.1.270): the CLI registers itself in
// ~/.claude/sessions/<pid>.json right after start, and node-pty's child pid is
// that same pid (the binary does not re-exec), so the file named after the
// child pid gives the session id. If that file never shows up, a registry
// entry with the same cwd started after the spawn is taken as a fallback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import nodePty from "node-pty";
import channels from "./channels.cjs";
import { claudeExecutablePath, supportsAppendSystemPromptFile, terminalEnvironment } from "./claudeCli.js";
import { buildAgentSystemPrompt } from "./agents.js";
import { isProcessAlive } from "./liveStatus.js";

const { CHANNELS } = channels;

const OUTPUT_FLUSH_MILLISECONDS = 16;
const REPLAY_BUFFER_MAX_CHARACTERS = 400000;
const LINK_POLL_MILLISECONDS = 1000;
const LINK_FALLBACK_AFTER_MILLISECONDS = 10000;
const CLOSE_GRACE_MILLISECONDS = 3000;
// A terminal that a click opened, never got a keystroke and whose CLI has
// sat idle this long is hung up, so browsing the list cannot pile up
// `claude` processes. The session itself stays on disk.
const UNTOUCHED_IDLE_CLOSE_MILLISECONDS = 20 * 60 * 1000;
const sessionsRegistryDirectory = path.join(os.homedir(), ".claude", "sessions");

function readJsonQuietly(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function registryEntryForPid(pid) {
  const record = readJsonQuietly(path.join(sessionsRegistryDirectory, `${pid}.json`));
  if (!record || typeof record.sessionId !== "string") {
    return null;
  }
  return record;
}

// Fallback lookup: any live registry entry for the same folder that started
// after the terminal did and is not yet claimed by another terminal.
function registryEntryByFolder(workingDirectory, startedAt, claimedSessionIds) {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsRegistryDirectory);
  } catch (error) {
    return null;
  }
  for (const fileName of entries) {
    if (!fileName.endsWith(".json")) {
      continue;
    }
    const record = readJsonQuietly(path.join(sessionsRegistryDirectory, fileName));
    if (!record || typeof record.sessionId !== "string" || record.cwd !== workingDirectory) {
      continue;
    }
    if (Number(record.startedAt) < startedAt - 5000 || claimedSessionIds.has(record.sessionId)) {
      continue;
    }
    if (!isProcessAlive(Number(record.pid))) {
      continue;
    }
    return record;
  }
  return null;
}

// `readPreamble()` returns the text appended to the CLI's system prompt;
// `commandDirectory` (bin/ with the `clauding` command) is put on the pty's PATH.
// `resolveAgent(agentId)` gives the agent a terminal was started as (or null),
// and `promptDirectory` is where the combined system-prompt file of such a
// terminal is written for the length of its life.
export function createTerminalRegistry({
  sendToWindow,
  onChange,
  log,
  readPreamble,
  commandDirectory,
  resolveAgent,
  promptDirectory
}) {
  const terminals = new Map();
  let linkPoller = null;

  function logLine(line) {
    if (log) {
      log(`[terminal] ${line}`);
    }
  }

  function publicRecord(record) {
    return {
      terminalId: record.terminalId,
      pid: record.pid,
      workingDirectory: record.workingDirectory,
      resumeSessionId: record.resumeSessionId,
      sessionId: record.sessionId,
      forkedFromSessionId: record.forkedFromSessionId,
      sessionName: record.sessionName,
      agentId: record.agentId,
      startedAt: record.startedAt,
      focusedAt: record.focusedAt,
      registryStatus: record.registryStatus,
      openedByClick: record.openedByClick,
      receivedInput: record.receivedInput,
      exited: record.exited,
      exitCode: record.exitCode
    };
  }

  function list() {
    return Array.from(terminals.values()).map(publicRecord);
  }

  function announceChange() {
    sendToWindow(CHANNELS.terminalChanged, { terminals: list() });
    if (onChange) {
      onChange();
    }
  }

  function flushOutput(record) {
    record.flushTimer = null;
    if (record.pendingOutput.length === 0) {
      return;
    }
    const data = record.pendingOutput.join("");
    record.pendingOutput = [];
    record.replayBuffer += data;
    if (record.replayBuffer.length > REPLAY_BUFFER_MAX_CHARACTERS) {
      record.replayBuffer = record.replayBuffer.slice(-REPLAY_BUFFER_MAX_CHARACTERS);
    }
    sendToWindow(CHANNELS.terminalData, { terminalId: record.terminalId, data });
  }

  // Heavy output arrives in many small chunks; they are joined and shipped
  // to the renderer at most once per frame so xterm gets bigger writes.
  function queueOutput(record, data) {
    record.pendingOutput.push(data);
    if (!record.flushTimer) {
      record.flushTimer = setTimeout(() => flushOutput(record), OUTPUT_FLUSH_MILLISECONDS);
    }
  }

  function claimedSessionIds() {
    const claimed = new Set();
    for (const record of terminals.values()) {
      if (record.sessionId && !record.exited) {
        claimed.add(record.sessionId);
      }
    }
    return claimed;
  }

  // Reads the registry entry of every live terminal: links the session id
  // the first time it appears and keeps the busy / idle status fresh.
  function refreshLinks() {
    let changed = false;
    for (const record of terminals.values()) {
      if (record.exited) {
        continue;
      }
      let entry = registryEntryForPid(record.pid);
      if (!entry && !record.sessionId && Date.now() - record.startedAt > LINK_FALLBACK_AFTER_MILLISECONDS) {
        entry = registryEntryByFolder(record.workingDirectory, record.startedAt, claimedSessionIds());
        if (entry) {
          logLine(`${record.terminalId}: linked by folder fallback (pid ${entry.pid})`);
        }
      }
      if (!entry) {
        continue;
      }
      if (entry.sessionId !== record.sessionId) {
        record.sessionId = entry.sessionId;
        changed = true;
        logLine(`${record.terminalId}: session ${entry.sessionId} (pid ${record.pid})`);
      }
      const status = typeof entry.status === "string" ? entry.status : null;
      if (status !== record.registryStatus) {
        record.registryStatus = status;
        record.statusChangedAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      announceChange();
    }
    closeUntouchedIdleTerminals();
    updatePoller();
  }

  function closeUntouchedIdleTerminals() {
    for (const record of terminals.values()) {
      if (record.exited || !record.openedByClick || record.receivedInput || record.closeTimer) {
        continue;
      }
      if (record.registryStatus === "idle" && Date.now() - record.statusChangedAt > UNTOUCHED_IDLE_CLOSE_MILLISECONDS) {
        logLine(`${record.terminalId}: idle for 20 minutes without a keystroke, hanging up`);
        close(record.terminalId);
      }
    }
  }

  function updatePoller() {
    const needsPolling = Array.from(terminals.values()).some((record) => !record.exited);
    if (needsPolling && !linkPoller) {
      linkPoller = setInterval(refreshLinks, LINK_POLL_MILLISECONDS);
    } else if (!needsPolling && linkPoller) {
      clearInterval(linkPoller);
      linkPoller = null;
    }
  }

  function handleExit(record, exitCode) {
    if (record.exited) {
      return;
    }
    record.exited = true;
    record.exitCode = exitCode;
    if (record.closeTimer) {
      clearTimeout(record.closeTimer);
      record.closeTimer = null;
    }
    if (record.flushTimer) {
      clearTimeout(record.flushTimer);
    }
    flushOutput(record);
    removePromptFile(record);
    logLine(`${record.terminalId}: exited with ${exitCode}`);
    terminals.delete(record.terminalId);
    sendToWindow(CHANNELS.terminalExit, { terminalId: record.terminalId, exitCode, sessionId: record.sessionId });
    announceChange();
  }

  // The combined system prompt of a terminal running as an agent lives in
  // its own file for as long as the terminal does: the preamble plus the
  // whole agent definition is far more text than belongs on a command line.
  function writePromptFile(terminalId, text) {
    if (!promptDirectory) {
      return null;
    }
    try {
      fs.mkdirSync(promptDirectory, { recursive: true });
      const filePath = path.join(promptDirectory, `${terminalId}.md`);
      fs.writeFileSync(filePath, text);
      return filePath;
    } catch (error) {
      logLine(`${terminalId}: could not write the system prompt file: ${error.message}`);
      return null;
    }
  }

  function removePromptFile(record) {
    if (!record.promptFilePath) {
      return;
    }
    try {
      fs.unlinkSync(record.promptFilePath);
    } catch (error) {
      // Already gone, or never written; nothing to clean up.
    }
    record.promptFilePath = null;
  }

  // `openedByClick` marks terminals the session list opened on a click (see
  // UNTOUCHED_IDLE_CLOSE_MILLISECONDS); "+ New" terminals are never auto-closed.
  //
  // `forkSession` turns the resume into a fork: `--fork-session` makes the CLI
  // carry the whole conversation into a *new* session id, leaving the original
  // transcript untouched, and `--name` gives the copy its own display name.
  // Because the id is new, the record starts with no session id at all and
  // waits for the CLI to register one (see refreshLinks).
  function open({
    workingDirectory,
    resumeSessionId = null,
    forkSession = false,
    sessionName = null,
    agentId = null,
    columns = 100,
    rows = 30,
    openedByClick = false
  }) {
    if (!workingDirectory || !fs.existsSync(workingDirectory)) {
      throw new Error(`The folder does not exist: ${workingDirectory}`);
    }
    if (forkSession && !resumeSessionId) {
      throw new Error("A fork needs the session id it copies.");
    }
    const terminalId = randomUUID();
    const agent = agentId && resolveAgent ? resolveAgent(agentId) : null;
    const commandArguments = resumeSessionId ? ["--resume", resumeSessionId] : [];
    if (forkSession) {
      commandArguments.push("--fork-session");
    }
    const cleanSessionName = typeof sessionName === "string" ? sessionName.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    // A name the user typed always wins; an agent session that has none is
    // titled after the agent, so the CLI's own header says who is working.
    const displayName = cleanSessionName || (agent ? `${agent.emoji} ${agent.name}`.trim() : "");
    if (displayName) {
      commandArguments.push("--name", displayName);
    }
    const preamble = readPreamble ? readPreamble() : "";
    // One append, always: the preamble alone, or the preamble followed by
    // who this session is and its whole agent definition.
    const appendedPrompt = agent ? buildAgentSystemPrompt(preamble, agent) : preamble;
    let promptFilePath = agent ? writePromptFile(terminalId, appendedPrompt) : null;
    if (promptFilePath && !supportsAppendSystemPromptFile(promptFilePath)) {
      try {
        fs.unlinkSync(promptFilePath);
      } catch (error) {
        // Nothing to clean up.
      }
      promptFilePath = null;
    }
    if (appendedPrompt) {
      if (promptFilePath) {
        commandArguments.push("--append-system-prompt-file", promptFilePath);
      } else {
        commandArguments.push("--append-system-prompt", appendedPrompt);
      }
      // Without this the CLI records the system prompt on a conversation's
      // first request and replays that recording on every `--resume`, so the
      // preamble of a session that was not born inside Clauding never
      // arrives — the session then does not know about the right panel at
      // all (it published a claude.ai Artifact instead). "off" renders the
      // prompt fresh on every request, so a resumed session gets it too.
      commandArguments.push("--system-prompt-snapshot", "off");
    }
    const environment = terminalEnvironment();
    environment.CLAUDING_TERMINAL_ID = terminalId;
    if (commandDirectory) {
      environment.PATH = [commandDirectory, environment.PATH || ""].filter(Boolean).join(path.delimiter);
    }
    const child = nodePty.spawn(claudeExecutablePath(), commandArguments, {
      name: "xterm-256color",
      cols: Math.max(20, Math.floor(columns)),
      rows: Math.max(5, Math.floor(rows)),
      cwd: workingDirectory,
      env: environment
    });
    const record = {
      terminalId,
      pid: child.pid,
      process: child,
      workingDirectory,
      resumeSessionId,
      sessionId: forkSession ? null : resumeSessionId,
      forkedFromSessionId: forkSession ? resumeSessionId : null,
      sessionName: displayName || null,
      agentId: agent ? agent.id : null,
      promptFilePath,
      startedAt: Date.now(),
      // When this terminal was last looked at or typed into; the `clauding`
      // command falls back to the most recently focused one (see main.js).
      focusedAt: Date.now(),
      registryStatus: null,
      statusChangedAt: Date.now(),
      openedByClick: Boolean(openedByClick),
      receivedInput: false,
      exited: false,
      exitCode: null,
      pendingOutput: [],
      flushTimer: null,
      replayBuffer: "",
      closeTimer: null
    };
    terminals.set(record.terminalId, record);
    child.onData((data) => queueOutput(record, data));
    child.onExit(({ exitCode }) => handleExit(record, exitCode));
    // The appended prompt itself is thousands of characters; the log shows
    // that it was passed, not what it said.
    const shownArguments = commandArguments.map((argument, position) =>
      commandArguments[position - 1] === "--append-system-prompt" ? "…" : argument
    );
    logLine(`${record.terminalId}: spawned claude ${shownArguments.join(" ")} in ${workingDirectory} (pid ${child.pid})`);
    announceChange();
    updatePoller();
    return publicRecord(record);
  }

  function write(terminalId, data) {
    const record = terminals.get(terminalId);
    if (record && !record.exited) {
      record.focusedAt = Date.now();
      if (!record.receivedInput) {
        record.receivedInput = true;
        announceChange();
      }
      record.process.write(data);
    }
  }

  function resize(terminalId, columns, rows) {
    const record = terminals.get(terminalId);
    if (!record || record.exited) {
      return;
    }
    const safeColumns = Math.max(20, Math.floor(columns));
    const safeRows = Math.max(5, Math.floor(rows));
    try {
      record.process.resize(safeColumns, safeRows);
    } catch (error) {
      // The process may be gone already.
    }
  }

  // Hangs the process up; if it ignores that for a few seconds, kills it.
  // The transcript on disk is untouched, so the session can be resumed.
  function close(terminalId) {
    const record = terminals.get(terminalId);
    if (!record || record.exited) {
      return { closed: false };
    }
    try {
      record.process.kill("SIGHUP");
    } catch (error) {
      // Already gone.
    }
    record.closeTimer = setTimeout(() => {
      if (!record.exited) {
        try {
          record.process.kill("SIGKILL");
        } catch (error) {
          // Already gone.
        }
      }
    }, CLOSE_GRACE_MILLISECONDS);
    return { closed: true };
  }

  function closeAll() {
    for (const record of Array.from(terminals.values())) {
      if (record.exited) {
        continue;
      }
      try {
        record.process.kill("SIGHUP");
      } catch (error) {
        // Already gone.
      }
    }
    if (linkPoller) {
      clearInterval(linkPoller);
      linkPoller = null;
    }
  }

  // Everything the terminal printed so far (bounded), for a renderer that
  // (re)creates its xterm instance after a reload.
  function replay(terminalId) {
    const record = terminals.get(terminalId);
    return record ? record.replayBuffer : "";
  }

  // sessionId -> { terminalId, pid, registryStatus } for live terminals.
  function ownedStates() {
    const states = new Map();
    for (const record of terminals.values()) {
      if (record.sessionId && !record.exited) {
        states.set(record.sessionId, {
          terminalId: record.terminalId,
          pid: record.pid,
          registryStatus: record.registryStatus
        });
      }
    }
    return states;
  }

  // The renderer says which terminal is on screen, and every keystroke counts
  // too, so a `clauding` command with no terminal id of its own can still land
  // in the pane the user is looking at.
  function markFocused(terminalId) {
    const record = terminals.get(terminalId);
    if (!record || record.exited) {
      return false;
    }
    record.focusedAt = Date.now();
    return true;
  }

  function mostRecentlyFocused() {
    let newest = null;
    for (const record of terminals.values()) {
      if (record.exited) {
        continue;
      }
      if (!newest || (record.focusedAt || record.startedAt) > (newest.focusedAt || newest.startedAt)) {
        newest = record;
      }
    }
    return newest ? publicRecord(newest) : null;
  }

  function get(terminalId) {
    const record = terminals.get(terminalId);
    return record ? publicRecord(record) : null;
  }

  // Text the terminal printed recently, with escape sequences stripped —
  // only used by the dev smoke run to spot the CLI's own dialogs.
  function recentPlainOutput(terminalId, characters = 4000) {
    const record = terminals.get(terminalId);
    if (!record) {
      return "";
    }
    return record.replayBuffer
      .slice(-characters)
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ")
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\s+/g, " ");
  }

  return {
    open,
    write,
    resize,
    close,
    closeAll,
    list,
    get,
    replay,
    refreshLinks,
    ownedStates,
    markFocused,
    mostRecentlyFocused,
    recentPlainOutput
  };
}
