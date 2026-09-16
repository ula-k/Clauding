// Every IPC channel name lives here so the main process and the preload
// script never disagree about spelling. CommonJS so the preload script
// (which runs through Electron's own loader) can require it too.
const CHANNELS = {
  sessionsList: "sessions:list",
  sessionsGet: "sessions:get",
  sessionsChanged: "sessions:changed",
  sessionsRename: "sessions:rename",
  sessionsDelete: "sessions:delete",
  groupsGet: "groups:get",
  groupsCreate: "groups:create",
  groupsRename: "groups:rename",
  groupsMove: "groups:move",
  groupsDelete: "groups:delete",
  groupsAssign: "groups:assign",
  groupsSetHidden: "groups:set-hidden",
  groupsSetCollapsed: "groups:set-collapsed",
  groupsChanged: "groups:changed",
  agentsGet: "agents:get",
  agentsAdd: "agents:add",
  agentsUpdate: "agents:update",
  agentsDelete: "agents:delete",
  agentsInspectFolder: "agents:inspect-folder",
  agentsInspectFile: "agents:inspect-file",
  agentsPickFolder: "agents:pick-folder",
  agentsLinkedSessions: "agents:linked-sessions",
  agentsChanged: "agents:changed",
  agentsAssignSession: "agents:assign-session",
  agentsRestoreBuiltin: "agents:restore-builtin",
  // A definition folder that appeared under the agents root: the app offers
  // to add it as an agent.
  agentsDefinitionFound: "agents:definition-found",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsPickAgentsRoot: "settings:pick-agents-root",
  settingsChanged: "settings:changed",
  // The Settings… item in the macOS menu bar asking for the settings popover.
  settingsShow: "settings:show",
  skillsList: "skills:list",
  // The native Skills menu asking the window to open the skills popover.
  skillsShow: "skills:show",
  // The native Skills menu asking the window to read one skill in the
  // middle column, the same thing a click in the popover does.
  skillsRead: "skills:read",
  // "Scan for skills…": look through the Mac for skill folders, then copy
  // the picked ones into the main skills folder.
  skillsScan: "skills:scan",
  skillsScanAdd: "skills:scan-add",
  skillsScanAddRoot: "skills:scan-add-root",
  // The answer to the first-run question about the built-in skill-maker.
  // The question itself rides along in the settings (askAboutBuiltinSkill).
  skillsSeedAnswer: "skills:seed-answer",
  systemLanguage: "system:language",
  systemEmojiPanel: "system:emoji-panel",
  systemReveal: "system:reveal",
  projectsRecent: "projects:recent",
  projectsPick: "projects:pick",
  terminalOpen: "terminal:open",
  terminalInput: "terminal:input",
  terminalResize: "terminal:resize",
  terminalList: "terminal:list",
  terminalReplay: "terminal:replay",
  terminalClose: "terminal:close",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  terminalChanged: "terminal:changed",
  smokeCommand: "smoke:command",
  panelGet: "panel:get",
  panelOpen: "panel:open",
  panelClose: "panel:close",
  panelActivate: "panel:activate",
  panelSetTitle: "panel:set-title",
  panelSetVisible: "panel:set-visible",
  panelChanged: "panel:changed",
  panelCommand: "panel:command",
  panelSelection: "panel:selection",
  panelReadFile: "panel:read-file",
  panelWatchFile: "panel:watch-file",
  panelUnwatchFile: "panel:unwatch-file",
  panelFileChanged: "panel:file-changed",
  panelOpenExternal: "panel:open-external"
};

module.exports = { CHANNELS };
