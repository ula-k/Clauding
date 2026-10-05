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
//
// The rest is what the **setup agent** changes the app with, so that it
// never writes a store file by hand: `settings get|set`, `sessions count`,
// `skills install-builtin`, `integrations clickup status`, `project
// inspect|add|list`, `repos find`, `repo inspect` and `onboarding done`.
// They reach the app through `setup` (a handful of calls main.js hands in;
// the dry tests hand in fakes), and every one of them answers with one line
// — or, for the two inspections, the JSON the agent reads.
//
// Two more are not typed by anybody: `state` and `session-info` are how the
// Clauding mod (builtin/mod/clauding-mod/), running inside a `claude` the app
// started, tells the app what the session is doing and asks what the app
// knows about it (the linked task, the branch, the mod's own switches). They
// reach the app through `mod` (two calls main.js hands in).
//
// `calendar add|list|remove` puts entries in a project's own calendar
// (lib/calendarCommands.js does the work; `calendar` is handed in).
import { inspectDefinitionFolder } from "../agents.js";
import { describeOneSetting, describeSettings, parseSettingValue } from "./settingCommands.js";

const PANEL_COMMANDS = ["open", "panel", "tabs"];
const MOD_COMMANDS = ["state", "session-info"];
const SETUP_COMMANDS = ["settings", "sessions", "skills", "integrations", "project", "repos", "repo", "onboarding"];

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
  // Everything the setup commands need from the app (see the file header).
  setup = null,
  // The Clauding mod's two calls: `reportState(terminalId, { state, detail })`
  // and `sessionInfo(terminalId)` (see the file header).
  mod = null,
  // `clauding calendar add|list|remove` (lib/calendarCommands.js): an object
  // with `handle(request)`, answering one line.
  calendar = null,
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
  // form makes (definition file, name, emoji) and the flags the caller
  // passed on top of them. The folder is what identifies an
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

  // ---- setup commands -----------------------------------------------------

  function settingsRequest(request) {
    const effective = setup.effectiveSettings ? setup.effectiveSettings() : {};
    if (request.action === "get") {
      const current = setup.getSettings();
      if (request.key) {
        return describeOneSetting(current, request.key, effective);
      }
      return JSON.stringify(describeSettings(current, effective), null, 2);
    }
    if (request.action === "set") {
      const parsed = parseSettingValue(String(request.key || ""), request.value, setup.fileChecks || {});
      if (parsed.key === "agentsRoot" && setup.ensureFolder) {
        setup.ensureFolder(parsed.draft.agentsRoot);
      }
      setup.updateSettings(parsed.draft);
      return `Set ${parsed.key} to ${parsed.shown}.`;
    }
    throw new Error("Use: clauding settings get [key] | clauding settings set <key> <value>");
  }

  async function sessionsRequest(request) {
    if (request.action !== "count") {
      throw new Error("Use: clauding sessions count");
    }
    const { count, claudeHome, more } = await setup.countSessions();
    const shown = more ? `at least ${count}` : String(count);
    const verb = count === 1 && !more ? "session is" : "sessions are";
    return `${shown} ${verb} visible to Clauding (read from ${claudeHome}).`;
  }

  function skillsRequest(request) {
    if (request.action !== "install-builtin") {
      throw new Error("Use: clauding skills install-builtin");
    }
    const { skillsRoot, results } = setup.installBuiltinSkills();
    const failed = results.filter((result) => result.status === "failed");
    if (failed.length > 0) {
      throw new Error(`could not write ${failed.map((result) => result.skillName).join(", ")} into ${skillsRoot}.`);
    }
    const words = { created: "installed", current: "already current", refreshed: "updated", kept: "kept your edited copy" };
    const listed = results.map((result) => `${result.skillName} (${words[result.status] || result.status})`).join(", ");
    return `Built-in skills in ${skillsRoot}: ${listed}.`;
  }

  async function integrationsRequest(request) {
    if (request.service !== "clickup" || request.action !== "status") {
      throw new Error("Use: clauding integrations clickup status");
    }
    const status = await setup.clickupStatus();
    if (status.connected) {
      const who = status.user
        ? `${status.user.name}${status.user.email ? ` <${status.user.email}>` : ""} (id ${status.user.id})`
        : "an unknown user";
      const where = (status.workspaces || []).map((workspace) => `${workspace.name} (${workspace.id})`).join(", ");
      const from = status.source === "keychain" ? "the Keychain" : status.source;
      return `ClickUp: connected as ${who}; token from ${from}; workspaces: ${where || "none"}.`;
    }
    if (status.reason === "no-token") {
      throw new Error(
        "ClickUp is not connected: no token. Add one to the Keychain with `security add-generic-password -a clickup-api -s clickup-api-token -w <token>` or set CLAUDING_CLICKUP_TOKEN, then ask again."
      );
    }
    if (status.reason === "unauthorized") {
      throw new Error("ClickUp refused the token it found (401). Replace the Keychain item or CLAUDING_CLICKUP_TOKEN.");
    }
    throw new Error(`ClickUp could not be asked: ${status.message || status.reason}.`);
  }

  function repositoryCount(count) {
    return count === 1 ? "1 repository" : `${count} repositories`;
  }

  function clickupSummary(board) {
    if (board.clickup && board.clickup.buildListId) {
      return `ClickUp list "${board.clickup.buildListName || board.clickup.buildListId}"`;
    }
    return "no ClickUp";
  }

  async function projectRequest(request) {
    if (request.action === "list") {
      const boards = setup.listProjects();
      if (boards.length === 0) {
        return "No projects in Clauding yet.";
      }
      return boards.map((board) => `${board.name} — ${clickupSummary(board)}, ${repositoryCount(board.repositories.length)}`).join("\n");
    }
    if (request.action === "inspect") {
      if (!request.link) {
        throw new Error("Use: clauding project inspect <ClickUp link>");
      }
      return JSON.stringify(await setup.inspectProjectLink(String(request.link)), null, 2);
    }
    if (request.action === "add") {
      const draft = request.board && typeof request.board === "object" ? request.board : null;
      if (!draft || !String(draft.name || "").trim()) {
        throw new Error('a project needs a name (--name, or "name" in the JSON file).');
      }
      const wantedName = String(draft.name).trim().toLowerCase();
      const existing = setup.listProjects().find((board) => board.name.toLowerCase() === wantedName);
      if (existing) {
        throw new Error(`there is already a project called "${existing.name}".`);
      }
      const answer = await setup.addProject(draft);
      if (answer.candidates) {
        const names = answer.candidates.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ");
        throw new Error(`the link holds several lists and none is clearly the build list; add "clickup": { "buildListId": "…" } with one of: ${names}.`);
      }
      const board = answer.board;
      return `Added project "${board.name}" to Clauding (${clickupSummary(board)}, ${repositoryCount(board.repositories.length)}).`;
    }
    throw new Error("Use: clauding project inspect <link> | clauding project add --json <file> | clauding project list");
  }

  async function repositoryRequest(request) {
    if (request.command === "repos" && request.action === "find") {
      const found = setup.findRepositories(request.roots || []);
      if (found.length === 0) {
        return "No git repositories found there.";
      }
      return found.map((repository) => repository.path).join("\n");
    }
    if (request.command === "repo" && request.action === "inspect" && request.path) {
      const described = await setup.describeRepository(request.path);
      if (!described.isRepository) {
        throw new Error(`${request.path} is not inside a git repository.`);
      }
      return JSON.stringify(described, null, 2);
    }
    throw new Error("Use: clauding repos find [folder …] | clauding repo inspect <folder>");
  }

  function onboardingRequest(request) {
    if (request.action !== "done") {
      throw new Error("Use: clauding onboarding done");
    }
    setup.updateSettings({ onboarding: "done" });
    return "Setup is marked as done; the first-run screen will not come back.";
  }

  async function handleSetupRequest(request) {
    if (!setup) {
      throw new Error("this window cannot be set up from the command line.");
    }
    switch (request.command) {
      case "settings":
        return settingsRequest(request);
      case "sessions":
        return sessionsRequest(request);
      case "skills":
        return skillsRequest(request);
      case "integrations":
        return integrationsRequest(request);
      case "project":
        return projectRequest(request);
      case "onboarding":
        return onboardingRequest(request);
      default:
        return repositoryRequest(request);
    }
  }


  // `clauding state <terminal> <state> [detail]` and
  // `clauding session-info <terminal>`. The terminal is named explicitly
  // (the mod reads CLAUDING_TERMINAL_ID itself) and must be a live one of
  // this app: no fallback to the one on screen, a report about the wrong
  // session would be worse than none.
  async function handleModRequest(request) {
    if (!mod) {
      throw new Error("this window does not take reports from the Clauding mod.");
    }
    const terminalId = String(request.target || request.terminalId || "").trim();
    if (!terminalId) {
      throw new Error("Use: clauding state <terminal id> <state> [detail] | clauding session-info <terminal id>");
    }
    if (request.command === "state") {
      const applied = mod.reportState(terminalId, { state: request.state, detail: request.detail || "" });
      if (!applied) {
        throw new Error(`no live terminal ${terminalId} in this app.`);
      }
      return `State ${applied.next.state}.`;
    }
    const info = await mod.sessionInfo(terminalId);
    if (!info) {
      throw new Error(`no live terminal ${terminalId} in this app.`);
    }
    return JSON.stringify(info);
  }

  async function handleCommandRequest(request) {
    if (MOD_COMMANDS.includes(request.command)) {
      return handleModRequest(request);
    }
    if (request.command === "agent") {
      return handleAgentRequest(request);
    }
    if (request.command === "calendar") {
      if (!calendar) {
        throw new Error("this window has no project calendars.");
      }
      return calendar.handle(request);
    }
    if (SETUP_COMMANDS.includes(request.command)) {
      return handleSetupRequest(request);
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
