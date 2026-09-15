// What the running app does with one request from the `clauding` command
// (bin/clauding sends it over the socket; electron/commandSocket.js turns the
// line into an object). Everything Electron-specific stays in main.js and is
// handed in here: the terminal registry, the panel tab store, how a target is
// described, what the renderer last reported as the session on screen, and
// where to send the panel:command notice.
//
// The reply of a successful request is the one line the session reads back,
// so its shape matters: it always names where the tab actually went.

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

  async function handleCommandRequest(request) {
    if (request.command !== "open" && request.command !== "panel" && request.command !== "tabs") {
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
