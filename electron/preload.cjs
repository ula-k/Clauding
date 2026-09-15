// Runs in the renderer's isolated world. Exposes a tiny, explicit API on
// window.clauding; the renderer never touches Node or Electron directly.
// CommonJS on purpose: Electron loads preload scripts through its own loader,
// which only understands CommonJS (the window runs with sandbox: false so this
// file can require the shared channel list).
const { contextBridge, ipcRenderer } = require("electron");

const { CHANNELS } = require("./channels.cjs");

function subscribe(channel, listener) {
  const wrapped = (event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return function unsubscribe() {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld("clauding", {
  listSessions(options) {
    return ipcRenderer.invoke(CHANNELS.sessionsList, options || {});
  },
  getSession(sessionId) {
    return ipcRenderer.invoke(CHANNELS.sessionsGet, { sessionId });
  },
  renameSession(sessionId, title) {
    return ipcRenderer.invoke(CHANNELS.sessionsRename, { sessionId, title });
  },
  onSessionsChanged(listener) {
    return subscribe(CHANNELS.sessionsChanged, listener);
  },
  // The user's own grouping of the session list (groups.json).
  getSessionGroups() {
    return ipcRenderer.invoke(CHANNELS.groupsGet);
  },
  createSessionGroup(name) {
    return ipcRenderer.invoke(CHANNELS.groupsCreate, { name });
  },
  renameSessionGroup(groupId, name) {
    return ipcRenderer.invoke(CHANNELS.groupsRename, { groupId, name });
  },
  moveSessionGroup(groupId, direction) {
    return ipcRenderer.invoke(CHANNELS.groupsMove, { groupId, direction });
  },
  deleteSessionGroup(groupId) {
    return ipcRenderer.invoke(CHANNELS.groupsDelete, { groupId });
  },
  assignSessionToGroup(sessionId, groupId) {
    return ipcRenderer.invoke(CHANNELS.groupsAssign, { sessionId, groupId });
  },
  setSessionHidden(sessionId, hidden) {
    return ipcRenderer.invoke(CHANNELS.groupsSetHidden, { sessionId, hidden });
  },
  // Folding a group shut in the list (remembered in groups.json).
  setSessionGroupCollapsed(groupId, collapsed) {
    return ipcRenderer.invoke(CHANNELS.groupsSetCollapsed, { groupId, collapsed });
  },
  onSessionGroupsChanged(listener) {
    return subscribe(CHANNELS.groupsChanged, listener);
  },
  // The user's agents (agents.json): the definition folders and which agent each
  // session was started with.
  getAgents() {
    return ipcRenderer.invoke(CHANNELS.agentsGet);
  },
  addAgent(draft) {
    return ipcRenderer.invoke(CHANNELS.agentsAdd, draft);
  },
  updateAgent(agentId, draft) {
    return ipcRenderer.invoke(CHANNELS.agentsUpdate, { agentId, draft });
  },
  deleteAgent(agentId) {
    return ipcRenderer.invoke(CHANNELS.agentsDelete, { agentId });
  },
  // What the agent form fills in once a definition folder is picked.
  inspectAgentFolder(definitionFolder) {
    return ipcRenderer.invoke(CHANNELS.agentsInspectFolder, { definitionFolder });
  },
  inspectAgentFile(definitionFile) {
    return ipcRenderer.invoke(CHANNELS.agentsInspectFile, { definitionFile });
  },
  pickAgentFolder() {
    return ipcRenderer.invoke(CHANNELS.agentsPickFolder);
  },
  // Every session agents.json links to an agent, read straight from disk by
  // its id — the Agents tab must not be limited to the page of rows the
  // Sessions list happens to have loaded.
  getLinkedAgentSessions() {
    return ipcRenderer.invoke(CHANNELS.agentsLinkedSessions);
  },
  onAgentsChanged(listener) {
    return subscribe(CHANNELS.agentsChanged, listener);
  },
  getSystemLanguage() {
    return ipcRenderer.invoke(CHANNELS.systemLanguage);
  },
  // The macOS emoji panel (⌃⌘Space). It types into whatever has focus, so
  // the caller focuses its field first. Answers { supported, opened }.
  showEmojiPanel() {
    return ipcRenderer.invoke(CHANNELS.systemEmojiPanel);
  },
  listRecentProjects() {
    return ipcRenderer.invoke(CHANNELS.projectsRecent);
  },
  pickProjectFolder() {
    return ipcRenderer.invoke(CHANNELS.projectsPick);
  },
  // Terminals: one pty running `claude` per terminal id.
  openTerminal(request) {
    return ipcRenderer.invoke(CHANNELS.terminalOpen, request);
  },
  writeToTerminal(terminalId, data) {
    ipcRenderer.send(CHANNELS.terminalInput, { terminalId, data });
  },
  resizeTerminal(terminalId, columns, rows) {
    ipcRenderer.send(CHANNELS.terminalResize, { terminalId, columns, rows });
  },
  listTerminals() {
    return ipcRenderer.invoke(CHANNELS.terminalList);
  },
  replayTerminal(terminalId) {
    return ipcRenderer.invoke(CHANNELS.terminalReplay, { terminalId });
  },
  onTerminalData(listener) {
    return subscribe(CHANNELS.terminalData, listener);
  },
  onTerminalExit(listener) {
    return subscribe(CHANNELS.terminalExit, listener);
  },
  onTerminalsChanged(listener) {
    return subscribe(CHANNELS.terminalChanged, listener);
  },
  // The right panel: tabs kept per session in the main process.
  getPanelTabs(sessionKey) {
    return ipcRenderer.invoke(CHANNELS.panelGet, { sessionKey });
  },
  // `target` is a path or URL typed / clicked in the renderer; one of
  // sessionKey / terminalId says whose tab set it goes to.
  openPanelTab(request) {
    return ipcRenderer.invoke(CHANNELS.panelOpen, request);
  },
  closePanelTab(sessionKey, tabId) {
    return ipcRenderer.invoke(CHANNELS.panelClose, { sessionKey, tabId });
  },
  activatePanelTab(sessionKey, tabId) {
    return ipcRenderer.invoke(CHANNELS.panelActivate, { sessionKey, tabId });
  },
  setPanelTabTitle(sessionKey, tabId, title) {
    return ipcRenderer.invoke(CHANNELS.panelSetTitle, { sessionKey, tabId, title });
  },
  // Show / hide the panel for one session (panel-tabs.json remembers it per
  // session; the panel's width is a window-wide setting and is not here).
  setPanelVisible(sessionKey, visible) {
    return ipcRenderer.invoke(CHANNELS.panelSetVisible, { sessionKey, visible });
  },
  onPanelChanged(listener) {
    return subscribe(CHANNELS.panelChanged, listener);
  },
  // Which session / terminal is on screen right now. The main process needs
  // it so a `clauding` command without a terminal id of its own can still
  // open its tab in the pane the user is looking at.
  reportPanelSelection(selection) {
    ipcRenderer.send(CHANNELS.panelSelection, selection || {});
  },
  // "show" / "hide" requested by the `clauding panel` command.
  onPanelCommand(listener) {
    return subscribe(CHANNELS.panelCommand, listener);
  },
  readPanelFile(filePath) {
    return ipcRenderer.invoke(CHANNELS.panelReadFile, { filePath });
  },
  watchPanelFile(filePath) {
    return ipcRenderer.invoke(CHANNELS.panelWatchFile, { filePath });
  },
  unwatchPanelFile(filePath) {
    return ipcRenderer.invoke(CHANNELS.panelUnwatchFile, { filePath });
  },
  onPanelFileChanged(listener) {
    return subscribe(CHANNELS.panelFileChanged, listener);
  },
  openExternally(target) {
    return ipcRenderer.invoke(CHANNELS.panelOpenExternal, { target });
  },
  // Dev-only: the CLAUDING_SMOKE_TERMINAL / CLAUDING_SCREENSHOT hooks drive the UI through this.
  onSmokeCommand(listener) {
    return subscribe(CHANNELS.smokeCommand, listener);
  }
});
