// What the running app does with one request from the `clauding` command
// (bin/clauding sends it over the socket; electron/commandSocket.js turns the
// line into an object). Everything Electron-specific stays in main.js and is
// handed in here: the terminal registry, the panel tab store, how a target is
// described, what the renderer last reported as the session on screen, and
// where to send the panel:command notice.
//
// The reply of a successful request is the one line the session reads back,
// so its shape matters: it always names where the tab actually went.
//
// `clauding agent add|list` is the one command that has nothing to do with
// the panel: it registers a definition folder in the app's agent list, so a
// session that has just written an agent can put it in the Agents tab
// itself instead of asking the user to click through the form.
import fs from "node:fs";
import path from "node:path";
import { AGENT_COLOR_TOKENS, inspectDefinitionFolder } from "../agents.js";

const PANEL_COMMANDS = ["open", "panel", "tabs"];

// The colour a new agent gets: the first swatch of the palette nobody uses
// yet, so two agents added in a row are never the same colour. Once every
// swatch is taken the palette starts again from the beginning.
export function nextFreeAgentColor(existingAgents) {
  const taken = new Set((existingAgents || []).map((agent) => agent.color));
  const free = AGENT_COLOR_TOKENS.find((token) => !taken.has(token));
  return free || AGENT_COLOR_TOKENS[(existingAgents || []).length % AGENT_COLOR_TOKENS.length];
}

// Which tab set a `clauding` command goes to, in order:
//   1. the terminal it was run in (CLAUDING_TERMINAL_ID from the pty),
//   2. the session the user is looking at right now — the pane on screen,
//   3. the terminal that was focused or typed into most recently.
// `fallback` names the one that was used, so the confirmation line can say
// where the tab actually went instead of letting an agent guess.
export function createCommandRequestHandler({
  terminals,
  panelTabs,
  describeTarget,
  readPanelSelection,
  onPanelCommand,
  // The app's agent list, as two calls: `list()` and `add(draft)`. Left out
  // by callers that only care about the panel (the dry tests of `open`).
  agents = null,
  log
}) {
  // The tab set a terminal's commands go to: its session id, or a temporary
  // key while the CLI has not registered the session yet.
  function panelKeyForTerminal(terminalId) {
    const terminal = terminalId ? terminals.get(terminalId) : null;
    if (!terminal) {
      return null;
    }
    return terminal.sessionId || `terminal:${terminal.terminalId}`;
  }

  function resolveCommandTarget(terminalId) {
    const panelSelection = (readPanelSelection ? readPanelSelection() : null) || {};
    const callerTerminal = terminalId ? terminals.get(terminalId) : null;
    if (callerTerminal && !callerTerminal.exited) {
      return {
        sessionKey: panelKeyForTerminal(callerTerminal.terminalId),
        workingDirectory: callerTerminal.workingDirectory,
        fallback: null
      };
    }
    const selectedTerminal = panelSelection.terminalId ? terminals.get(panelSelection.terminalId) : null;
    if (selectedTerminal && !selectedTerminal.exited) {
      return {
        sessionKey: panelKeyForTerminal(selectedTerminal.terminalId),
        workingDirectory: selectedTerminal.workingDirectory,
        fallback: "current session"
      };
    }
    if (panelSelection.sessionKey) {
      return { sessionKey: panelSelection.sessionKey, workingDirectory: null, fallback: "current session" };
    }
    const recentTerminal = terminals.mostRecentlyFocused();
    if (recentTerminal) {
      return {
        sessionKey: panelKeyForTerminal(recentTerminal.terminalId),
        workingDirectory: recentTerminal.workingDirectory,
        fallback: "most recent terminal"
      };
    }
    return { sessionKey: null, workingDirectory: null, fallback: null };
  }

  // "Opened X in the Clauding panel." / "… (current session)." — one shape, so
  // the line is the same whether the caller's own terminal was used or not.
  function confirmationLine(text, fallback) {
    return fallback ? `${text} (${fallback}).` : `${text}.`;
  }

  // Requests from bin/clauding (over the socket) and from the renderer share this.
  function openPanelTab({ sessionKey, terminalId, target, baseDirectory, reveal = true }) {
    const key = sessionKey || panelKeyForTerminal(terminalId);
    if (!key) {
      throw new Error("This terminal is not known to the app (CLAUDING_TERMINAL_ID missing or stale).");
    }
    const terminal = terminalId ? terminals.get(terminalId) : null;
    const description = describeTarget(target, baseDirectory || (terminal ? terminal.workingDirectory : null));
    const tab = panelTabs.open(key, description, { reveal });
    return { sessionKey: key, tab };
  }

  // `clauding agent list`: one line per registered agent.
  function listAgents() {
    const registered = agents.list();
    if (registered.length === 0) {
      return "No agents are registered in Clauding yet.";
    }
    return registered
      .map((agent) => `${agent.emoji} ${agent.name} — ${agent.definitionFolder}`)
      .join("\n");
  }

  // `clauding agent add <folder>`: the same suggestions the "+ Add agent"
  // form makes (definition file, name, emoji), the next free colour, and the
  // flags the caller passed on top of them. The folder is what identifies an
  // agent, so the same one is never registered twice.
  function addAgent(request) {
    const rawFolder = String(request.definitionFolder || "").trim();
    if (!rawFolder) {
      throw new Error("Use: clauding agent add <definition folder>");
    }
    const definitionFolder = path.resolve(request.cwd || process.cwd(), rawFolder);
    let isFolder = false;
    try {
      isFolder = fs.statSync(definitionFolder).isDirectory();
    } catch (error) {
      isFolder = false;
    }
    if (!isFolder) {
      throw new Error(`there is no folder at ${definitionFolder}.`);
    }
    const already = agents.list().find((agent) => agent.definitionFolder === definitionFolder) || null;
    if (already) {
      throw new Error(`that folder is already registered as "${already.name}".`);
    }
    const suggestion = inspectDefinitionFolder(definitionFolder);
    if (!suggestion.definitionFile) {
      throw new Error(`there is no Markdown definition file in ${definitionFolder}.`);
    }
    const draft = {
      name: String(request.name || "").trim() || suggestion.name,
      emoji: String(request.emoji || "").trim() || suggestion.emoji,
      color: String(request.color || "").trim() || nextFreeAgentColor(agents.list()),
      definitionFolder,
      definitionFile: suggestion.definitionFile
    };
    const added = agents.add(draft);
    return `Added agent "${added.name}" to Clauding.`;
  }

  function handleAgentRequest(request) {
    if (!agents) {
      throw new Error("this window has no agent list.");
    }
    if (request.action === "list") {
      return listAgents();
    }
    if (request.action === "add") {
      return addAgent(request);
    }
    throw new Error("Use: clauding agent add <definition folder> | clauding agent list");
  }

  async function handleCommandRequest(request) {
    if (request.command === "agent") {
      return handleAgentRequest(request);
    }
    if (!PANEL_COMMANDS.includes(request.command)) {
      throw new Error(`Unknown command: ${request.command}`);
    }
    if (request.command === "panel" && request.action !== "show" && request.action !== "hide") {
      throw new Error("Use: clauding panel show|hide");
    }
    const commandTarget = resolveCommandTarget(request.terminalId);
    if (commandTarget.fallback && log) {
      log(
        `[socket] ${request.command}: no live terminal for id ${request.terminalId || "(none)"} — using the ${commandTarget.fallback} (${commandTarget.sessionKey})`
      );
    }
    if (!commandTarget.sessionKey) {
      throw new Error("This terminal is not known to the app (CLAUDING_TERMINAL_ID missing or stale).");
    }
    if (request.command === "open") {
      const { tab } = openPanelTab({
        sessionKey: commandTarget.sessionKey,
        target: request.target,
        baseDirectory: request.cwd || commandTarget.workingDirectory
      });
      return confirmationLine(`Opened ${tab.target} in the Clauding panel`, commandTarget.fallback);
    }
    if (request.command === "panel") {
      // The flag belongs to the session the command came from; the renderer
      // picks the change up through panel:changed and only acts on it when that
      // session is the one on screen.
      panelTabs.setVisible(commandTarget.sessionKey, request.action === "show");
      if (onPanelCommand) {
        onPanelCommand({ action: request.action, sessionKey: commandTarget.sessionKey });
      }
      return confirmationLine(request.action === "show" ? "Panel shown" : "Panel hidden", commandTarget.fallback);
    }
    const state = panelTabs.get(commandTarget.sessionKey);
    if (state.tabs.length === 0) {
      return confirmationLine("No tabs open for this session", commandTarget.fallback);
    }
    const lines = state.tabs.map((tab) => `${tab.tabId === state.activeTabId ? "*" : " "} [${tab.kind}] ${tab.target}`);
    return commandTarget.fallback ? [`Tabs (${commandTarget.fallback}):`].concat(lines).join("\n") : lines.join("\n");
  }

  return { handleCommandRequest, resolveCommandTarget, openPanelTab, panelKeyForTerminal };
}
