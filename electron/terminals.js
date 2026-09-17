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
import {
  claudeExecutablePath,
  ptyOptionsFor,
  spawnPlanFor,
  supportsAppendSystemPromptFile,
  terminalEnvironment
} from "./claudeCli.js";
import { claudeRegistryPaths, isWindows } from "./lib/platformPaths.js";
import { buildClaudeArguments, buildTerminalEnvironment, mergeExtraArguments } from "./lib/claudeArguments.js";
import { buildAgentSystemPrompt } from "./agents.js";
import { isProcessAlive } from "./liveStatus.js";
import {
  KICKOFF_ENTER_DELAY_MILLISECONDS,
  KICKOFF_OUTPUT_CHARACTERS,
  KICKOFF_POLL_MILLISECONDS,
  KICKOFF_SETTLE_MILLISECONDS,
  KICKOFF_TIMEOUT_MILLISECONDS,
  isPromptReady,
  looksTypedByHand
} from "./lib/terminalKickoff.js";

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
const sessionsRegistryDirectory = claudeRegistryPaths({ homeDirectory: os.homedir() }).sessionsRegistryDirectory;

// Windows has no signals: node-pty ends the console process whatever it is
// handed, and passing a name it does not know is the one way to get an error.
// Everywhere else SIGHUP is the polite hang-up and SIGKILL the last resort.
const HANG_UP_SIGNAL = isWindows() ? undefined : "SIGHUP";
const FORCE_SIGNAL = isWindows() ? undefined : "SIGKILL";

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

// CLAUDING_DRY_SPAWN=1 (dev only): compose everything a terminal would be
// started with, write the prompt file, print the whole command line — and
// then do not start `claude` at all. It is how the fork-based actions
// ("Create agent from this conversation", "Harvest skills") are checked
// without paying for a real session; the terminal exists, it is simply
// silent.
const dryRunSpawn = process.env.CLAUDING_DRY_SPAWN === "1";

function quoteForLog(argument) {
  return /[\s"']/.test(argument) ? JSON.stringify(argument) : argument;
}

function dryRunChild(terminalId, commandArguments, workingDirectory, promptFilePath, logLine) {
  const commandLine = [claudeExecutablePath()].concat(commandArguments).map(quoteForLog).join(" ");
  logLine(`${terminalId}: DRY RUN, not spawning: ${commandLine}`);
  logLine(`${terminalId}: DRY RUN cwd: ${workingDirectory}`);
  if (promptFilePath) {
    logLine(`${terminalId}: DRY RUN prompt file: ${promptFilePath}`);
    try {
      const promptText = fs.readFileSync(promptFilePath, "utf8");
      const taskLine = promptText.split("\n").filter(Boolean).pop() || "";
      logLine(`${terminalId}: DRY RUN prompt file ends with: ${taskLine}`);
    } catch (error) {
      logLine(`${terminalId}: DRY RUN could not read the prompt file: ${error.message}`);
    }
  }
  // Enough of a pty for the registry to treat it like any other: it prints
  // nothing, and a hang-up ends it the way a real one would, so "restart
  // this terminal" can be tried in a dry run too.
  let reportExit = null;
  return {
    pid: 0,
    onData() {},
    onExit(listener) {
      reportExit = listener;
    },
    write() {},
    resize() {},
    kill() {
      if (reportExit) {
        const listener = reportExit;
        reportExit = null;
        setTimeout(() => listener({ exitCode: 0 }), 0);
      }
    }
  };
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
  promptDirectory,
  // The extra `claude` flags: the global ones from settings.json, and the
  // per-session ones a conversation keeps (electron/sessionFlags.js). The
  // agent's own come off the agent record itself.
  readGlobalExtraArguments = null,
  readSessionExtraArguments = null,
  rememberSessionExtraArguments = null
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
      // The flags this terminal was actually started with, so the header can
      // say so in its tooltip.
      extraArguments: record.extraArguments.slice(),
      // The whole command line, as it was composed: the dry-run hooks check
      // it, and it is what the log line says.
      commandArguments: record.commandArguments.slice(),
      sessionExtraArguments: record.sessionExtraArguments,
      // null when this terminal was opened without a first message of its
      // own; otherwise "waiting", "sent" or "needsMessage" (see deliverKickoff).
      kickoffState: record.kickoffState,
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
        // Now that the conversation has an id, its own flags can be filed
        // under it — a fork writes them under its new id too.
        if (rememberSessionExtraArguments && record.sessionExtraArguments) {
          rememberSessionExtraArguments(entry.sessionId, record.sessionExtraArguments);
        }
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

  function pause(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // A terminal opened to do one job ("Harvest skills", "Create agent from
  // this conversation") says what the job is in its system prompt — which
  // gives it a role but starts no turn. So the job is also typed in as the
  // first user message, as soon as the CLI is at its prompt.
  //
  // Nothing is ever typed into a dialog: if the CLI is asking something of
  // its own, the wait simply continues. After the timeout the terminal is
  // left exactly as it is and the header asks the user to type something.
  async function deliverKickoff(record, message) {
    const deadline = Date.now() + KICKOFF_TIMEOUT_MILLISECONDS;
    while (Date.now() < deadline) {
      if (record.exited) {
        return;
      }
      // The user got there first: their line is in the prompt already, and
      // pasting on top of it would mangle what they wrote.
      if (record.typedByHand) {
        record.kickoffState = null;
        logLine(`${record.terminalId}: the first message was typed by hand, the kickoff was dropped`);
        announceChange();
        return;
      }
      if (isPromptReady(record, recentPlainOutput(record.terminalId, KICKOFF_OUTPUT_CHARACTERS))) {
        await pause(KICKOFF_SETTLE_MILLISECONDS);
        if (record.exited || record.typedByHand) {
          continue;
        }
        // A long message counts as a paste, where Enter is only a newline,
        // so the text and the Enter are sent separately.
        record.process.write(message);
        await pause(KICKOFF_ENTER_DELAY_MILLISECONDS);
        if (record.exited) {
          return;
        }
        record.process.write("\r");
        record.kickoffState = "sent";
        logLine(`${record.terminalId}: kickoff sent (${message.length} characters)`);
        announceChange();
        return;
      }
      await pause(KICKOFF_POLL_MILLISECONDS);
    }
    if (record.exited) {
      return;
    }
    record.kickoffState = "needsMessage";
    logLine(`${record.terminalId}: the prompt never became ready, the kickoff was not sent`);
    announceChange();
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
    taskPrompt = null,
    kickoffMessage = null,
    extraArguments = null,
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
    const preamble = readPreamble ? readPreamble() : "";
    const cleanTaskPrompt = typeof taskPrompt === "string" ? taskPrompt.trim() : "";
    const cleanKickoffMessage = typeof kickoffMessage === "string" ? kickoffMessage.trim() : "";
    // One append, always: the preamble alone, or the preamble followed by
    // who this session is, its whole agent definition and — for a terminal
    // opened to do one job, like "Create agent from this conversation" —
    // that job.
    const appendedPrompt =
      agent || cleanTaskPrompt ? buildAgentSystemPrompt(preamble, agent, cleanTaskPrompt) : preamble;
    let promptFilePath = agent || cleanTaskPrompt ? writePromptFile(terminalId, appendedPrompt) : null;
    if (promptFilePath && !supportsAppendSystemPromptFile(promptFilePath)) {
      try {
        fs.unlinkSync(promptFilePath);
      } catch (error) {
        // Nothing to clean up.
      }
      promptFilePath = null;
    }
    // A name the user typed always wins; an agent session that has none is
    // titled after the agent, so the CLI's own header says who is working.
    // `--system-prompt-snapshot off` rides along with every appended prompt:
    // without it the CLI records the system prompt on a conversation's first
    // request and replays that recording on every `--resume`, so the preamble
    // of a session that was not born inside Clauding never arrives — the
    // session then does not know about the right panel at all (it published a
    // claude.ai Artifact instead). See lib/claudeArguments.js.
    // Global -> agent -> session, in that order. A resume, a restart and a
    // fork all take the session's own flags out of the store, so a
    // conversation started with `--channels plugin:telegram` keeps its
    // channel for the rest of its life.
    const inheritedSessionExtra = resumeSessionId && readSessionExtraArguments ? readSessionExtraArguments(resumeSessionId) : "";
    const typedSessionExtra = typeof extraArguments === "string" ? extraArguments.trim() : "";
    const sessionExtraArguments = typedSessionExtra || inheritedSessionExtra || "";
    const mergedExtraArguments = mergeExtraArguments([
      readGlobalExtraArguments ? readGlobalExtraArguments() : "",
      agent && agent.extraClaudeArguments ? agent.extraClaudeArguments : "",
      sessionExtraArguments
    ]);
    const { commandArguments, displayName } = buildClaudeArguments({
      resumeSessionId,
      forkSession,
      sessionName,
      // The agent only lends its name to a session that is *starting*: a
      // plain `--resume` of a session the user assigned to an agent must
      // not rename their conversation behind their back.
      agent: resumeSessionId && !forkSession ? null : agent,
      appendedPrompt,
      promptFilePath,
      extraArguments: mergedExtraArguments
    });
    const environment = buildTerminalEnvironment({
      baseEnvironment: terminalEnvironment(),
      terminalId,
      commandDirectory
    });
    // On Windows a `claude.cmd` has to go through `cmd.exe /c`, and the pty
    // needs ConPTY; spawnPlanFor / ptyOptionsFor answer both (claudeCli.js).
    const spawnPlan = spawnPlanFor(claudeExecutablePath(), commandArguments);
    const child = dryRunSpawn
      ? dryRunChild(terminalId, commandArguments, workingDirectory, promptFilePath, logLine)
      : nodePty.spawn(spawnPlan.file, spawnPlan.commandArguments, {
          name: "xterm-256color",
          cols: Math.max(20, Math.floor(columns)),
          rows: Math.max(5, Math.floor(rows)),
          cwd: workingDirectory,
          env: environment,
          ...ptyOptionsFor()
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
      // Input that is really somebody typing, as opposed to the answers
      // xterm gives the CLI's own queries: only that cancels a kickoff.
      typedByHand: false,
      extraArguments: mergedExtraArguments,
      sessionExtraArguments,
      commandArguments,
      kickoffState: cleanKickoffMessage ? "waiting" : null,
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
    if (cleanKickoffMessage) {
      if (dryRunSpawn) {
        record.kickoffState = null;
        logLine(`${record.terminalId}: DRY RUN kickoff message: ${cleanKickoffMessage}`);
      } else {
        deliverKickoff(record, cleanKickoffMessage);
      }
    }
    announceChange();
    updatePoller();
    return publicRecord(record);
  }

  function write(terminalId, data) {
    const record = terminals.get(terminalId);
    if (record && !record.exited) {
      record.focusedAt = Date.now();
      if (looksTypedByHand(data)) {
        record.typedByHand = true;
      }
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
      record.process.kill(HANG_UP_SIGNAL);
    } catch (error) {
      // Already gone.
    }
    record.closeTimer = setTimeout(() => {
      if (!record.exited) {
        try {
          record.process.kill(FORCE_SIGNAL);
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
        record.process.kill(HANG_UP_SIGNAL);
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
  // "Assign to agent" on a session that is open in one of our terminals:
  // the record follows, so the periodic re-linking in main.js cannot put the
  // old agent back, and a restart of that terminal loads the new definition.
  function setAgent(terminalId, agentId) {
    const record = terminals.get(terminalId);
    if (!record || record.exited || record.agentId === (agentId || null)) {
      return false;
    }
    record.agentId = agentId || null;
    announceChange();
    return true;
  }

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
    setAgent,
    markFocused,
    mostRecentlyFocused,
    recentPlainOutput
  };
}
