import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LanguageContext, detectSystemLanguage, loadSavedLanguage, saveLanguage, translateInLanguage } from "./i18n.js";
import { folderLabel } from "./paths.js";
import { disposeInstance, ensureInstance, hasInstance, lastTerminalDimensions, writeToInstance } from "./terminalInstances.js";
import { groupIdForSession } from "./sessionGrouping.js";
import { forkDisplayName } from "./forkName.js";
import {
  createAgentKickoffMessage,
  createAgentTaskPrompt,
  harvestSkillsKickoffMessage,
  harvestSkillsSessionName,
  harvestSkillsTaskPrompt,
  newAgentSessionName
} from "./metaPrompts.js";
import SessionsColumn from "./components/SessionsColumn.jsx";
import MiddleColumn from "./components/MiddleColumn.jsx";
import SidePanel from "./components/SidePanel.jsx";
import WindowTools from "./components/WindowTools.jsx";
import SkillsScanSheet from "./components/SkillsScanSheet.jsx";
import BuiltinSkillSheet from "./components/BuiltinSkillSheet.jsx";

const PAGE_SIZE = 60;
const LEFT_WIDTH_MIN = 240;
const LEFT_WIDTH_MAX = 480;
const LEFT_WIDTH_STORAGE_KEY = "clauding.leftWidth";
const PANEL_WIDTH_MIN = 280;
const PANEL_WIDTH_MAX = 1200;
const PANEL_WIDTH_STORAGE_KEY = "clauding.panelWidth";
// The terminal never gets narrower than this, whatever the two handles are
// dragged to — and a width stored when the window was bigger is brought back
// inside the same limit on load, so the panel handle can never end up off
// screen (it did: the panel then could not be moved at all).
const MIDDLE_WIDTH_MIN = 480;
// Both handles clamp against the window, not only against their own limits.
function clampPanelWidth(width, leftWidth, windowWidth) {
  const largest = Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, windowWidth - leftWidth - MIDDLE_WIDTH_MIN));
  return Math.round(Math.min(largest, Math.max(PANEL_WIDTH_MIN, width)));
}

function clampLeftWidth(width, panelWidth, windowWidth) {
  const largest = Math.max(LEFT_WIDTH_MIN, Math.min(LEFT_WIDTH_MAX, windowWidth - panelWidth - MIDDLE_WIDTH_MIN));
  return Math.round(Math.min(largest, Math.max(LEFT_WIDTH_MIN, width)));
}

function loadStoredNumber(storageKey, minimum, maximum, fallback) {
  try {
    const saved = Number(window.localStorage.getItem(storageKey));
    if (saved >= minimum && saved <= maximum) {
      return saved;
    }
  } catch (error) {
    // ignore
  }
  return fallback;
}

function loadLeftWidth() {
  return loadStoredNumber(LEFT_WIDTH_STORAGE_KEY, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX, 300);
}

function loadPanelWidth() {
  return loadStoredNumber(PANEL_WIDTH_STORAGE_KEY, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX, 520);
}

function storeValue(storageKey, value) {
  try {
    window.localStorage.setItem(storageKey, String(value));
  } catch (error) {
    // ignore
  }
}

const EMPTY_PANEL_STATE = { tabs: [], activeTabId: null, panelVisible: false };
// Until groups.json has been read: one group holding everything, nothing hidden.
const INITIAL_GROUP_STATE = { groups: [{ id: "default", name: null, order: 0 }], membership: {}, hidden: [], collapsed: [] };
// Until agents.json has been read: no agents, so no badges anywhere.
const INITIAL_AGENT_STATE = { agents: [], sessionAgents: {} };
// Until settings.json has been read. The real defaults are decided in the
// main process (electron/settings.js); these only keep the menu from
// drawing "undefined" for the few milliseconds before the answer arrives.
const INITIAL_SETTINGS = { agentsRoot: "", skillsRoot: "", skillScanRoots: [], skillMakerSeeding: "installed" };
// The agent that makes agents, by its built-in marker rather than by name:
// the user may rename it.
const AGENT_MAKER_MARKER = "agent-maker";

// A row for a session a terminal of ours just started, shown until
// listSessions() sees the transcript file on disk (written at the first prompt).
function placeholderSession(terminal, language) {
  return {
    sessionId: terminal.sessionId,
    title: terminal.sessionName || translateInLanguage(language, "newSession.untitled"),
    customTitle: terminal.sessionName || null,
    summary: null,
    firstPrompt: null,
    workingDirectory: terminal.workingDirectory,
    workingDirectoryShort: terminal.workingDirectory.replace(/^\/Users\/[^/]+/, "~"),
    projectName: terminal.workingDirectory.split("/").filter(Boolean).pop() || terminal.workingDirectory,
    projectLabel: folderLabel(terminal.workingDirectory),
    projectColorIndex: 0,
    gitBranch: null,
    lastModified: terminal.startedAt,
    createdAt: terminal.startedAt,
    fileSize: null,
    tag: null,
    statusGroup: terminal.registryStatus === "idle" ? "waiting" : "running",
    ownedByApp: true,
    liveStatus: { group: terminal.registryStatus === "idle" ? "waiting" : "running", source: "app", terminalId: terminal.terminalId },
    isPlaceholder: true
  };
}

export default function App() {
  const [language, setLanguageState] = useState(() => loadSavedLanguage() || detectSystemLanguage());
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [terminals, setTerminals] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState(null);
  const [newSheetOpen, setNewSheetOpen] = useState(false);
  const [newSheetGroupId, setNewSheetGroupId] = useState(null);
  const [newSheetAgentId, setNewSheetAgentId] = useState(null);
  const [groupState, setGroupState] = useState(INITIAL_GROUP_STATE);
  const [agentState, setAgentState] = useState(INITIAL_AGENT_STATE);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  // The Skills item in the macOS menu bar asks the window to open the same
  // popover the Skills button opens.
  const [skillsMenuOpen, setSkillsMenuOpen] = useState(false);
  // "Scan for skills…": the sheet that lists every skill-looking folder on
  // the Mac and lets the user pick which ones to copy into the skills folder.
  const [skillsScanOpen, setSkillsScanOpen] = useState(false);
  // The page the middle column is showing instead of the terminal: a skill's
  // SKILL.md or an agent's definition, { kind, name, filePath, folder }. The
  // terminal underneath keeps running; null means "show the terminal".
  const [reader, setReader] = useState(null);
  // Definition folders that appeared under the agents root while the app was
  // running — what the Agent Maker leaves behind. Each one is offered as
  // "Add as agent" at the top of the Agents tab until it is added or waved
  // away.
  const [definitionSuggestions, setDefinitionSuggestions] = useState([]);
  // Whether the panel is open belongs to the session on screen and comes
  // from the main process with that session's tabs (panel-tabs.json). This
  // one is only for the moments when no session is selected at all, so the
  // Show panel button still does something on the empty screen.
  const [panelOpenWithoutSession, setPanelOpenWithoutSession] = useState(false);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [panelState, setPanelState] = useState(EMPTY_PANEL_STATE);
  // Sessions agents.json links to an agent, read by id in the main process.
  // The Sessions list only holds the pages it has loaded, so without these
  // an agent's older work would be missing from the Agents tab.
  const [linkedAgentSessions, setLinkedAgentSessions] = useState([]);
  const [leftWidth, setLeftWidth] = useState(loadLeftWidth);
  // With a session on screen the panel follows that session's own flag;
  // panelOpenWithoutSession is reset to false as soon as one is selected, so
  // only one of the two is ever true.
  const panelOpen = panelState.panelVisible || panelOpenWithoutSession;
  // Which handle is being dragged right now: "left", "panel" or nothing.
  const [draggingHandle, setDraggingHandle] = useState(null);
  const [now, setNow] = useState(Date.now());
  const loadedCountRef = useRef(0);
  // terminalId -> groupId for a session opened from a group header's "+":
  // the group is set the moment the CLI registers its session id.
  const pendingGroupByTerminalRef = useRef(new Map());
  const selectedSessionIdRef = useRef(null);
  const selectedTerminalIdRef = useRef(null);
  const terminalsRef = useRef([]);
  const sessionsRef = useRef([]);
  // sessionAgents as it is right now, for the callbacks that must not be
  // rebuilt on every change of it (selecting a session, forking one).
  const agentLinksRef = useRef({});
  const panelSessionKeyRef = useRef(null);
  // Counts the panel states the main process has pushed at us. The answer to
  // a getPanelTabs() we sent earlier must not overwrite a newer push: when a
  // terminal registers its session id, the key changes, we ask for the new
  // key's tabs, and the main process moves the old key's tabs over a moment
  // later — so the answer in flight is the state from *before* the move, and
  // applying it late put the panel away again with the page in it.
  const panelStateStampRef = useRef(0);
  // Read inside the pointer listeners, which are installed once per drag.
  const leftWidthRef = useRef(leftWidth);
  const panelWidthRef = useRef(panelWidth);
  const panelOpenRef = useRef(panelOpen);
  const dragPointerRef = useRef(null);
  leftWidthRef.current = leftWidth;
  panelWidthRef.current = panelWidth;
  panelOpenRef.current = panelOpen;
  selectedTerminalIdRef.current = selectedTerminalId;
  terminalsRef.current = terminals;
  agentLinksRef.current = agentState.sessionAgents;

  const setLanguage = useCallback((languageCode) => {
    saveLanguage(languageCode);
    setLanguageState(languageCode);
  }, []);

  // Ask the main process for the OS language once, unless a choice was saved.
  useEffect(() => {
    if (loadSavedLanguage()) {
      return;
    }
    window.clauding.getSystemLanguage().then((systemLanguage) => {
      setLanguageState(detectSystemLanguage(systemLanguage));
    });
  }, []);

  // Relative times ("2 min") tick along without a reload.
  useEffect(() => {
    const ticker = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(ticker);
  }, []);

  const loadSessions = useCallback(async ({ reset } = { reset: false }) => {
    const offset = reset ? 0 : loadedCountRef.current;
    const limit = reset ? Math.max(PAGE_SIZE, loadedCountRef.current) : PAGE_SIZE;
    try {
      const page = await window.clauding.listSessions({ offset, limit });
      setSessions((previous) => (reset ? page.sessions : previous.concat(page.sessions)));
      loadedCountRef.current = offset + page.sessions.length;
      setHasMore(page.hasMore);
      setSessionsError(null);
    } catch (error) {
      console.error("Could not list sessions", error);
      setSessionsError(String(error));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions({ reset: true });
    return window.clauding.onSessionsChanged(() => {
      loadSessions({ reset: true });
    });
  }, [loadSessions]);

  // Terminals: the registry in the main process is the source of truth. Output
  // goes straight into the xterm instances (kept outside React); the list is
  // only used for headers, ownership and the placeholder rows.
  useEffect(() => {
    let disposed = false;
    window.clauding.listTerminals().then(async (list) => {
      if (disposed) {
        return;
      }
      // After a renderer reload the ptys are still alive: rebuild their
      // xterm instances from the output kept in the main process.
      for (const terminal of list) {
        if (!hasInstance(terminal.terminalId)) {
          ensureInstance(terminal.terminalId);
          const replay = await window.clauding.replayTerminal(terminal.terminalId);
          if (replay) {
            writeToInstance(terminal.terminalId, replay);
          }
        }
      }
      setTerminals(list);
    });
    const stopData = window.clauding.onTerminalData(({ terminalId, data }) => {
      writeToInstance(terminalId, data);
    });
    const stopChanged = window.clauding.onTerminalsChanged(({ terminals: list }) => {
      setTerminals(list);
    });
    const stopExit = window.clauding.onTerminalExit(({ terminalId, sessionId }) => {
      disposeInstance(terminalId);
      if (selectedTerminalIdRef.current === terminalId) {
        setSelectedTerminalId(null);
        if (sessionId) {
          setSelectedSessionId(sessionId);
        }
      }
    });
    return () => {
      disposed = true;
      stopData();
      stopChanged();
      stopExit();
    };
  }, []);

  // Once the CLI in the selected terminal registers its session id, the
  // matching row becomes the selection so the list highlights it.
  useEffect(() => {
    if (!selectedTerminalId) {
      return;
    }
    const terminal = terminals.find((record) => record.terminalId === selectedTerminalId);
    if (terminal && terminal.sessionId && terminal.sessionId !== selectedSessionId) {
      setSelectedSessionId(terminal.sessionId);
    }
  }, [terminals, selectedTerminalId, selectedSessionId]);

  const activeTerminal = useMemo(() => {
    if (selectedTerminalId) {
      const byId = terminals.find((record) => record.terminalId === selectedTerminalId);
      if (byId) {
        return byId;
      }
    }
    if (selectedSessionId) {
      return terminals.find((record) => record.sessionId === selectedSessionId) || null;
    }
    return null;
  }, [terminals, selectedTerminalId, selectedSessionId]);

  useEffect(() => {
    selectedSessionIdRef.current = activeTerminal ? null : selectedSessionId;
  }, [activeTerminal, selectedSessionId]);

  // The user's own grouping of the list, kept in the main process (groups.json).
  useEffect(() => {
    window.clauding.getSessionGroups().then(setGroupState);
    return window.clauding.onSessionGroupsChanged((state) => {
      setGroupState(state);
    });
  }, []);

  // The user's agents and the session -> agent links (agents.json), also kept
  // in the main process: a terminal started as an agent writes its link there
  // as soon as the CLI registers a session id.
  useEffect(() => {
    window.clauding.getAgents().then(setAgentState);
    return window.clauding.onAgentsChanged((state) => {
      setAgentState(state);
    });
  }, []);

  // The app's own settings (settings.json): where new agent definitions are
  // written, and the folder Claude Code reads skills from.
  useEffect(() => {
    window.clauding.getSettings().then(setSettings);
    return window.clauding.onSettingsChanged(setSettings);
  }, []);

  // The Skills item in the macOS menu bar, and "Scan for skills…" next to it.
  useEffect(() => {
    return window.clauding.onShowSkills((request) => {
      if (request && request.scan) {
        setSkillsScanOpen(true);
        return;
      }
      setSkillsMenuOpen(true);
    });
  }, []);

  // One skill picked straight from the macOS Skills menu: the same reader a
  // click in the popover opens.
  useEffect(() => {
    return window.clauding.onReadSkill((skill) => {
      if (skill && skill.filePath) {
        setReader({ kind: "skill", name: skill.name, filePath: skill.filePath, folder: skill.folder });
      }
    });
  }, []);

  // A definition folder that turned up under the agents root. The same
  // folder is never offered twice, and one that is already an agent is not
  // offered at all (the main process checks that too).
  useEffect(() => {
    return window.clauding.onAgentDefinitionFound((inspection) => {
      if (!inspection || !inspection.definitionFile) {
        return;
      }
      setDefinitionSuggestions((previous) =>
        previous.some((known) => known.definitionFolder === inspection.definitionFolder)
          ? previous
          : previous.concat([inspection])
      );
    });
  }, []);

  const dismissDefinitionSuggestion = useCallback((suggestion) => {
    setDefinitionSuggestions((previous) =>
      previous.filter((known) => known.definitionFolder !== suggestion.definitionFolder)
    );
  }, []);

  // The linked sessions themselves, read by id in the main process. Asked
  // for again whenever the links change and whenever the session list does
  // (a title was edited, a new session appeared, one was resumed).
  const loadLinkedAgentSessions = useCallback(() => {
    window.clauding
      .getLinkedAgentSessions()
      .then(setLinkedAgentSessions)
      .catch((error) => {
        console.error("Could not read the sessions linked to an agent", error);
      });
  }, []);

  useEffect(() => {
    loadLinkedAgentSessions();
  }, [loadLinkedAgentSessions, agentState.sessionAgents]);

  useEffect(() => {
    return window.clauding.onSessionsChanged(() => {
      loadLinkedAgentSessions();
    });
  }, [loadLinkedAgentSessions]);

  // Dragging a handle. The pointer is captured by the handle itself and the
  // whole window is covered by a transparent overlay for the length of the
  // drag, because the right panel renders its pages in a <webview>: that is a
  // separate guest process which swallows every pointer event that reaches
  // it, so narrowing the panel (the direction that moves the pointer over the
  // page) used to stop dead while widening it still worked.
  const beginDrag = useCallback((event, which) => {
    if (typeof event.button === "number" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    const handleElement = event.currentTarget;
    try {
      handleElement.setPointerCapture(event.pointerId);
      dragPointerRef.current = { element: handleElement, pointerId: event.pointerId };
    } catch (error) {
      // Pointer capture is a nicety; the overlay alone also keeps the drag alive.
      dragPointerRef.current = null;
    }
    setDraggingHandle(which);
  }, []);

  useEffect(() => {
    if (!draggingHandle) {
      return undefined;
    }
    function applyPosition(clientX) {
      if (draggingHandle === "left") {
        setLeftWidth(clampLeftWidth(clientX, panelOpenRef.current ? panelWidthRef.current : 0, window.innerWidth));
      } else {
        setPanelWidth(clampPanelWidth(window.innerWidth - clientX, leftWidthRef.current, window.innerWidth));
      }
    }
    function handlePointerMove(event) {
      applyPosition(event.clientX);
    }
    function handlePointerUp(event) {
      applyPosition(event.clientX);
      const captured = dragPointerRef.current;
      if (captured) {
        try {
          captured.element.releasePointerCapture(captured.pointerId);
        } catch (error) {
          // The element may be gone already.
        }
        dragPointerRef.current = null;
      }
      setDraggingHandle(null);
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [draggingHandle]);

  // A width stored when the window was wider (or with the panel closed) is
  // corrected here — on start, when the window is resized and when the panel
  // is shown — so the middle column always keeps its minimum.
  useEffect(() => {
    function correctWidths() {
      const windowWidth = window.innerWidth;
      // The panel first, then the left column against the corrected panel,
      // so a panel that was far too wide does not drag the left column down
      // with it.
      const correctedPanel = clampPanelWidth(panelWidthRef.current, leftWidthRef.current, windowWidth);
      const correctedLeft = clampLeftWidth(leftWidthRef.current, panelOpenRef.current ? correctedPanel : 0, windowWidth);
      setPanelWidth(correctedPanel);
      setLeftWidth(correctedLeft);
    }
    correctWidths();
    window.addEventListener("resize", correctWidths);
    return () => window.removeEventListener("resize", correctWidths);
  }, [panelOpen]);

  useEffect(() => {
    storeValue(LEFT_WIDTH_STORAGE_KEY, leftWidth);
  }, [leftWidth]);

  useEffect(() => {
    storeValue(PANEL_WIDTH_STORAGE_KEY, panelWidth);
  }, [panelWidth]);

  const openTerminal = useCallback(async ({
    workingDirectory,
    resumeSessionId,
    openedByClick = false,
    groupId = null,
    forkSession = false,
    sessionName = null,
    agentId = null,
    taskPrompt = null,
    kickoffMessage = null
  }) => {
    setNewSheetOpen(false);
    // A terminal the user just asked for is what they want to look at.
    setReader(null);
    try {
      const dimensions = lastTerminalDimensions();
      const record = await window.clauding.openTerminal({
        workingDirectory,
        resumeSessionId: resumeSessionId || null,
        forkSession,
        sessionName,
        agentId,
        // The one job this terminal was opened for, if any: it goes at the
        // end of the same prompt file the agent definition is written to.
        taskPrompt,
        // …and the message the app types in for it once the CLI is at its
        // prompt, because a system prompt alone starts no turn.
        kickoffMessage,
        columns: dimensions.columns,
        rows: dimensions.rows,
        openedByClick
      });
      ensureInstance(record.terminalId);
      if (groupId) {
        pendingGroupByTerminalRef.current.set(record.terminalId, groupId);
      }
      setTerminals((previous) =>
        previous.some((existing) => existing.terminalId === record.terminalId) ? previous : previous.concat([record])
      );
      // A fork gets a brand new session id, so nothing is selected by id
      // until its CLI registers one (the effect above picks it up).
      setSelectedSessionId(forkSession ? null : resumeSessionId || null);
      setSelectedTerminalId(record.terminalId);
      return record;
    } catch (error) {
      console.error("Could not open the terminal", error);
      window.alert(String(error && error.message ? error.message : error));
      return null;
    }
  }, []);

  // A click on a session is a terminal, immediately: a session already open
  // in the app shows its terminal, one running outside the app stays a
  // read-only preview, and anything else gets `claude --resume` right away.
  const selectSession = useCallback((sessionId) => {
    setNewSheetOpen(false);
    // Picking another conversation leaves whatever page was being read: the
    // reader belongs to the moment, not to the session.
    setReader(null);
    setSelectedSessionId(sessionId);
    const owner = terminalsRef.current.find((record) => record.sessionId === sessionId);
    if (owner) {
      setSelectedTerminalId(owner.terminalId);
      return;
    }
    setSelectedTerminalId(null);
    const session = sessionsRef.current.find((record) => record.sessionId === sessionId);
    if (!session || !session.workingDirectory) {
      return;
    }
    if (session.liveStatus && session.liveStatus.source !== "app") {
      return;
    }
    // Resume as the agent this session is assigned to: the definition goes
    // into the system prompt of the resumed terminal, so an old session
    // attached to an agent behaves as that agent from its next message on.
    openTerminal({
      workingDirectory: session.workingDirectory,
      resumeSessionId: sessionId,
      agentId: agentLinksRef.current[sessionId] || null,
      openedByClick: true
    });
  }, [openTerminal]);

  // Fork: a *new* terminal runs `claude --resume <id> --fork-session --name
  // "<title> (fork)"` in the original's folder. The original terminal is not
  // touched — the point of the feature is that both stay open. The copy joins
  // the original's group as soon as its CLI registers the new session id.
  const forkSelectedSession = useCallback(() => {
    const sourceSessionId = (activeTerminal && activeTerminal.sessionId) || selectedSessionId;
    if (!sourceSessionId) {
      return null;
    }
    const sourceSession = sessionsRef.current.find((record) => record.sessionId === sourceSessionId) || null;
    const workingDirectory =
      (activeTerminal && activeTerminal.workingDirectory) || (sourceSession && sourceSession.workingDirectory) || null;
    if (!workingDirectory) {
      return null;
    }
    const sourceTitle = sourceSession ? sourceSession.title : translateInLanguage(language, "newSession.untitled");
    return openTerminal({
      workingDirectory,
      resumeSessionId: sourceSessionId,
      forkSession: true,
      sessionName: forkDisplayName(sourceTitle),
      groupId: groupIdForSession(sourceSessionId, groupState.membership, groupState.groups),
      // A copy of a conversation is the same agent's work, so the fork
      // carries the original's agent: the same definition in its prompt, the
      // same badge on its row, and its own line under that agent in the
      // Agents tab. The terminal knows first — agents.json only learns the
      // link once the CLI has registered the session id.
      agentId:
        (activeTerminal && activeTerminal.agentId) ||
        (sourceSession && sourceSession.agent ? sourceSession.agent.id : null) ||
        agentState.sessionAgents[sourceSessionId] ||
        null
    });
  }, [activeTerminal, selectedSessionId, language, groupState, agentState, openTerminal]);

  const renameSession = useCallback(async (sessionId, title) => {
    if (!sessionId) {
      return;
    }
    try {
      await window.clauding.renameSession(sessionId, title);
      setSessions((previous) =>
        previous.map((session) => (session.sessionId === sessionId ? { ...session, title, customTitle: title } : session))
      );
    } catch (error) {
      console.error("Could not rename the session", error);
    }
  }, []);

  const handleRenameSelected = useCallback(
    (title) => {
      const sessionId = selectedSessionIdRef.current || (activeTerminal && activeTerminal.sessionId);
      return renameSession(sessionId, title);
    },
    [activeTerminal, renameSession]
  );

  // Everything the group headers and the row menus do. Each call returns the
  // new groups.json state; the main process also broadcasts it.
  const groupActions = useMemo(
    () => ({
      createGroup(name) {
        window.clauding.createSessionGroup(name).then(setGroupState);
      },
      renameGroup(groupId, name) {
        window.clauding.renameSessionGroup(groupId, name).then(setGroupState);
      },
      moveGroup(groupId, direction) {
        window.clauding.moveSessionGroup(groupId, direction).then(setGroupState);
      },
      deleteGroup(groupId) {
        window.clauding.deleteSessionGroup(groupId).then(setGroupState);
      },
      assignSession(sessionId, groupId) {
        window.clauding.assignSessionToGroup(sessionId, groupId).then(setGroupState);
      },
      setGroupCollapsed(groupId, collapsed) {
        window.clauding.setSessionGroupCollapsed(groupId, collapsed).then(setGroupState);
      },
      hideSession(sessionId) {
        window.clauding.setSessionHidden(sessionId, true).then(setGroupState);
      },
      unhideSession(sessionId) {
        window.clauding.setSessionHidden(sessionId, false).then(setGroupState);
      }
    }),
    []
  );

  // Everything the Agents tab and the agent form do. Each call returns the
  // new agents.json state; the main process also broadcasts it.
  // "Assign to agent" from a row menu or from the terminal header. This is
  // how a session started long before its agent existed is attached to one:
  // agents.json gets the link, the badge appears at once, and the next
  // `claude --resume` from the app carries that agent's definition.
  //
  // A session that is open in a terminal *right now* keeps the system prompt
  // it started with until the CLI is restarted, so the user is offered that
  // restart. The conversation itself is untouched — it is the same
  // `--resume`, only with the definition appended this time.
  const assignSessionToAgent = useCallback(
    async (sessionId, agentId) => {
      if (!sessionId) {
        return;
      }
      const state = await window.clauding.assignSessionToAgent(sessionId, agentId || null);
      setAgentState(state);
      const agent = agentId ? state.agents.find((entry) => entry.id === agentId) : null;
      const terminal = terminalsRef.current.find((record) => record.sessionId === sessionId && !record.exited);
      if (!agent || !terminal) {
        return;
      }
      const question = translateInLanguage(language, "agents.restartQuestion", { name: agent.name });
      if (!window.confirm(question)) {
        return;
      }
      const session = sessionsRef.current.find((record) => record.sessionId === sessionId) || null;
      const workingDirectory = terminal.workingDirectory || (session && session.workingDirectory);
      await window.clauding.closeTerminal(terminal.terminalId);
      // The pty needs a moment to hang up before a second `claude --resume`
      // takes the same session over.
      await new Promise((resolve) => setTimeout(resolve, 500));
      openTerminal({ workingDirectory, resumeSessionId: sessionId, agentId: agent.id });
    },
    [language, openTerminal]
  );

  // The two meta actions. Both fork the conversation into a second terminal
  // that has one job, and leave the original exactly as it is — the same
  // mechanism the Fork button uses, with a task added to the prompt file.
  const forkForTask = useCallback(
    ({ sessionId, agentId, sessionName, taskPrompt, kickoffMessage }) => {
      const sourceSessionId = sessionId || (activeTerminal && activeTerminal.sessionId) || selectedSessionId;
      if (!sourceSessionId) {
        return null;
      }
      const sourceSession = sessionsRef.current.find((record) => record.sessionId === sourceSessionId) || null;
      const owner = terminalsRef.current.find((record) => record.sessionId === sourceSessionId) || null;
      const workingDirectory =
        (owner && owner.workingDirectory) || (sourceSession && sourceSession.workingDirectory) || null;
      if (!workingDirectory) {
        return null;
      }
      const sourceTitle = sourceSession ? sourceSession.title : translateInLanguage(language, "newSession.untitled");
      return openTerminal({
        workingDirectory,
        resumeSessionId: sourceSessionId,
        forkSession: true,
        sessionName: sessionName(sourceTitle),
        agentId,
        taskPrompt,
        kickoffMessage,
        groupId: groupIdForSession(sourceSessionId, groupState.membership, groupState.groups)
      });
    },
    [activeTerminal, selectedSessionId, language, groupState, openTerminal]
  );

  const createAgentFromConversation = useCallback(
    (sessionId) => {
      const agentMaker = agentState.agents.find((agent) => agent.builtin === AGENT_MAKER_MARKER) || null;
      if (!agentMaker) {
        window.alert(translateInLanguage(language, "meta.noAgentMaker"));
        return null;
      }
      return forkForTask({
        sessionId,
        agentId: agentMaker.id,
        sessionName: newAgentSessionName,
        taskPrompt: createAgentTaskPrompt(settings.agentsRoot),
        kickoffMessage: createAgentKickoffMessage(settings.agentsRoot)
      });
    },
    [agentState, settings, language, forkForTask]
  );

  // Harvesting skills needs no agent: the skill-maker skill is in the skills
  // folder, and the fork is only told to run it over this conversation.
  const harvestSkillsFromConversation = useCallback(
    (sessionId) => {
      return forkForTask({
        sessionId,
        agentId: null,
        sessionName: harvestSkillsSessionName,
        taskPrompt: harvestSkillsTaskPrompt(settings.skillsRoot),
        kickoffMessage: harvestSkillsKickoffMessage(settings.skillsRoot)
      });
    },
    [settings, forkForTask]
  );

  const agentActions = useMemo(
    () => ({
      async addAgent(draft) {
        const state = await window.clauding.addAgent(draft);
        setAgentState(state);
        // The newest agent is the one just added; the "+ New" sheet may want
        // to preselect it.
        return state.agents[state.agents.length - 1] || null;
      },
      async updateAgent(agentId, draft) {
        const state = await window.clauding.updateAgent(agentId, draft);
        setAgentState(state);
        return state.agents.find((agent) => agent.id === agentId) || null;
      },
      deleteAgent(agentId) {
        window.clauding.deleteAgent(agentId).then(setAgentState);
      },
      // An agent that came with the app: back to the definition, name,
      // emoji and colour Clauding ships with (and the built-in skill is
      // put back too if it is missing).
      restoreBuiltin() {
        window.clauding.restoreBuiltinAgents().then(setAgentState);
      },
      assignSession: assignSessionToAgent
    }),
    [assignSessionToAgent]
  );

  // A session opened from a group header's "+" joins that group as soon as
  // the CLI in its terminal has registered a session id.
  useEffect(() => {
    const pending = pendingGroupByTerminalRef.current;
    if (pending.size === 0) {
      return;
    }
    for (const terminal of terminals) {
      const groupId = pending.get(terminal.terminalId);
      if (groupId && terminal.sessionId) {
        pending.delete(terminal.terminalId);
        groupActions.assignSession(terminal.sessionId, groupId);
      }
    }
  }, [terminals, groupActions]);

  // Dev-only automation (CLAUDING_SMOKE_TERMINAL): the main process drives the UI.
  useEffect(() => {
    return window.clauding.onSmokeCommand((command) => {
      if (command.action === "show-terminal") {
        ensureInstance(command.terminalId);
        setSelectedTerminalId(command.terminalId);
      } else if (command.action === "select-session") {
        selectSession(command.sessionId);
      }
    });
  }, [selectSession]);

  // Every row carries its agent (or null) so the list, the search and the
  // terminal header all read it from the same place.
  const agentById = useMemo(
    () => new Map(agentState.agents.map((agent) => [agent.id, agent])),
    [agentState]
  );

  // A terminal that has only just started has no session id in agents.json
  // yet, so its own agentId is what the placeholder row shows.
  const agentForSession = useCallback(
    (sessionId) => agentById.get(agentState.sessionAgents[sessionId]) || null,
    [agentById, agentState]
  );

  const allSessions = useMemo(() => {
    const listedIds = new Set(sessions.map((session) => session.sessionId));
    const agentByTerminalSession = new Map();
    for (const terminal of terminals) {
      if (terminal.sessionId && terminal.agentId) {
        agentByTerminalSession.set(terminal.sessionId, agentById.get(terminal.agentId) || null);
      }
    }
    const placeholders = terminals
      .filter((terminal) => terminal.sessionId && !terminal.exited && !listedIds.has(terminal.sessionId))
      .map((terminal) => placeholderSession(terminal, language));
    return placeholders.concat(sessions).map((session) => ({
      ...session,
      agent: agentByTerminalSession.get(session.sessionId) || agentForSession(session.sessionId)
    }));
  }, [sessions, terminals, language, agentById, agentForSession]);
  sessionsRef.current = allSessions;

  // What the Agents tab draws from: the rows already on screen, plus every
  // linked session the list has not loaded. A link whose session is gone from
  // disk resolves to nothing in the main process and simply is not here.
  const agentTabSessions = useMemo(() => {
    const known = new Set(allSessions.map((session) => session.sessionId));
    const extra = linkedAgentSessions
      .filter((session) => !known.has(session.sessionId))
      .map((session) => ({ ...session, agent: agentForSession(session.sessionId) }));
    return allSessions.concat(extra);
  }, [allSessions, linkedAgentSessions, agentForSession]);

  const selectedSession = allSessions.find((session) => session.sessionId === selectedSessionId) || null;
  // The chip in the terminal header. A terminal that has not registered its
  // session yet still knows which agent it was started as.
  const selectedAgent =
    (activeTerminal && activeTerminal.agentId ? agentById.get(activeTerminal.agentId) : null) ||
    (selectedSession ? selectedSession.agent : null) ||
    null;

  // The right panel's tabs belong to the session on screen (a terminal that
  // has not registered its session yet uses a temporary key, see panelTabs.js).
  const panelSessionKey = activeTerminal
    ? activeTerminal.sessionId || `terminal:${activeTerminal.terminalId}`
    : selectedSessionId;
  panelSessionKeyRef.current = panelSessionKey;

  // The main process follows the selection so `clauding open` run without a
  // CLAUDING_TERMINAL_ID (a plain shell, a subagent, a stale id) still opens
  // its tab in the panel of the session on screen.
  useEffect(() => {
    window.clauding.reportPanelSelection({
      terminalId: activeTerminal ? activeTerminal.terminalId : null,
      sessionKey: panelSessionKey || null
    });
  }, [activeTerminal, panelSessionKey]);

  // Show / hide the panel for the session on screen. With nothing selected
  // the button still works, it just has nowhere to write the flag.
  const setPanelVisible = useCallback(
    (visible) => {
      if (!panelSessionKey) {
        setPanelOpenWithoutSession(Boolean(visible));
        return;
      }
      panelStateStampRef.current += 1;
      setPanelState((current) => ({ ...current, panelVisible: Boolean(visible) }));
      window.clauding.setPanelVisible(panelSessionKey, Boolean(visible));
    },
    [panelSessionKey]
  );

  useEffect(() => {
    // Cleared right away so another session's webviews never render under this key.
    setPanelState(EMPTY_PANEL_STATE);
    if (!panelSessionKey) {
      return;
    }
    setPanelOpenWithoutSession(false);
    const stampWhenAsked = panelStateStampRef.current;
    window.clauding.getPanelTabs(panelSessionKey).then((state) => {
      if (panelSessionKeyRef.current === panelSessionKey && panelStateStampRef.current === stampWhenAsked) {
        setPanelState(state);
      }
    });
  }, [panelSessionKey]);

  useEffect(() => {
    const stopChanged = window.clauding.onPanelChanged(({ sessionKey, state }) => {
      if (sessionKey !== panelSessionKeyRef.current) {
        return;
      }
      // The state carries this session's own panelVisible, so a `reveal`
      // needs nothing extra here.
      panelStateStampRef.current += 1;
      setPanelState(state);
    });
    // `clauding panel show|hide` for a session that is on screen arrives as
    // a panel:changed with that session's new flag, so there is nothing to do
    // here; this is only the empty screen, which has no flag to follow.
    const stopCommand = window.clauding.onPanelCommand(({ action }) => {
      if (!panelSessionKeyRef.current) {
        setPanelOpenWithoutSession(action === "show");
      }
    });
    return () => {
      stopChanged();
      stopCommand();
    };
  }, []);

  const panelBaseDirectory = activeTerminal
    ? activeTerminal.workingDirectory
    : selectedSession
      ? selectedSession.workingDirectory
      : null;
  const panelActions = useMemo(
    () => ({
      // Opening a page is asking to see it, so the panel of this session is
      // put up here as well. The main process already sets the same flag,
      // but a page that lands in a panel the user hid earlier looked like
      // nothing happening at all — this window does not wait to be told.
      async open(target) {
        const opened = await window.clauding.openPanelTab({
          sessionKey: panelSessionKey,
          target,
          baseDirectory: panelBaseDirectory
        });
        setPanelVisible(true);
        return opened;
      },
      close(tabId) {
        return window.clauding.closePanelTab(panelSessionKey, tabId);
      },
      activate(tabId) {
        return window.clauding.activatePanelTab(panelSessionKey, tabId);
      },
      setTitle(tabId, title) {
        return window.clauding.setPanelTabTitle(panelSessionKey, tabId, title);
      },
      hide() {
        setPanelVisible(false);
      }
    }),
    [panelSessionKey, panelBaseDirectory, setPanelVisible]
  );

  // A skill or an agent definition opens in the middle column, over the
  // terminal — the place the user is already looking. The side panel stays
  // one click away ("Open in side panel"), which is what somebody who wants
  // the page *next to* the conversation reaches for.
  const openReader = useCallback((page) => {
    setNewSheetOpen(false);
    setSkillsMenuOpen(false);
    setReader(page);
  }, []);

  // The same reader for an agent: what the definition actually says is the
  // one thing a row cannot show, and it is what decides whether an agent is
  // the right one for the job.
  const readAgentDefinition = useCallback(
    (agent) => {
      if (!agent || !agent.definitionFile) {
        window.alert(translateInLanguage(language, "agents.noDefinitionFile"));
        return;
      }
      openReader({
        kind: "agent",
        name: `${agent.emoji} ${agent.name}`,
        filePath: agent.definitionFile,
        folder: agent.definitionFolder
      });
    },
    [language, openReader]
  );

  const openReaderInPanel = useCallback(
    (page) => {
      panelActions
        .open(page.filePath)
        .then(() => {
          setReader(null);
        })
        .catch((error) => {
          window.alert(
            translateInLanguage(language, "panel.loadError", {
              message: String(error && error.message ? error.message : error)
            })
          );
        });
    },
    [panelActions, language]
  );

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      <div
        className={draggingHandle ? "app is-resizing" : "app"}
        style={{ "--left-width": `${leftWidth}px`, "--panel-width": panelOpen ? `${panelWidth}px` : "0px" }}
      >
        <div className="title-drag-region" />
        <SessionsColumn
          sessions={allSessions}
          loading={sessionsLoading}
          error={sessionsError}
          hasMore={hasMore}
          onShowMore={() => loadSessions({ reset: false })}
          selectedSessionId={selectedSessionId}
          onSelectSession={selectSession}
          now={now}
          newSheetOpen={newSheetOpen}
          newSheetGroupId={newSheetGroupId}
          newSheetAgentId={newSheetAgentId}
          onOpenNewSheet={(groupId, agentId) => {
            setNewSheetGroupId(groupId || null);
            setNewSheetAgentId(agentId || null);
            setNewSheetOpen(true);
          }}
          onCloseNewSheet={() => setNewSheetOpen(false)}
          onConfirmNewSession={({ workingDirectory, agentId }) =>
            openTerminal({ workingDirectory, groupId: newSheetGroupId, agentId: agentId || null })
          }
          groupState={groupState}
          groupActions={groupActions}
          agentSessions={agentTabSessions}
          agents={agentState.agents}
          agentActions={agentActions}
          sessionAgents={agentState.sessionAgents}
          onRenameSession={renameSession}
          definitionSuggestions={definitionSuggestions}
          onDismissSuggestion={dismissDefinitionSuggestion}
          onCreateAgentFromSession={createAgentFromConversation}
          onHarvestSkillsFromSession={harvestSkillsFromConversation}
          onReadAgentDefinition={readAgentDefinition}
        />
        <div className="resize-handle" data-resize-handle="left" onPointerDown={(event) => beginDrag(event, "left")} />
        <MiddleColumn
          session={selectedSession}
          terminal={activeTerminal}
          agent={selectedAgent}
          agents={agentState.agents}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelVisible(!panelOpen)}
          onRename={handleRenameSelected}
          onFork={forkSelectedSession}
          onAssignAgent={assignSessionToAgent}
          onCreateAgent={() => createAgentFromConversation(null)}
          onHarvestSkills={() => harvestSkillsFromConversation(null)}
          reader={reader}
          onCloseReader={() => setReader(null)}
          onOpenReaderInPanel={openReaderInPanel}
          windowTools={
            <WindowTools
              settings={settings}
              skillsOpen={skillsMenuOpen}
              onSkillsOpenChange={setSkillsMenuOpen}
              onOpenSkill={(skill) =>
                openReader({
                  kind: "skill",
                  name: skill.name,
                  description: skill.description,
                  filePath: skill.filePath,
                  folder: skill.folder
                })
              }
              onScanForSkills={() => setSkillsScanOpen(true)}
              skillMakerSeeding={settings.skillMakerSeeding}
              onInstallBuiltinSkill={() => window.clauding.answerBuiltinSkill(true).then(setSettings)}
              onPickAgentsRoot={() => window.clauding.pickAgentsRoot().then(setSettings)}
            />
          }
        />
        <div
          className={panelOpen ? "resize-handle resize-handle-panel" : "resize-handle resize-handle-panel is-hidden"}
          data-resize-handle="panel"
          onPointerDown={(event) => beginDrag(event, "panel")}
        />
        <SidePanel open={panelOpen} sessionKey={panelSessionKey} panelState={panelState} actions={panelActions} />
        {skillsScanOpen && (
          <SkillsScanSheet
            onClose={() => setSkillsScanOpen(false)}
            onSkillsAdded={() => window.clauding.getSettings().then(setSettings)}
          />
        )}
        {/* Asked once, on the first start: may the built-in skill-maker be
            written into the skills folder? Until it is answered nothing is
            written there. The settings carry the question, so it cannot be
            missed by a window that was still mounting. */}
        {settings.askAboutBuiltinSkill && (
          <BuiltinSkillSheet
            skillsRoot={settings.skillsRoot}
            onAnswer={(install) => window.clauding.answerBuiltinSkill(install).then(setSettings)}
          />
        )}
        {draggingHandle ? <div className="drag-overlay" data-drag-overlay /> : null}
      </div>
    </LanguageContext.Provider>
  );
}
