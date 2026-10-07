// The terminals that were open when the app last closed, offered back on the
// next start (<userData>/open-terminals.json).
//
// Why this exists: after a restart — an update, a crash, ⌘Q — every
// terminal was simply gone, and finding the five conversations that had
// been open meant scrolling the list. Now the file is rewritten on every
// change to the app's terminals, and on the next start those sessions are
// marked "was open" in the list. Nothing is spawned for them: each one is
// resumed only when its row is clicked, because starting them all at once
// would be five `claude`s nobody asked for yet (and the guard in
// lib/openGuard.js still makes sure a click never starts a second one).
//
// What is kept per terminal: its session id, folder, agent and its own extra
// flags, plus which one was on screen. Only terminals whose conversation can
// be resumed are kept — a fresh terminal nobody typed into has no transcript.
//
// The offer lasts until it is taken: a session from it that is opened again
// moves back into the live part, and one that is never clicked stays offered
// across further restarts rather than being forgotten because the app was
// closed once more in between.
import fs from "node:fs";
import path from "node:path";

export const OPEN_TERMINALS_FILE_NAME = "open-terminals.json";

// Terminal records (as terminals.js lists them) -> the entries kept on disk.
// `selectedTerminalId` is the terminal on screen.
export function openTerminalEntries(terminals, selectedTerminalId = null) {
  const entries = [];
  const seen = new Set();
  for (const terminal of terminals || []) {
    if (!terminal || !terminal.resumable || !terminal.sessionId || seen.has(terminal.sessionId)) {
      continue;
    }
    seen.add(terminal.sessionId);
    entries.push({
      sessionId: terminal.sessionId,
      workingDirectory: terminal.workingDirectory || null,
      agentId: terminal.agentId || null,
      extraArguments: terminal.sessionExtraArguments || "",
      selected: Boolean(selectedTerminalId) && terminal.terminalId === selectedTerminalId
    });
  }
  return entries;
}

// What goes into the file: the live terminals, and after them whatever the
// previous run offered that has not been opened again yet. At most one entry
// is `selected` — the live one on screen, or else the one that was selected
// in the offer.
export function mergeOpenTerminalLists({ live = [], offered = [] }) {
  const liveIds = new Set(live.map((entry) => entry.sessionId));
  const remaining = offered.filter((entry) => entry && entry.sessionId && !liveIds.has(entry.sessionId));
  const anyLiveSelected = live.some((entry) => entry.selected);
  return live.concat(remaining.map((entry) => ({ ...entry, selected: anyLiveSelected ? false : Boolean(entry.selected) })));
}

// The file as the previous run left it, cleaned up: unknown shapes are
// dropped rather than trusted.
export function readOpenTerminals(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const terminals = Array.isArray(parsed && parsed.terminals) ? parsed.terminals : [];
    return terminals
      .filter((entry) => entry && typeof entry.sessionId === "string" && entry.sessionId)
      .map((entry) => ({
        sessionId: entry.sessionId,
        workingDirectory: typeof entry.workingDirectory === "string" ? entry.workingDirectory : null,
        agentId: typeof entry.agentId === "string" ? entry.agentId : null,
        extraArguments: typeof entry.extraArguments === "string" ? entry.extraArguments : "",
        selected: Boolean(entry.selected)
      }));
  } catch (error) {
    return [];
  }
}

export function createOpenTerminalsStore({ filePath, log = null }) {
  // What the previous run left: offered back until each one is opened.
  let offered = readOpenTerminals(filePath);
  let frozen = false;
  let lastWritten = null;
  let lastLive = [];

  function logLine(line) {
    if (log) {
      log(`[open-terminals] ${line}`);
    }
  }

  if (offered.length > 0) {
    logLine(`offering back ${offered.length} session(s) that were open: ${offered.map((entry) => entry.sessionId).join(", ")}`);
  }

  // Called on every change to the app's terminals (and when the one on
  // screen changes). Writes only when the content actually changed.
  function update(terminals, selectedTerminalId = null) {
    if (frozen) {
      return;
    }
    lastLive = openTerminalEntries(terminals, selectedTerminalId);
    const liveIds = new Set(lastLive.map((entry) => entry.sessionId));
    offered = offered.filter((entry) => !liveIds.has(entry.sessionId));
    writeOffered();
  }

  // The live terminals as last reported, plus what is still on offer.
  function writeOffered() {
    const merged = mergeOpenTerminalLists({ live: lastLive, offered });
    const text = `${JSON.stringify({ version: 1, terminals: merged }, null, 2)}\n`;
    if (text === lastWritten) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.writing`;
      fs.writeFileSync(temporaryPath, text);
      fs.renameSync(temporaryPath, filePath);
      lastWritten = text;
    } catch (error) {
      logLine(`could not write ${filePath}: ${error.message}`);
    }
  }

  // Quitting hangs every terminal up, and each hang-up is a change: without
  // this the file would be emptied on the way out, one terminal at a time.
  function freeze() {
    frozen = true;
  }

  // sessionId -> entry, for the sessions still on offer.
  function offeredBySession() {
    return new Map(offered.map((entry) => [entry.sessionId, entry]));
  }

  // What the window asks for once on start: the offer and the session that
  // was on screen (only if it is still on offer — no terminal is started).
  function restoreOffer() {
    const selected = offered.find((entry) => entry.selected) || null;
    return { terminals: offered.slice(), selectedSessionId: selected ? selected.sessionId : null };
  }

  // A session offered back that went on under another id (Claude Code sent
  // it to the background, lib/continuedIn.js) is offered as that one: a
  // restore must never resume the stale copy. Written at once, so the file
  // says the same thing the next time the app starts.
  function carry(fromSessionId, toSessionId) {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
      return false;
    }
    if (!offered.some((entry) => entry.sessionId === fromSessionId)) {
      return false;
    }
    const alreadyOffered = offered.some((entry) => entry.sessionId === toSessionId);
    offered = alreadyOffered
      ? offered.filter((entry) => entry.sessionId !== fromSessionId)
      : offered.map((entry) => (entry.sessionId === fromSessionId ? { ...entry, sessionId: toSessionId } : entry));
    logLine(`${fromSessionId} continued in ${toSessionId}: offered back as the continuation`);
    if (!frozen) {
      writeOffered();
    }
    return true;
  }

  return { update, freeze, offeredBySession, restoreOffer, carry };
}
