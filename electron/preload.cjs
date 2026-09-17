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
  // The system the window is drawn on ("darwin", "win32", "linux"). The
  // renderer has no Node, and the two things that differ — the modifier key
  // and whether there is a native emoji panel — have to be decided while
  // drawing, not after an await. See src/renderer/platform.js.
  platform: process.platform,
  listSessions(options) {
    return ipcRenderer.invoke(CHANNELS.sessionsList, options || {});
  },
  getSession(sessionId) {
    return ipcRenderer.invoke(CHANNELS.sessionsGet, { sessionId });
  },
  renameSession(sessionId, title) {
    return ipcRenderer.invoke(CHANNELS.sessionsRename, { sessionId, title });
  },
  // "Delete session": closes the app's terminal for it, deletes the
  // transcript through the SDK and drops the session from groups.json,
  // agents.json and panel-tabs.json. Only ever called after the user has
  // answered the confirmation.
  deleteSession(sessionId) {
    return ipcRenderer.invoke(CHANNELS.sessionsDelete, { sessionId });
  },
  // Every place a word appears in this session's transcript file, subagents
  // included. The main process reads the JSONL; nothing is written.
  searchTranscript(sessionId, query) {
    return ipcRenderer.invoke(CHANNELS.transcriptSearch, { sessionId, query });
  },
  // "View → Find in conversation…" (⌘F) asking for the find bar.
  onShowFind(listener) {
    return subscribe(CHANNELS.transcriptFindShow, listener);
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
  // "Assign to agent" on a row or in the terminal header; a null agent id
  // removes the link. This is how a session that started long before its
  // agent existed is attached to one.
  assignSessionToAgent(sessionId, agentId) {
    return ipcRenderer.invoke(CHANNELS.agentsAssignSession, { sessionId, agentId: agentId || null });
  },
  // Puts the app's own Agent Maker back (and re-seeds the built-in skill).
  restoreBuiltinAgents() {
    return ipcRenderer.invoke(CHANNELS.agentsRestoreBuiltin);
  },
  onAgentsChanged(listener) {
    return subscribe(CHANNELS.agentsChanged, listener);
  },
  // A definition folder the Agent Maker (or anything else) just wrote under
  // the agents root, ready to be added as an agent with one click.
  onAgentDefinitionFound(listener) {
    return subscribe(CHANNELS.agentsDefinitionFound, listener);
  },
  // The extra `claude` flags one conversation carries (session-flags.json).
  // Read for the dialog behind "Extra claude flags…", written when it is
  // saved; an empty string takes the session's own flags away again.
  getSessionFlags() {
    return ipcRenderer.invoke(CHANNELS.sessionFlagsGet);
  },
  setSessionFlags(sessionId, flags) {
    return ipcRenderer.invoke(CHANNELS.sessionFlagsSet, { sessionId, flags: flags || "" });
  },
  onSessionFlagsChanged(listener) {
    return subscribe(CHANNELS.sessionFlagsChanged, listener);
  },
  // The app's own settings (settings.json): where new agent definitions are
  // written and where Claude Code reads skills from.
  getSettings() {
    return ipcRenderer.invoke(CHANNELS.settingsGet);
  },
  updateSettings(draft) {
    return ipcRenderer.invoke(CHANNELS.settingsUpdate, draft || {});
  },
  pickAgentsRoot() {
    return ipcRenderer.invoke(CHANNELS.settingsPickAgentsRoot);
  },
  onSettingsChanged(listener) {
    return subscribe(CHANNELS.settingsChanged, listener);
  },
  // "Clauding → Settings…" in the menu bar asking for the settings popover.
  onShowSettings(listener) {
    return subscribe(CHANNELS.settingsShow, listener);
  },
  // Every skill in the skills folder: name and description from the
  // frontmatter of each <name>/SKILL.md. Read from disk on every call.
  listSkills() {
    return ipcRenderer.invoke(CHANNELS.skillsList);
  },
  // The Skills item in the macOS menu bar asking for the popover.
  onShowSkills(listener) {
    return subscribe(CHANNELS.skillsShow, listener);
  },
  // One skill picked in the macOS Skills menu: the window reads it in the
  // middle column, exactly as a click in the popover does.
  onReadSkill(listener) {
    return subscribe(CHANNELS.skillsRead, listener);
  },
  // "Scan for skills…": every skill-looking folder on this Mac, grouped by
  // where it was found. Nothing is copied by the scan itself.
  scanForSkills(options) {
    return ipcRenderer.invoke(CHANNELS.skillsScan, options || {});
  },
  // Copies the picked candidates into the main skills folder. A folder that
  // is already there is only replaced when `overwrite` says so.
  addScannedSkills(candidates, overwrite) {
    return ipcRenderer.invoke(CHANNELS.skillsScanAdd, { candidates, overwrite: Boolean(overwrite) });
  },
  // "Add another place…": one more folder for the scan to look through,
  // remembered in settings.json.
  addSkillScanRoot() {
    return ipcRenderer.invoke(CHANNELS.skillsScanAddRoot);
  },
  // The answer to the first-run question about the built-in skill-maker
  // skill. The question itself is `askAboutBuiltinSkill` in the settings.
  answerBuiltinSkill(install) {
    return ipcRenderer.invoke(CHANNELS.skillsSeedAnswer, { install: Boolean(install) });
  },
  getSystemLanguage() {
    return ipcRenderer.invoke(CHANNELS.systemLanguage);
  },
  // The macOS emoji panel (⌃⌘Space). It types into whatever has focus, so
  // the caller focuses its field first. Answers { supported, opened }.
  showEmojiPanel() {
    return ipcRenderer.invoke(CHANNELS.systemEmojiPanel);
  },
  // "Reveal in Finder" for a folder or a file.
  revealInFinder(target) {
    return ipcRenderer.invoke(CHANNELS.systemReveal, { target });
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
  // Hangs one terminal up. The only thing that asks for this is "restart
  // this terminal so it loads the agent definition"; nothing else closes a
  // terminal by hand.
  closeTerminal(terminalId) {
    return ipcRenderer.invoke(CHANNELS.terminalClose, { terminalId });
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
  // The search-results tab of "Find in conversation…": one per session,
  // replaced by the next query.
  openPanelSearchTab(sessionKey, query) {
    return ipcRenderer.invoke(CHANNELS.panelOpenSearch, { sessionKey, query });
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
