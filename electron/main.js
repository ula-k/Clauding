import { app, BrowserWindow, Menu, desktopCapturer, dialog, ipcMain, screen, shell, systemPreferences } from "electron";
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
  deleteSessionTranscript,
  searchSessionTranscript,
  DEFAULT_PAGE_SIZE
} from "./sessions.js";
import { watchLiveStatus, collectLiveStatus, STATUS_GROUPS } from "./liveStatus.js";
import { ensureShellPath } from "./claudeCli.js";
import { claudeRegistryPaths, commandChannelPath, isMacOS } from "./lib/platformPaths.js";
import { applicationMenuTemplate } from "./lib/applicationMenu.js";
import { createTerminalRegistry } from "./terminals.js";
import { listRecentProjects } from "./recentProjects.js";
import { runTerminalSmoke } from "./smokeTerminal.js";
import { runPreambleSmoke } from "./smokePreamble.js";
import { runResizeSmoke } from "./smokeResize.js";
import { runGroupsSmoke } from "./smokeGroups.js";
import { runForkSmoke } from "./smokeFork.js";
import { runCollapseSmoke } from "./smokeCollapse.js";
import { runAgentsSmoke } from "./smokeAgents.js";
import { runAgentStartSmoke } from "./smokeAgentStart.js";
import { runFlagsSmoke } from "./smokeFlags.js";
import { runSessionFlagsSmoke } from "./smokeSessionFlags.js";
import {
  UPDATE_BY_HAND_ADVICE,
  projectRootFolder,
  quietCheckIsDue,
  readLastQuietCheck,
  readRemoteState,
  runUpdateSteps,
  updateMenuItemLabel,
  updatePlan,
  writeLastQuietCheck
} from "./updater.js";
import { openUpdateSheet } from "./updateSheet.js";
import { runAssignSmoke } from "./smokeAssign.js";
import { runEmojiSmoke } from "./smokeEmoji.js";
import { runKickoffSmoke } from "./smokeKickoff.js";
import { createSessionGroupStore } from "./sessionGroups.js";
import { createAgentStore, inspectDefinitionFolder, inspectDefinitionFile } from "./agents.js";
import { createSettingsStore } from "./settings.js";
import { createSessionFlagsStore } from "./sessionFlags.js";
import { listSkills } from "./skills.js";
import { copySkillCandidate, scanForSkillCandidates } from "./skillsScan.js";
import { builtinAgentDraft, seedBuiltinSkills, seedBuiltins } from "./builtins.js";
import { createPanelTabStore, describeTarget } from "./panelTabs.js";
import { createCommandRequestHandler } from "./lib/commandRequests.js";
import { startCommandSocket } from "./commandSocket.js";
import { readPreamble, refreshStoredPreamble } from "./preamble.js";
import { createFileWatchRegistry, watchFile } from "./fileWatch.js";

// A GUI-launched app inherits a minimal PATH; the Claude CLI and the tools it
// runs need ~/.local/bin, Homebrew and /usr/local/bin like in a terminal.
ensureShellPath();

const { CHANNELS } = channels;
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentServerUrl = process.env.VITE_DEV_SERVER_URL || null;
const screenshotPath = process.env.CLAUDING_SCREENSHOT || null;
const applicationIconPath = path.join(currentDirectory, "..", "build", "icon", "icon-1024.png");
const commandDirectory = path.join(currentDirectory, "..", "bin");

// The version of the checkout the app is running, for the About panel. The
// bundle in /Applications carries the same number in its property list, but
// only until the next `git pull`, and `npm start` has no bundle at all.
function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(currentDirectory, "..", "package.json"), "utf8")).version || "";
  } catch (error) {
    return "";
  }
}
const applicationVersion = readPackageVersion();

// The name and the Dock icon. In the bundle written by `npm run install-app`
// the property list already says Clauding; started with `npm start` there is
// no bundle at all, and this is the only thing that names the app.
app.setName("Clauding");

// The standard macOS About panel. Left alone it shows Electron's own name,
// version and atom icon, because it is drawn from the running bundle and
// `app.setName` does not reach it.
app.setAboutPanelOptions({
  applicationName: "Clauding",
  applicationVersion,
  version: "",
  credits: "A macOS desktop window around Claude Code sessions.\nMIT-licensed. Not affiliated with Anthropic.",
  iconPath: applicationIconPath
});

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
const screenshotAboutPanel = process.env.CLAUDING_SCREENSHOT_ABOUT === "1";
const screenshotTerminalFolder = process.env.CLAUDING_SCREENSHOT_TERMINAL || null;
// CLAUDING_SCREENSHOT_RESUME=<sessionId>: that terminal resumes this session
// instead of starting a new one, so it has a session id from the first
// moment — which is what anything hanging off a session needs (the header
// menu, "Assign to agent"). With CLAUDING_DRY_SPAWN=1 nothing is spawned,
// so the id may just as well be a made-up one.
const screenshotResumeSessionId = process.env.CLAUDING_SCREENSHOT_RESUME || null;
// CLAUDING_SCREENSHOT_AGENT=<agentId>: the terminal is opened as that agent,
// so the header carries its chip — the one thing in the header that changes
// width with the name in it.
const screenshotAgentId = process.env.CLAUDING_SCREENSHOT_AGENT || null;
// CLAUDING_SCREENSHOT_WIDTH / _HEIGHT: the window is opened this big instead
// of 1440x900, which is how a header is photographed at the widths it has to
// survive (1000 is the narrowest the window goes).
const screenshotWindowWidth = Number(process.env.CLAUDING_SCREENSHOT_WIDTH || 0);
const screenshotWindowHeight = Number(process.env.CLAUDING_SCREENSHOT_HEIGHT || 0);
const smokeTerminalMode = process.env.CLAUDING_SMOKE_TERMINAL === "1";
const smokeGroupsMode = process.env.CLAUDING_SMOKE_GROUPS === "1";
const smokeForkMode = process.env.CLAUDING_SMOKE_FORK === "1";
const smokeCollapseMode = process.env.CLAUDING_SMOKE_COLLAPSE === "1";
const smokePreambleMode = process.env.CLAUDING_SMOKE_PREAMBLE === "1";
const smokeResizeMode = process.env.CLAUDING_SMOKE_RESIZE === "1";
const smokeAgentsMode = process.env.CLAUDING_SMOKE_AGENTS === "1";
const smokeAssignMode = process.env.CLAUDING_SMOKE_ASSIGN === "1";
const smokeAgentStartMode = process.env.CLAUDING_SMOKE_AGENT_START === "1";
const smokeFlagsMode = process.env.CLAUDING_SMOKE_FLAGS === "1";
const smokeSessionFlagsMode = process.env.CLAUDING_SMOKE_SESSION_FLAGS === "1";
const smokeEmojiMode = process.env.CLAUDING_SMOKE_EMOJI === "1";
const smokeKickoffMode = process.env.CLAUDING_SMOKE_KICKOFF === "1";
// Any automation at all: the first-run questions stay out of its way.
const anySmokeMode =
  smokeTerminalMode ||
  smokeGroupsMode ||
  smokeForkMode ||
  smokeCollapseMode ||
  smokePreambleMode ||
  smokeResizeMode ||
  smokeAgentsMode ||
  smokeAssignMode ||
  smokeAgentStartMode ||
  smokeFlagsMode ||
  smokeSessionFlagsMode ||
  smokeEmojiMode ||
  smokeKickoffMode;

// The screenshot hook and the smoke runs drive the real window with things
// only macOS has — `capturePage` against an inset title bar, the standard
// About panel, the character palette, the /Applications bundle. They are dev
// tools, not features, so on any other system they say so and do nothing.
const developmentHooksSupported = isMacOS();

let mainWindow = null;
let stopWatchingLiveStatus = null;
let stopWatchingProjects = null;
let stopCommandSocket = null;
let panelTabs = null;
let sessionGroups = null;
let agents = null;
let settings = null;
let stopWatchingAgentsRoot = null;
// One watcher per store file in Application Support (see watchStoreFiles).
let stopWatchingStoreFiles = [];
// ~/Library/Application Support/Clauding: panel-tabs.json, groups.json,
// agents.json, preamble.md, clauding.sock, prompts/
const userDataDirectory = app.getPath("userData");
const preamblePath = path.join(userDataDirectory, "preamble.md");
// The socket the `clauding` command talks to. It lives in this app's own
// user-data folder, and the path is exported so every terminal's `clauding`
// reaches *this* app — an instance started with its own --user-data-dir (the
// automated tests) then never talks to the installed one.
// On Windows this is a named pipe rather than a file (see platformPaths.js);
// `net` connects to either, and the `clauding` command is told which through
// CLAUDING_SOCKET.
const commandSocketPath = commandChannelPath({
  userDataDirectory,
  userIdentifier: typeof process.getuid === "function" ? process.getuid() : null
});
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

// The only files this app writes under ~/.claude are its own built-in
// skills, and they are not written until the user has said yes. The window asks
// when the settings it reads say the question is still open — carried in the
// settings themselves rather than pushed, because a push sent while the
// renderer is still mounting reaches nobody. A screenshot or smoke run is
// never asked: it would photograph the sheet instead of the app.
function settingsForRenderer() {
  const current = settings.get();
  return {
    ...current,
    askAboutBuiltinSkill: current.skillMakerSeeding === "unanswered" && !screenshotPath && !anySmokeMode
  };
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// The per-session `claude` flags (session-flags.json). Built with the other
// stores at start-up; the registry reaches it through the three callbacks
// below, the same way it reaches the agents.
let sessionFlags = null;

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
  promptDirectory,
  readGlobalExtraArguments() {
    return settings ? settings.get().extraClaudeArguments : "";
  },
  readSessionExtraArguments(sessionId) {
    return sessionFlags ? sessionFlags.flagsFor(sessionId) : "";
  },
  rememberSessionExtraArguments(sessionId, flags) {
    if (sessionFlags) {
      sessionFlags.remember(sessionId, flags);
    }
  }
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
  // `clauding agent add|list`. The store itself is built later in the
  // start-up (it needs the user-data folder), so it is reached through these
  // two calls rather than handed in.
  agents: {
    list() {
      return agents ? agents.get().agents : [];
    },
    add(draft) {
      if (!agents) {
        throw new Error("this window has no agent list.");
      }
      const added = agents.addAgent(draft);
      installApplicationMenu();
      return added;
    }
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
// What every poll reports about the sessions that are alive right now:
// sessionId -> { busy, needsAnswer }. "Busy" is a session actually working,
// never a CLI merely sitting at its prompt — a hidden session must not come
// back into the list just for existing (it did, and hiding looked broken).
function collectSessionActivity() {
  const activity = new Map();
  for (const [sessionId, status] of collectLiveStatus()) {
    activity.set(sessionId, {
      busy: status.group === STATUS_GROUPS.running,
      needsAnswer: Boolean(status.needs) || status.rawStatus === "blocked"
    });
  }
  // One of our own terminals counts as busy only while it is working. An
  // idle pane is not an event, and hiding closes the pane anyway.
  for (const [sessionId, ownedState] of terminalRegistry.ownedStates()) {
    const previous = activity.get(sessionId) || { busy: false, needsAnswer: false };
    activity.set(sessionId, { ...previous, busy: previous.busy || ownedState.registryStatus === "busy" });
  }
  return activity;
}

function syncHiddenWithLiveStatus() {
  if (!sessionGroups) {
    return;
  }
  sessionGroups.unhideOnActivity(collectSessionActivity());
}

// Hide means "stop it and put it away": a session open in one of the app's
// terminals is hung up first (the conversation stays on disk, the row goes
// under "Hidden (N)"), and only then is it hidden. Without that it was
// still alive in the registry and the next poll pulled it straight back.
async function hideSession(sessionId) {
  let wasBusy = false;
  const activity = collectSessionActivity().get(sessionId) || null;
  for (const terminal of terminalRegistry.list()) {
    if (terminal.sessionId === sessionId && !terminal.exited) {
      console.log(`[groups] hiding ${sessionId}: closing its terminal ${terminal.terminalId} first`);
      await terminalRegistry.close(terminal.terminalId);
    }
  }
  if (activity && !terminalRegistry.ownedStates().has(sessionId)) {
    // A session running somewhere else is not ours to stop, so whether it
    // was busy decides when it may come back.
    wasBusy = activity.busy;
  }
  return sessionGroups.setHidden(sessionId, true, wasBusy);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: screenshotWindowWidth > 0 ? screenshotWindowWidth : 1440,
    height: screenshotWindowHeight > 0 ? screenshotWindowHeight : 900,
    minWidth: 1000,
    minHeight: 600,
    // The inset traffic lights are a macOS thing: they are what lets the app
    // put its own header where the title bar would be. Windows draws its own
    // caption buttons on the right and the menu bar inside the window, so
    // there the window keeps the standard frame.
    ...(isMacOS() ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } } : {}),
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

  if (!developmentHooksSupported && (anySmokeMode || screenshotPath)) {
    console.log(
      "[smoke] the screenshot and smoke hooks are macOS-only (they photograph the window and read the " +
        "macOS About panel); this run ignores them and leaves the window as it is."
    );
    return;
  }

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
  } else if (smokeAssignMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runAssignSmoke({
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
  } else if (smokeFlagsMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runFlagsSmoke({
        window: mainWindow,
        registry: terminalRegistry,
        settings,
        agents,
        sessionFlags,
        quit() {
          app.quit();
        }
      });
    });
  } else if (smokeSessionFlagsMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runSessionFlagsSmoke({
        window: mainWindow,
        registry: terminalRegistry,
        sessionFlags,
        sessionFlagsPath: path.join(userDataDirectory, "session-flags.json"),
        dryRun: process.env.CLAUDING_DRY_SPAWN === "1",
        sendCommand(command) {
          sendToWindow(CHANNELS.smokeCommand, command);
        },
        quit() {
          app.quit();
        }
      });
    });
  } else if (smokeAgentStartMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runAgentStartSmoke({
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
  } else if (smokeKickoffMode) {
    mainWindow.webContents.once("did-finish-load", () => {
      runKickoffSmoke({
        window: mainWindow,
        registry: terminalRegistry,
        settings,
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
//   CLAUDING_SCREENSHOT_TERMINAL=<folder>  open a terminal in that folder
//       first (a scratch folder, never a real project) so a picture can be
//       taken of anything that needs a live session
//   CLAUDING_SCREENSHOT_RESUME=<sessionId> that terminal resumes this session,
//       so it has a session id at once (with CLAUDING_DRY_SPAWN=1 the id can
//       be invented: nothing is spawned)
//   CLAUDING_SCREENSHOT_WAIT=<ms>          wait this much longer before the shutter
//   CLAUDING_SCREENSHOT_ABOUT=1            show the standard About panel and
//       photograph that instead of the window (see below: only possible with
//       macOS screen recording permission)
//   CLAUDING_SCREENSHOT_ABOUT_HOLD=<ms>    keep the About panel on screen this
//       much longer before quitting, so it can be read from outside
//   CLAUDING_SCREENSHOT_CLICK=a>>b         click these selectors, in order,
//       before the capture (a sheet, a tab, a menu item)
//   CLAUDING_SCREENSHOT_FIND=<word>        open "Find in conversation…" and
//       search for that word — the one view with no button to click, since
//       its entry points are the menu bar and ⌘F
async function captureScreenshotAndQuit() {
  // CLAUDING_SCREENSHOT_TERMINAL=<folder>: open a terminal in that folder
  // first, so a picture can be taken of something that needs a live session
  // (the reader over a running terminal) without a smoke run of its own and
  // without touching one of the user's real sessions.
  if (screenshotTerminalFolder && mainWindow) {
    try {
      const record = terminalRegistry.open({
        workingDirectory: screenshotTerminalFolder,
        resumeSessionId: screenshotResumeSessionId,
        agentId: screenshotAgentId,
        columns: 110,
        rows: 32
      });
      sendToWindow(CHANNELS.smokeCommand, { action: "show-terminal", terminalId: record.terminalId });
      console.log(`[screenshot] opened a terminal in ${screenshotTerminalFolder}`);
    } catch (error) {
      console.log(`[screenshot] could not open a terminal in ${screenshotTerminalFolder}: ${error.message}`);
    }
  }
  const waitMilliseconds = screenshotTerminalFolder ? 9000 : 4000;
  await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
  if (screenshotSelect === "elsewhere" && mainWindow) {
    await mainWindow.webContents.executeJavaScript(
      '(() => { const row = document.querySelector(\'[data-session-row][data-running-elsewhere="1"]\'); if (row) { row.click(); } return Boolean(row); })()'
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // CLAUDING_SCREENSHOT_FIND=<word>: the find bar has no button on purpose
  // (the entry points are ⌘F and the View menu), so the hook asks for it the
  // same way the menu item does and then types the word in and presses Enter.
  const findQuery = process.env.CLAUDING_SCREENSHOT_FIND || "";
  if (findQuery && mainWindow) {
    sendToWindow(CHANNELS.transcriptFindShow, {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    const typed = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const field = document.querySelector("[data-find-input]");
        if (!field) { return false; }
        const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        valueSetter.call(field, ${JSON.stringify(findQuery)});
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return true;
      })()`
    );
    console.log(`[screenshot] searched for ${findQuery}: ${typed}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
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
  // CLAUDING_SCREENSHOT_WAIT=<milliseconds>: a last pause before the shutter,
  // for a view that is still filling itself in (the skills scan reads folders).
  const extraWait = Number(process.env.CLAUDING_SCREENSHOT_WAIT || 0);
  if (extraWait > 0) {
    await new Promise((resolve) => setTimeout(resolve, extraWait));
  }
  if (screenshotAboutPanel) {
    await photographAboutPanel();
    app.quit();
    return;
  }
  if (mainWindow) {
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG());
    console.log(`Screenshot written to ${screenshotPath}`);
  }
  app.quit();
}

// CLAUDING_SCREENSHOT_ABOUT=1. The About panel is a window of the app, not
// page content, so `capturePage` cannot see it: the only way to a picture is
// a screen capture, and macOS gives that to an app the user has allowed under
// Privacy & Security → Screen Recording. Without the permission the panel is
// still put on screen and held there (CLAUDING_SCREENSHOT_ABOUT_HOLD), which
// is enough to read it by hand or with System Events.
async function photographAboutPanel() {
  // macOS does not offer a floating panel as a window to capture, so the
  // picture has to be of the whole display. The app's own window is stretched
  // over that display first: the shot then shows the menu bar, Clauding's
  // window and the panel on top of it, and nothing of whatever else the user
  // had open.
  const display = screen.getPrimaryDisplay();
  if (mainWindow) {
    mainWindow.setBounds(display.bounds);
    mainWindow.focus();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  app.showAboutPanel();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const screenAccess = systemPreferences.getMediaAccessStatus("screen");
  console.log(`[screenshot] About panel shown; screen recording permission: ${screenAccess}`);
  if (screenAccess === "granted" && screenshotPath) {
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor)
      }
    });
    console.log(`[screenshot] capturable: ${sources.map((source) => `${source.id} ${source.name}`).join(" | ")}`);
    const chosen =
      sources.find((source) => /about/i.test(source.name)) ||
      sources.find((source) => source.id.startsWith("screen:"));
    if (chosen) {
      fs.writeFileSync(screenshotPath, chosen.thumbnail.toPNG());
      console.log(`Screenshot written to ${screenshotPath} (${chosen.name})`);
    } else {
      console.log("[screenshot] nothing capturable held the About panel");
    }
  } else {
    console.log("[screenshot] no screen recording permission, so no picture of the About panel");
  }
  const holdMilliseconds = Number(process.env.CLAUDING_SCREENSHOT_ABOUT_HOLD || 0);
  if (holdMilliseconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
  }
}

// The Skills menu in the macOS menu bar. It is built from the skills folder
// itself, so it says what is actually installed; picking a skill opens its
// SKILL.md in the reader in the middle column, exactly like a click in the
// Skills popover does. Rebuilt whenever the list might have changed (a
// settings change, the popover asking for the list), because a native menu
// cannot be filled while it is already open.
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
        // The window reads it in the middle column: it needs no session and
        // no tab set, so this cannot fail silently the way a panel tab
        // could when nothing was selected.
        sendToWindow(CHANNELS.skillsRead, { name: skill.name, filePath: skill.filePath, folder: skill.folder });
      }
    });
  }
  items.push({ type: "separator" });
  items.push({
    label: "Scan for skills…",
    click() {
      sendToWindow(CHANNELS.skillsShow, { scan: true });
    }
  });
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

// "Check for new version…". The app runs from a git checkout, so the check
// is a read-only `git fetch` and a comparison with origin/main; the update
// is the four commands the user would type themselves. The quiet check at
// start-up changes nothing but the menu item's text.
let quietUpdatePlan = null;
let updateCheckRunning = false;

async function runUpdateNow() {
  const sheet = openUpdateSheet(mainWindow);
  const result = await runUpdateSteps({
    projectRoot: projectRootFolder(),
    onStep(stepName) {
      sheet.setStep(`Running ${stepName}…`);
    }
  });
  sheet.close();
  if (!result.ok) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      message: `The update stopped at ${result.failedStep}`,
      detail: result.details || "No output.",
      buttons: ["OK"]
    });
    return;
  }
  quietUpdatePlan = null;
  installApplicationMenu();
  const answer = await dialog.showMessageBox(mainWindow, {
    type: "info",
    message: "Clauding was updated.",
    detail:
      "Relaunching closes every terminal open in the app — the conversations themselves are kept " +
      "and can be resumed afterwards.",
    buttons: ["Relaunch now", "Later"],
    defaultId: 0,
    cancelId: 1
  });
  if (answer.response === 0) {
    app.relaunch();
    app.exit(0);
  }
}

async function checkForNewVersion({ quiet }) {
  if (updateCheckRunning) {
    return;
  }
  updateCheckRunning = true;
  try {
    const state = await readRemoteState(projectRootFolder());
    if (!state.ok) {
      console.log(`[update] the check did not run: ${state.reason}`);
      if (!quiet) {
        await dialog.showMessageBox(mainWindow, {
          type: "warning",
          message:
            state.reason === "notACheckout"
              ? "This copy of Clauding is not a git checkout, so it cannot check for a new version."
              : "Could not reach the repository.",
          detail: state.details || "",
          buttons: ["OK"]
        });
      }
      return;
    }
    const plan = updatePlan(state);
    console.log(
      `[update] ${plan.headline}${plan.updateAvailable ? ` (${plan.changeCount} commits, branch ${state.branch}, ` +
        `${state.clean ? "clean" : "local changes"})` : ""}`
    );
    quietUpdatePlan = plan.updateAvailable ? plan : null;
    installApplicationMenu();
    if (quiet) {
      return;
    }
    if (!plan.updateAvailable) {
      await dialog.showMessageBox(mainWindow, { type: "info", message: plan.headline, buttons: ["OK"] });
      return;
    }
    if (!plan.canUpdateInApp) {
      await dialog.showMessageBox(mainWindow, {
        type: "warning",
        message: plan.headline,
        detail: UPDATE_BY_HAND_ADVICE,
        buttons: ["OK"]
      });
      return;
    }
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "question",
      message: plan.headline,
      detail: plan.detail,
      buttons: ["Update", "Later"],
      defaultId: 0,
      cancelId: 1
    });
    if (answer.response === 0) {
      await runUpdateNow();
    }
  } finally {
    updateCheckRunning = false;
  }
}

// Once a day, and never while an automation is driving the window.
function checkForNewVersionQuietlyIfDue() {
  if (anySmokeMode || screenshotPath) {
    return;
  }
  if (!quietCheckIsDue(readLastQuietCheck(userDataDirectory))) {
    return;
  }
  writeLastQuietCheck(userDataDirectory);
  checkForNewVersion({ quiet: true });
}

// The Edit roles are what make Cmd+C / Cmd+V (Ctrl+C / Ctrl+V on Windows)
// work inside the terminal: Electron turns them into copy / paste events on
// xterm's hidden textarea. The template itself, and what differs between the
// two systems, lives in lib/applicationMenu.js.
function installApplicationMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate({
        applicationName: app.name,
        updateItemLabel: updateMenuItemLabel(quietUpdatePlan),
        skillsMenu: skillsMenuTemplate(),
        onCheckForUpdate() {
          checkForNewVersion({ quiet: false });
        },
        onShowSettings() {
          sendToWindow(CHANNELS.settingsShow, {});
        },
        findLabel: "Find in conversation…",
        onFindInConversation() {
          sendToWindow(CHANNELS.transcriptFindShow, {});
        }
      })
    )
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

// The three JSON files in Application Support the app keeps in memory are
// watched (debounced in fileWatch.js), so a change written by hand — or by
// a second window — is picked up without restarting the app. Each store
// compares what it reads with what it holds, so the echo of the app's own
// save is not mistaken for news.
function watchStoreFiles() {
  for (const stopWatching of stopWatchingStoreFiles) {
    stopWatching();
  }
  stopWatchingStoreFiles = [];
  const watched = [
    [path.join(userDataDirectory, "session-flags.json"), () => sessionFlags && sessionFlags.reloadFromDisk()],
    [path.join(userDataDirectory, "settings.json"), () => settings && settings.reloadFromDisk()],
    [path.join(userDataDirectory, "agents.json"), () => agents && agents.reloadFromDisk()]
  ];
  for (const [storagePath, reload] of watched) {
    stopWatchingStoreFiles.push(watchFile(storagePath, reload));
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

  // "Find in conversation…": the session's JSONL transcript read start to
  // finish and searched for the word the user typed. The file grows while
  // the session runs, so nothing is cached and nothing is watched — every
  // Enter (and the Refresh link in the results) reads it again.
  ipcMain.handle(CHANNELS.transcriptSearch, async (event, { sessionId, query }) => {
    return searchSessionTranscript(sessionId, query);
  });

  // "Delete session": the one destructive action in the app. The window has
  // already asked; here the terminal is hung up, the transcript is deleted
  // through the SDK, and every file of ours that still named that session
  // forgets it. A session running in a terminal outside the app is refused —
  // it is not ours to end (the menu item is disabled there too).
  ipcMain.handle(CHANNELS.sessionsDelete, async (event, { sessionId }) => {
    if (!sessionId) {
      return { sessionId, deleted: false, reason: "no-session" };
    }
    const ownedByApp = terminalRegistry.ownedStates().has(sessionId);
    const elsewhere = !ownedByApp && collectLiveStatus().has(sessionId);
    if (elsewhere) {
      return { sessionId, deleted: false, reason: "running-elsewhere" };
    }
    for (const terminal of terminalRegistry.list()) {
      if (terminal.sessionId === sessionId && !terminal.exited) {
        console.log(`[sessions] deleting ${sessionId}: closing its terminal ${terminal.terminalId} first`);
        terminalRegistry.close(terminal.terminalId);
      }
    }
    try {
      await deleteSessionTranscript(sessionId);
    } catch (error) {
      console.log(`[sessions] could not delete ${sessionId}: ${error.message}`);
      return { sessionId, deleted: false, reason: "failed", message: String(error.message || error) };
    }
    sessionGroups.forgetSession(sessionId);
    agents.forgetSession(sessionId);
    panelTabs.forgetSession(sessionId);
    forgetLinkedSessions();
    sendToWindow(CHANNELS.sessionsChanged, { reason: "deleted" });
    console.log(`[sessions] deleted ${sessionId} and everything the app remembered about it`);
    return { sessionId, deleted: true };
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
    if (hidden) {
      return hideSession(sessionId);
    }
    return sessionGroups.setHidden(sessionId, false);
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
  // colour and definition the app ships with (and the built-in skills are
  // seeded again if they are missing).
  ipcMain.handle(CHANNELS.agentsRestoreBuiltin, async () => {
    agents.ensureBuiltinAgent(builtinAgentDraft(), { force: true });
    // Asking for the built-ins back is itself a yes to the files under
    // ~/.claude, so the skills are written whatever the stored answer was.
    settings.update({ skillMakerSeeding: "installed" });
    seedBuiltins({ agentStore: agents, skillsRoot: settings.get().skillsRoot, log: (line) => console.log(line) });
    installApplicationMenu();
    return agents.get();
  });

  // The per-session `claude` flags behind "Extra claude flags…". Writing
  // them is all this does: whether the terminal on screen is restarted so
  // they take effect now is the renderer's decision (flagsChangePlan in
  // src/renderer/sessionFlagsPlan.js), and it does that by hanging the pty
  // up and resuming the same session — the store is read again there.
  ipcMain.handle(CHANNELS.sessionFlagsGet, async () => {
    return sessionFlags ? sessionFlags.get() : { sessionFlags: {} };
  });

  ipcMain.handle(CHANNELS.sessionFlagsSet, async (event, { sessionId, flags }) => {
    if (sessionFlags && sessionId) {
      sessionFlags.remember(sessionId, flags || "");
    }
    return sessionFlags ? sessionFlags.get() : { sessionFlags: {} };
  });

  ipcMain.handle(CHANNELS.settingsGet, async () => {
    return settingsForRenderer();
  });

  ipcMain.handle(CHANNELS.settingsUpdate, async (event, draft) => {
    settings.update(draft || {});
    return settingsForRenderer();
  });

  ipcMain.handle(CHANNELS.settingsPickAgentsRoot, async () => {
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    if (!picked.canceled && picked.filePaths.length > 0) {
      settings.update({ agentsRoot: picked.filePaths[0] });
    }
    return settingsForRenderer();
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

  // "Scan for skills…": every skill-looking folder on this Mac. The scan
  // only reports; nothing is copied until the user picks candidates and
  // presses Add.
  ipcMain.handle(CHANNELS.skillsScan, async () => {
    const current = settings.get();
    const found = scanForSkillCandidates({
      homeDirectory: os.homedir(),
      skillsRoot: current.skillsRoot,
      extraRoots: current.skillScanRoots
    });
    console.log(`[skills] scan found ${found.candidates.length} candidate(s) in ${found.sources.length} place(s)`);
    return { ...found, skillsRoot: current.skillsRoot, extraRoots: current.skillScanRoots };
  });

  // Copies the picked folders into the skills folder. An existing folder of
  // the same name is reported back rather than replaced, unless the window
  // asks again with overwrite after the user has confirmed.
  ipcMain.handle(CHANNELS.skillsScanAdd, async (event, { candidates, overwrite }) => {
    const skillsRoot = settings.get().skillsRoot;
    const results = [];
    for (const candidate of candidates || []) {
      try {
        results.push({ name: candidate.name, ...copySkillCandidate({ candidate, skillsRoot, overwrite }) });
      } catch (error) {
        console.log(`[skills] could not copy ${candidate.folder}: ${error.message}`);
        results.push({ name: candidate.name, copied: false, skipped: true, reason: error.message });
      }
    }
    installApplicationMenu();
    return { results };
  });

  ipcMain.handle(CHANNELS.skillsScanAddRoot, async () => {
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (!picked.canceled && picked.filePaths.length > 0) {
      settings.addSkillScanRoot(picked.filePaths[0]);
    }
    return settingsForRenderer();
  });

  // The first-run question about the built-in skills. Only a yes writes
  // the files this app puts under ~/.claude.
  ipcMain.handle(CHANNELS.skillsSeedAnswer, async (event, { install }) => {
    const current = settings.update({ skillMakerSeeding: install ? "installed" : "declined" });
    if (install) {
      seedBuiltinSkills(current.skillsRoot, (line) => console.log(line));
      installApplicationMenu();
    } else {
      console.log("[builtin] the user declined the built-in skills; nothing was written under ~/.claude");
    }
    return settingsForRenderer();
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

  ipcMain.handle(CHANNELS.panelOpenSearch, async (event, { sessionKey, query }) => {
    return panelTabs.openSearch(sessionKey, String(query || "").slice(0, 200));
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
  const projectsDirectory = claudeRegistryPaths({ homeDirectory: os.homedir() }).projectsDirectory;
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
  // There is no Dock outside macOS; on Windows the taskbar icon comes from
  // the launcher's shortcut instead (scripts/lib/windowsLauncher.js).
  if (isMacOS() && app.dock && fs.existsSync(applicationIconPath)) {
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
    onChange() {
      sendToWindow(CHANNELS.settingsChanged, settingsForRenderer());
      // A new agents root is a new folder to watch, and the Skills menu may
      // now be reading a different skills folder.
      watchAgentsRoot();
      installApplicationMenu();
    },
    log(line) {
      console.log(line);
    }
  });
  // The agent that makes agents, the skill that makes skills and the skill
  // that explains the `clauding` command ship with the app, so they exist
  // for everyone: the Agent Maker goes into agents.json as the first agent.
  // The skills are different — they are written into the user's own
  // ~/.claude/skills, so they wait for a yes (the window asks once, see
  // settingsForRenderer); a copy the user edited is never overwritten
  // either way.
  seedBuiltins({
    agentStore: agents,
    skillsRoot: settings.get().skillsRoot,
    log: (line) => console.log(line),
    skillAnswer: settings.get().skillMakerSeeding
  });
  watchAgentsRoot();
  sessionFlags = createSessionFlagsStore({
    storagePath: path.join(userDataDirectory, "session-flags.json"),
    onChange(state) {
      sendToWindow(CHANNELS.sessionFlagsChanged, state);
    },
    log(line) {
      console.log(line);
    }
  });
  watchStoreFiles();
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
  checkForNewVersionQuietlyIfDue();
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
  for (const stopWatching of stopWatchingStoreFiles) {
    stopWatching();
  }
  stopWatchingStoreFiles = [];
});
