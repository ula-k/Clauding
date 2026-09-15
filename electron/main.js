import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import channels from "./channels.cjs";
import {
  listSessionsPage,
  getSession,
  enrichSession,
  isScratchWorkingDirectory,
  renameSessionTitle,
  DEFAULT_PAGE_SIZE
} from "./sessions.js";
import { watchLiveStatus, collectLiveStatus, STATUS_GROUPS } from "./liveStatus.js";
import { ensureShellPath } from "./claudeCli.js";
import { createTerminalRegistry } from "./terminals.js";
import { listRecentProjects } from "./recentProjects.js";
import { runTerminalSmoke } from "./smokeTerminal.js";
import { runPreambleSmoke } from "./smokePreamble.js";
import { runResizeSmoke } from "./smokeResize.js";
import { runGroupsSmoke } from "./smokeGroups.js";
import { runForkSmoke } from "./smokeFork.js";
import { runCollapseSmoke } from "./smokeCollapse.js";
import { runAgentsSmoke } from "./smokeAgents.js";
import { runEmojiSmoke } from "./smokeEmoji.js";
import { createSessionGroupStore } from "./sessionGroups.js";
import { createAgentStore, inspectDefinitionFolder, inspectDefinitionFile } from "./agents.js";
import { createSettingsStore } from "./settings.js";
import { listSkills } from "./skills.js";
import { builtinAgentDraft, seedBuiltins } from "./builtins.js";
import { createPanelTabStore, describeTarget } from "./panelTabs.js";
import { createCommandRequestHandler } from "./lib/commandRequests.js";
import { startCommandSocket } from "./commandSocket.js";
import { readPreamble, refreshStoredPreamble } from "./preamble.js";
import { createFileWatchRegistry } from "./fileWatch.js";

// A GUI-launched app inherits a minimal PATH; the Claude CLI and the tools it
// runs need ~/.local/bin, Homebrew and /usr/local/bin like in a terminal.
ensureShellPath();

const { CHANNELS } = channels;
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentServerUrl = process.env.VITE_DEV_SERVER_URL || null;
const screenshotPath = process.env.CLAUDING_SCREENSHOT || null;
const applicationIconPath = path.join(currentDirectory, "..", "build", "icon", "icon-1024.png");
const commandDirectory = path.join(currentDirectory, "..", "bin");

// The app runs from the project folder through Electron's own binary, so the
// name and the Dock icon are set here instead of coming from a packaged bundle.
app.setName("Clauding");

// Only one Clauding at a time: a second launch just brings the first window up.
// (Two instances reading the session list at once were observed to stall.)
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}
app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});
const screenshotSelect = process.env.CLAUDING_SCREENSHOT_SELECT || null;
const smokeTerminalMode = process.env.CLAUDING_SMOKE_TERMINAL === "1";
const smokeGroupsMode = process.env.CLAUDING_SMOKE_GROUPS === "1";
const smokeForkMode = process.env.CLAUDING_SMOKE_FORK === "1";
const smokeCollapseMode = process.env.CLAUDING_SMOKE_COLLAPSE === "1";
const smokePreambleMode = process.env.CLAUDING_SMOKE_PREAMBLE === "1";
const smokeResizeMode = process.env.CLAUDING_SMOKE_RESIZE === "1";
const smokeAgentsMode = process.env.CLAUDING_SMOKE_AGENTS === "1";
const smokeEmojiMode = process.env.CLAUDING_SMOKE_EMOJI === "1";

let mainWindow = null;
let stopWatchingLiveStatus = null;
let stopWatchingProjects = null;
let stopCommandSocket = null;
let panelTabs = null;
let sessionGroups = null;
let agents = null;
let settings = null;
let stopWatchingAgentsRoot = null;
// ~/Library/Application Support/Clauding: panel-tabs.json, groups.json,
// agents.json, preamble.md, clauding.sock, prompts/
const userDataDirectory = app.getPath("userData");
const preamblePath = path.join(userDataDirectory, "preamble.md");
// The socket the `clauding` command talks to. It lives in this app's own
// user-data folder, and the path is exported so every terminal's `clauding`
// reaches *this* app — an instance started with its own --user-data-dir (the
// automated tests) then never talks to the installed one.
const commandSocketPath = path.join(userDataDirectory, "clauding.sock");
process.env.CLAUDING_SOCKET = commandSocketPath;
// One file per terminal running as an agent, holding the preamble plus that
// agent's whole definition; written at spawn, deleted when the pty exits.
const promptDirectory = path.join(userDataDirectory, "prompts");

// A pty killed on quit never runs its exit handler, so a prompt file can
// outlive the app. They are all thrown away at the next start — no terminal
// exists yet at that point, so nothing can still be using one.
function clearStalePromptFiles() {
  try {
    fs.rmSync(promptDirectory, { recursive: true, force: true });
  } catch (error) {
    console.log(`[agents] could not clear ${promptDirectory}: ${error.message}`);
  }
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const terminalRegistry = createTerminalRegistry({
  sendToWindow,
  onChange() {
    // A terminal linking to a session (or leaving) changes ownership in the list.
    linkTerminalsToAgents();
    syncHiddenWithLiveStatus();
    forgetLinkedSessions();
    sendToWindow(CHANNELS.sessionsChanged, { reason: "terminals" });
    // Tabs opened before the CLI registered its session move to the session id.
    if (panelTabs) {
      for (const terminal of terminalRegistry.list()) {
        if (terminal.sessionId) {
          panelTabs.migrate(`terminal:${terminal.terminalId}`, terminal.sessionId);
        }
      }
    }
  },
  log(line) {
    console.log(line);
  },
  readPreamble() {
    return readPreamble(preamblePath);
  },
  commandDirectory,
  resolveAgent(agentId) {
    return agents ? agents.agentById(agentId) : null;
  },
  promptDirectory
});

// A terminal started with an agent records the link the moment its CLI
// registers a session id, so the row keeps the agent's badge for good — long
// after that terminal is gone.
function linkTerminalsToAgents() {
  if (!agents) {
    return;
  }
  for (const terminal of terminalRegistry.list()) {
    if (terminal.agentId && terminal.sessionId) {
      agents.linkSession(terminal.sessionId, terminal.agentId);
    }
  }
}

const panelFileWatchers = createFileWatchRegistry((filePath) => {
  sendToWindow(CHANNELS.panelFileChanged, { filePath });
});

// What the renderer last reported as the session on screen: the terminal of
// the selected pane (if it has one) and the tab-set key the panel is drawing.
// A `clauding` command whose own terminal id is missing or stale lands here.
let panelSelection = { terminalId: null, sessionKey: null };

// The request handling itself (which tab set a command goes to, the exact
// reply lines) lives in lib/commandRequests.js, so it can be exercised
// against a fake app in test/commandProtocol.test.js.
const commandRequests = createCommandRequestHandler({
  terminals: terminalRegistry,
  panelTabs: {
    open(sessionKey, description, options) {
      return panelTabs.open(sessionKey, description, options);
    },
    get(sessionKey) {
      return panelTabs.get(sessionKey);
    },
    setVisible(sessionKey, visible) {
      return panelTabs.setVisible(sessionKey, visible);
    }
  },
  describeTarget,
  readPanelSelection() {
    return panelSelection;
  },
  onPanelCommand(notice) {
    sendToWindow(CHANNELS.panelCommand, notice);
  },
  log(line) {
    console.log(line);
  }
});

const openPanelTab = commandRequests.openPanelTab;
const handleCommandRequest = commandRequests.handleCommandRequest;

// A session the user hid comes back the moment the CLI registry shows it busy
// again (or one of our own terminals picks it up): hiding is for a list that
// got too long, not a way to lose a session that is doing something.
function syncHiddenWithLiveStatus() {
  if (!sessionGroups) {
    return;
  }
  const runningSessionIds = new Set();
  for (const [sessionId, status] of collectLiveStatus()) {
    if (status.group === STATUS_GROUPS.running) {
      runningSessionIds.add(sessionId);
    }
  }
  for (const sessionId of terminalRegistry.ownedStates().keys()) {
    runningSessionIds.add(sessionId);
  }
  sessionGroups.unhideRunning(runningSessionIds);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#1b171f",
    show: false,
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The right panel renders pages in <webview> elements (see README).
      webviewTag: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Mirror renderer console output into the terminal so problems are visible
  // without opening devtools.
  mainWindow.webContents.on("console-message", (event, level, message) => {
    const levelName = ["debug", "log", "warn", "error"][level] || "log";
    console.log(`[renderer:${levelName}] ${message}`);
  });

  if (developmentServerUrl) {
    mainWindow.loadURL(developmentServerUrl);
  } else {
    mainWindow.loadFile(path.join(currentDirectory, "..", "dist", "renderer", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (screenshotPath) {
    mainWindow.webContents.once("did-finish-load", () => {
      captureScreenshotAndQuit();
    });
  } else if (smokeGroupsMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runGroupsSmoke({
        window: mainWindow,
        sessionGroups,
        listSessions() {
          return listSessionsPage({ offset: 0, limit: 200, ownedStates: terminalRegistry.ownedStates() });
        },
        syncHiddenWithLiveStatus,
        quit() {
          app.quit();
        }
      });
    });
  } else if (smokeAgentsMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runAgentsSmoke({
        window: mainWindow,
        registry: terminalRegistry,
        agents,
        sendCommand(command) {
          sendToWindow(CHANNELS.smokeCommand, command);
        },
        quit() {
          app.quit();
        }
      });
    });
  } else if (smokeEmojiMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runEmojiSmoke({
        window: mainWindow,
        quit() {
          app.quit();
        }
      });
    });
  } else if (smokeCollapseMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runCollapseSmoke({
        window: mainWindow,
        sessionGroups,
        listSessions() {
          return listSessionsPage({ offset: 0, limit: 200, ownedStates: terminalRegistry.ownedStates() });
        },
        quit() {
          app.quit();
        }
      });
    });
  } else if (smokeForkMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runForkSmoke({
        window: mainWindow,
        registry: terminalRegistry,
        sessionGroups,
        sendCommand(command) {
          sendToWindow(CHANNELS.smokeCommand, command);
        },
        quit() {
          app.quit();
        }
      });
    });
  } else if (smokeResizeMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runResizeSmoke({
        window: mainWindow,
        panelTabs,
        quit() {
          app.quit();
        }
      });
    });
  } else if (smokePreambleMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runPreambleSmoke({
        window: mainWindow,
        registry: terminalRegistry,
        panelTabs,
        commandDirectory,
        sendCommand(command) {
          sendToWindow(CHANNELS.smokeCommand, command);
        },
        quit() {
          app.quit();
        }
      });
    });
  } else if (smokeTerminalMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runTerminalSmoke({
        window: mainWindow,
        registry: terminalRegistry,
        panelTabs,
        commandDirectory,
        sendCommand(command) {
          sendToWindow(CHANNELS.smokeCommand, command);
        },
        quit() {
          app.quit();
        }
      });
    });
  }
}

// CLAUDING_SCREENSHOT=/path/out.png: capture the window after ~4 s and quit.
//   CLAUDING_SCREENSHOT_SELECT=elsewhere   click the first row whose session
//       runs in a terminal or job outside the app (the only click that is
//       guaranteed NOT to spawn a `claude` process, see README)
//   CLAUDING_SCREENSHOT_NEW=1              open the "+ New" sheet first
//   CLAUDING_SCREENSHOT_CLICK=a>>b         click these selectors, in order,
//       before the capture (a sheet, a tab, a menu item)
async function captureScreenshotAndQuit() {
  const waitMilliseconds = 4000;
  await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
  if (screenshotSelect === "elsewhere" && mainWindow) {
    await mainWindow.webContents.executeJavaScript(
      '(() => { const row = document.querySelector(\'[data-session-row][data-running-elsewhere="1"]\'); if (row) { row.click(); } return Boolean(row); })()'
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // CLAUDING_SCREENSHOT_CLICK: CSS selectors to click before the capture,
  // separated by ">>" and clicked in order, so any sheet or menu can be put
  // on screen without a smoke run of its own.
  const clickSelectors = (process.env.CLAUDING_SCREENSHOT_CLICK || "").split(">>").filter(Boolean);
  for (const selector of clickSelectors) {
    if (!mainWindow) {
      break;
    }
    const clicked = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
          .find((node) => node.offsetParent !== null) || document.querySelector(${JSON.stringify(selector)});
        if (target) { target.click(); }
        return Boolean(target);
      })()`
    );
    console.log(`[screenshot] clicked ${selector}: ${clicked}`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  if (process.env.CLAUDING_SCREENSHOT_NEW === "1" && mainWindow) {
    await mainWindow.webContents.executeJavaScript(
      '(() => { const button = document.querySelector("[data-new-button]"); if (button) { button.click(); } return Boolean(button); })()'
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  if (mainWindow) {
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG());
    console.log(`Screenshot written to ${screenshotPath}`);
  }
  app.quit();
}

// The Skills menu in the macOS menu bar. It is built from the skills folder
// itself, so it says what is actually installed; picking a skill opens its
// SKILL.md in the side panel of the session on screen, exactly like the
// Skills popover in the window does. Rebuilt whenever the list might have
// changed (a settings change, the popover asking for the list), because a
// native menu cannot be filled while it is already open.
function skillsMenuTemplate() {
  const skillsRoot = settings ? settings.get().skillsRoot : null;
  const skills = skillsRoot ? listSkills(skillsRoot) : [];
  const items = [
    {
      label: "Show skills…",
      click() {
        sendToWindow(CHANNELS.skillsShow, {});
      }
    },
    { type: "separator" }
  ];
  if (skills.length === 0) {
    items.push({ label: "No skills in this folder", enabled: false });
  }
  for (const skill of skills) {
    items.push({
      label: skill.name,
      click() {
        try {
          openPanelTab({ sessionKey: panelSelection.sessionKey, target: skill.filePath });
        } catch (error) {
          console.log(`[skills] could not open ${skill.filePath}: ${error.message}`);
        }
      }
    });
  }
  items.push({ type: "separator" });
  items.push({
    label: "Reveal skills folder in Finder",
    enabled: Boolean(skillsRoot),
    click() {
      if (skillsRoot) {
        shell.showItemInFolder(skillsRoot);
      }
    }
  });
  return { label: "Skills", submenu: items };
}

// The Edit roles are what make Cmd+C / Cmd+V work inside the terminal:
// Electron turns them into copy / paste events on xterm's hidden textarea.
function installApplicationMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" }
        ]
      },
      skillsMenuTemplate(),
      { role: "viewMenu" },
      { role: "windowMenu" }
    ])
  );
}

// Definition folders under the agents root that the app has already seen.
// Only a folder that turns up *after* the app started is announced: a folder
// the user never turned into an agent should not nag them at every launch.
let knownDefinitionFolders = new Set();

function scanAgentsRoot({ announce }) {
  if (!settings || !agents) {
    return;
  }
  const agentsRoot = settings.get().agentsRoot;
  let entries = [];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch (error) {
    return;
  }
  const alreadyAgents = new Set(agents.get().agents.map((agent) => agent.definitionFolder));
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const folderPath = path.join(agentsRoot, entry.name);
    if (knownDefinitionFolders.has(folderPath)) {
      continue;
    }
    const inspection = inspectDefinitionFolder(folderPath);
    if (!inspection.definitionFile) {
      continue;
    }
    knownDefinitionFolders.add(folderPath);
    if (alreadyAgents.has(folderPath) || !announce) {
      continue;
    }
    console.log(`[agents] a new definition appeared: ${inspection.definitionFile}`);
    sendToWindow(CHANNELS.agentsDefinitionFound, inspection);
  }
}

// The agents root is watched so the definition the Agent Maker just wrote
// can be offered as an agent with one click, without the user hunting for
// the folder.
function watchAgentsRoot() {
  if (stopWatchingAgentsRoot) {
    stopWatchingAgentsRoot();
    stopWatchingAgentsRoot = null;
  }
  if (!settings) {
    return;
  }
  const agentsRoot = settings.ensureAgentsRoot();
  knownDefinitionFolders = new Set();
  scanAgentsRoot({ announce: false });
  let debounceTimer = null;
  let watcher = null;
  try {
    watcher = fs.watch(agentsRoot, { persistent: false }, () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        scanAgentsRoot({ announce: true });
      }, 500);
    });
    watcher.on("error", () => {});
  } catch (error) {
    console.log(`[agents] could not watch ${agentsRoot}: ${error.message}`);
    return;
  }
  stopWatchingAgentsRoot = function stopWatching() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
}

// Every session agents.json links to an agent, read by id.
//
// The Agents tab cannot build its sub-rows from the Sessions list alone: that
// list is one page (60 rows by default), so an agent's older sessions would
// simply be missing under it. These are looked up one id at a time instead,
// and kept in a small cache that is emptied whenever the sessions change —
// reading the same ids from disk on every redraw would be wasteful.
//
// A link whose session is not on disk is skipped. That is normal: a terminal
// closed before its first message leaves a link but no transcript, because
// the CLI only writes one once there is something to write. The link itself
// is left alone — it costs nothing and does no harm.
let linkedSessionCache = new Map();

function forgetLinkedSessions() {
  linkedSessionCache = new Map();
}

async function collectLinkedAgentSessions() {
  if (!agents) {
    return [];
  }
  const ownedStates = terminalRegistry.ownedStates();
  const statusBySession = collectLiveStatus();
  const sessionIds = Object.keys(agents.get().sessionAgents || {});
  const found = [];
  for (const sessionId of sessionIds) {
    if (!linkedSessionCache.has(sessionId)) {
      let session = null;
      try {
        session = await getSession(sessionId, ownedStates);
      } catch (error) {
        // A missing or unreadable transcript is not an error worth raising:
        // the link is simply not shown.
        session = null;
      }
      linkedSessionCache.set(sessionId, session);
    }
    const cached = linkedSessionCache.get(sessionId);
    if (!cached || isScratchWorkingDirectory(cached.workingDirectory)) {
      continue;
    }
    // The cached row was read earlier; the live status and the ownership are
    // the parts that go stale, so the row is enriched again from them.
    found.push(
      enrichSession(
        {
          sessionId: cached.sessionId,
          customTitle: cached.customTitle,
          summary: cached.summary,
          firstPrompt: cached.firstPrompt,
          cwd: cached.workingDirectory,
          gitBranch: cached.gitBranch,
          lastModified: cached.lastModified,
          createdAt: cached.createdAt,
          fileSize: cached.fileSize,
          tag: cached.tag
        },
        statusBySession,
        ownedStates
      )
    );
  }
  return found;
}

function registerIpc() {
  ipcMain.handle(CHANNELS.sessionsList, async (event, options) => {
    const offset = Number(options && options.offset) || 0;
    const limit = Number(options && options.limit) || DEFAULT_PAGE_SIZE;
    return listSessionsPage({ offset, limit, ownedStates: terminalRegistry.ownedStates() });
  });

  ipcMain.handle(CHANNELS.sessionsGet, async (event, { sessionId }) => {
    return getSession(sessionId, terminalRegistry.ownedStates());
  });

  ipcMain.handle(CHANNELS.sessionsRename, async (event, { sessionId, title }) => {
    return renameSessionTitle(sessionId, title);
  });

  ipcMain.handle(CHANNELS.projectsRecent, async () => {
    return listRecentProjects();
  });

  ipcMain.handle(CHANNELS.projectsPick, async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(CHANNELS.terminalOpen, async (event, request) => {
    const record = terminalRegistry.open(request || {});
    // "Pick the agent and it already knows where it works": the folder this
    // session started in is what the sheet offers next time.
    if (record.agentId) {
      agents.rememberWorkingDirectory(record.agentId, record.workingDirectory);
    }
    return record;
  });

  ipcMain.on(CHANNELS.terminalInput, (event, { terminalId, data }) => {
    terminalRegistry.write(terminalId, data);
  });

  ipcMain.on(CHANNELS.terminalResize, (event, { terminalId, columns, rows }) => {
    terminalRegistry.resize(terminalId, columns, rows);
  });

  ipcMain.handle(CHANNELS.terminalList, async () => {
    return terminalRegistry.list();
  });

  ipcMain.handle(CHANNELS.terminalReplay, async (event, { terminalId }) => {
    return terminalRegistry.replay(terminalId);
  });

  // Only "restart this terminal so it loads the agent definition" asks for
  // this: SIGHUP, and the renderer opens a new one with --resume.
  ipcMain.handle(CHANNELS.terminalClose, async (event, { terminalId }) => {
    return terminalRegistry.close(terminalId);
  });

  ipcMain.handle(CHANNELS.groupsGet, async () => {
    return sessionGroups.get();
  });

  ipcMain.handle(CHANNELS.groupsCreate, async (event, { name }) => {
    sessionGroups.createGroup(name);
    return sessionGroups.get();
  });

  ipcMain.handle(CHANNELS.groupsRename, async (event, { groupId, name }) => {
    return sessionGroups.renameGroup(groupId, name);
  });

  ipcMain.handle(CHANNELS.groupsMove, async (event, { groupId, direction }) => {
    return sessionGroups.moveGroup(groupId, direction);
  });

  ipcMain.handle(CHANNELS.groupsDelete, async (event, { groupId }) => {
    return sessionGroups.deleteGroup(groupId);
  });

  ipcMain.handle(CHANNELS.groupsAssign, async (event, { sessionId, groupId }) => {
    return sessionGroups.assignSession(sessionId, groupId);
  });

  ipcMain.handle(CHANNELS.groupsSetHidden, async (event, { sessionId, hidden }) => {
    return sessionGroups.setHidden(sessionId, Boolean(hidden));
  });

  ipcMain.handle(CHANNELS.groupsSetCollapsed, async (event, { groupId, collapsed }) => {
    return sessionGroups.setCollapsed(groupId, Boolean(collapsed));
  });

  ipcMain.handle(CHANNELS.agentsGet, async () => {
    return agents.get();
  });

  ipcMain.handle(CHANNELS.agentsLinkedSessions, async () => {
    return collectLinkedAgentSessions();
  });

  ipcMain.handle(CHANNELS.agentsAdd, async (event, draft) => {
    agents.addAgent(draft || {});
    return agents.get();
  });

  ipcMain.handle(CHANNELS.agentsUpdate, async (event, { agentId, draft }) => {
    return agents.updateAgent(agentId, draft || {});
  });

  ipcMain.handle(CHANNELS.agentsDelete, async (event, { agentId }) => {
    return agents.deleteAgent(agentId);
  });

  ipcMain.handle(CHANNELS.agentsInspectFolder, async (event, { definitionFolder }) => {
    return inspectDefinitionFolder(definitionFolder);
  });

  ipcMain.handle(CHANNELS.agentsInspectFile, async (event, { definitionFile }) => {
    return inspectDefinitionFile(definitionFile);
  });

  // "Assign to agent" — the way an old session is attached to an agent. A
  // session open in one of our terminals also tells that terminal, so the
  // periodic re-linking cannot undo the change and a restart of the
  // terminal picks the new definition up.
  ipcMain.handle(CHANNELS.agentsAssignSession, async (event, { sessionId, agentId }) => {
    agents.setSessionAgent(sessionId, agentId || null);
    for (const terminal of terminalRegistry.list()) {
      if (terminal.sessionId === sessionId) {
        terminalRegistry.setAgent(terminal.terminalId, agentId || null);
      }
    }
    forgetLinkedSessions();
    return agents.get();
  });

  // "Restore built-in": the Agent Maker goes back to the name, emoji,
  // colour and definition the app ships with (and the built-in skill is
  // seeded again if it is missing).
  ipcMain.handle(CHANNELS.agentsRestoreBuiltin, async () => {
    agents.ensureBuiltinAgent(builtinAgentDraft(), { force: true });
    seedBuiltins({ agentStore: agents, skillsRoot: settings.get().skillsRoot, log: (line) => console.log(line) });
    installApplicationMenu();
    return agents.get();
  });

  ipcMain.handle(CHANNELS.settingsGet, async () => {
    return settings.get();
  });

  ipcMain.handle(CHANNELS.settingsUpdate, async (event, draft) => {
    return settings.update(draft || {});
  });

  ipcMain.handle(CHANNELS.settingsPickAgentsRoot, async () => {
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    if (picked.canceled || picked.filePaths.length === 0) {
      return settings.get();
    }
    return settings.update({ agentsRoot: picked.filePaths[0] });
  });

  // The Skills popover. The folder is read every time it is opened: a
  // session can write a skill at any moment, and the list is short.
  ipcMain.handle(CHANNELS.skillsList, async () => {
    const skillsRoot = settings.get().skillsRoot;
    const skills = listSkills(skillsRoot);
    // The native Skills menu says the same thing, so it is refreshed here
    // rather than on a timer.
    installApplicationMenu();
    return { skillsRoot, skills };
  });

  ipcMain.handle(CHANNELS.agentsPickFolder, async () => {
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (picked.canceled || picked.filePaths.length === 0) {
      return null;
    }
    return inspectDefinitionFolder(picked.filePaths[0]);
  });

  ipcMain.handle(CHANNELS.systemLanguage, async () => {
    return app.getLocale();
  });

  // The macOS character palette, the same one ⌃⌘Space opens. It inserts into
  // whatever element has focus, so the renderer focuses the emoji field
  // before asking for it. Nothing happens on a system that has no panel.
  // "Reveal in Finder" under the Skills popover and the settings menu.
  ipcMain.handle(CHANNELS.systemReveal, async (event, { target }) => {
    const wanted = String(target || "").trim();
    if (!wanted || !fs.existsSync(wanted)) {
      return { revealed: false };
    }
    shell.showItemInFolder(wanted);
    return { revealed: true };
  });

  ipcMain.handle(CHANNELS.systemEmojiPanel, async () => {
    const supported = typeof app.isEmojiPanelSupported === "function" && app.isEmojiPanelSupported();
    if (!supported || typeof app.showEmojiPanel !== "function") {
      return { supported: false, opened: false };
    }
    try {
      app.showEmojiPanel();
      return { supported: true, opened: true };
    } catch (error) {
      console.log(`[emoji] could not open the panel: ${error.message}`);
      return { supported: true, opened: false };
    }
  });

  // The renderer tells the main process which pane is on screen (see
  // resolveCommandTarget); a terminal reported this way also counts as focused.
  ipcMain.on(CHANNELS.panelSelection, (event, selection) => {
    const terminalId = selection && selection.terminalId ? String(selection.terminalId) : null;
    const sessionKey = selection && selection.sessionKey ? String(selection.sessionKey) : null;
    panelSelection = { terminalId, sessionKey };
    if (terminalId) {
      terminalRegistry.markFocused(terminalId);
    }
  });

  ipcMain.handle(CHANNELS.panelGet, async (event, { sessionKey }) => {
    return panelTabs.get(sessionKey);
  });

  ipcMain.handle(CHANNELS.panelOpen, async (event, request) => {
    return openPanelTab(request || {});
  });

  ipcMain.handle(CHANNELS.panelClose, async (event, { sessionKey, tabId }) => {
    panelTabs.close(sessionKey, tabId);
    return panelTabs.get(sessionKey);
  });

  ipcMain.handle(CHANNELS.panelActivate, async (event, { sessionKey, tabId }) => {
    panelTabs.activate(sessionKey, tabId);
    return panelTabs.get(sessionKey);
  });

  ipcMain.handle(CHANNELS.panelSetTitle, async (event, { sessionKey, tabId, title }) => {
    panelTabs.setTitle(sessionKey, tabId, String(title || "").slice(0, 200));
    return panelTabs.get(sessionKey);
  });

  ipcMain.handle(CHANNELS.panelSetVisible, async (event, { sessionKey, visible }) => {
    panelTabs.setVisible(sessionKey, visible);
    return panelTabs.get(sessionKey);
  });

  ipcMain.handle(CHANNELS.panelReadFile, async (event, { filePath }) => {
    return fs.promises.readFile(filePath, "utf8");
  });

  ipcMain.handle(CHANNELS.panelWatchFile, async (event, { filePath }) => {
    panelFileWatchers.watch(filePath);
    return { watching: true };
  });

  ipcMain.handle(CHANNELS.panelUnwatchFile, async (event, { filePath }) => {
    panelFileWatchers.unwatch(filePath);
    return { watching: false };
  });

  // "Open in Chrome": URLs go to the default browser, files to their default app.
  ipcMain.handle(CHANNELS.panelOpenExternal, async (event, { target }) => {
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target);
      return { opened: true };
    }
    const problem = await shell.openPath(target);
    if (problem) {
      throw new Error(problem);
    }
    return { opened: true };
  });
}

// Every <webview> the renderer creates is locked down here: no preload, no
// Node, isolated and sandboxed, and only file:, http: and https: pages.
function lockDownWebviews() {
  app.on("web-contents-created", (event, contents) => {
    contents.on("will-attach-webview", (attachEvent, webPreferences, attachParameters) => {
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      if (!/^(file|https?):\/\//i.test(attachParameters.src || "")) {
        attachEvent.preventDefault();
      }
    });
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
          shell.openExternal(url);
        }
        return { action: "deny" };
      });
    }
  });
}

// New transcripts or appended messages change lastModified and titles, so the
// session list also refreshes when anything under ~/.claude/projects moves.
function watchProjectFolders(onChange) {
  const projectsDirectory = path.join(os.homedir(), ".claude", "projects");
  const watchers = [];
  let debounceTimer = null;
  function scheduleChange() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange();
    }, 1000);
  }
  function watchFolder(folderPath) {
    try {
      const watcher = fs.watch(folderPath, { persistent: false }, scheduleChange);
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch (error) {
      // Folder may not exist; ignore.
    }
  }
  watchFolder(projectsDirectory);
  let projectFolders = [];
  try {
    projectFolders = fs.readdirSync(projectsDirectory, { withFileTypes: true });
  } catch (error) {
    projectFolders = [];
  }
  for (const folder of projectFolders) {
    if (folder.isDirectory()) {
      watchFolder(path.join(projectsDirectory, folder.name));
    }
  }
  return function stopWatching() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}

app.whenReady().then(() => {
  if (app.dock && fs.existsSync(applicationIconPath)) {
    app.dock.setIcon(applicationIconPath);
  }
  fs.mkdirSync(userDataDirectory, { recursive: true });
  clearStalePromptFiles();
  // A preamble.md that is still one of our own old defaults is brought up to
  // date; one the user edited is left alone (a line in the log says so).
  refreshStoredPreamble(preamblePath, (line) => {
    console.log(line);
  });
  sessionGroups = createSessionGroupStore({
    storagePath: path.join(userDataDirectory, "groups.json"),
    onChange(state) {
      sendToWindow(CHANNELS.groupsChanged, state);
    },
    log(line) {
      console.log(line);
    }
  });
  agents = createAgentStore({
    storagePath: path.join(userDataDirectory, "agents.json"),
    onChange(state) {
      sendToWindow(CHANNELS.agentsChanged, state);
    },
    log(line) {
      console.log(line);
    }
  });
  settings = createSettingsStore({
    storagePath: path.join(userDataDirectory, "settings.json"),
    onChange(state) {
      sendToWindow(CHANNELS.settingsChanged, state);
      // A new agents root is a new folder to watch, and the Skills menu may
      // now be reading a different skills folder.
      watchAgentsRoot();
      installApplicationMenu();
    },
    log(line) {
      console.log(line);
    }
  });
  // The agent that makes agents and the skill that makes skills ship with
  // the app, so they exist for everyone: the Agent Maker goes into
  // agents.json as the first agent, skill-maker into the skills folder
  // Claude Code reads (a copy the user edited is never overwritten).
  seedBuiltins({ agentStore: agents, skillsRoot: settings.get().skillsRoot, log: (line) => console.log(line) });
  watchAgentsRoot();
  panelTabs = createPanelTabStore({
    storagePath: path.join(userDataDirectory, "panel-tabs.json"),
    onChange(change) {
      sendToWindow(CHANNELS.panelChanged, change);
    }
  });
  stopCommandSocket = startCommandSocket({
    socketPath: commandSocketPath,
    handleRequest: handleCommandRequest,
    log(line) {
      console.log(line);
    }
  });
  // The menu is built after the stores, because the Skills menu is filled
  // from the skills folder named in settings.json.
  installApplicationMenu();
  lockDownWebviews();
  registerIpc();
  createWindow();
  stopWatchingLiveStatus = watchLiveStatus(() => {
    // The registry file of a terminal's CLI changed: pick up the link / status first.
    terminalRegistry.refreshLinks();
    syncHiddenWithLiveStatus();
    forgetLinkedSessions();
    sendToWindow(CHANNELS.sessionsChanged, { reason: "live-status" });
  });
  stopWatchingProjects = watchProjectFolders(() => {
    forgetLinkedSessions();
    sendToWindow(CHANNELS.sessionsChanged, { reason: "transcripts" });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

// Every pty is hung up on quit so no `claude` process outlives the window.
app.on("before-quit", () => {
  terminalRegistry.closeAll();
  if (stopCommandSocket) {
    stopCommandSocket();
    stopCommandSocket = null;
  }
  panelFileWatchers.stopAll();
  if (stopWatchingLiveStatus) {
    stopWatchingLiveStatus();
  }
  if (stopWatchingProjects) {
    stopWatchingProjects();
  }
  if (stopWatchingAgentsRoot) {
    stopWatchingAgentsRoot();
    stopWatchingAgentsRoot = null;
  }
});
