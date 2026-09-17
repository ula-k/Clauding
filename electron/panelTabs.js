// The right panel's tabs, kept per session and saved to
// <userData>/panel-tabs.json so a session's tabs come back after a restart.
//
// A tab is { tabId, kind, target, title }:
//   kind "html"      a local .html / .htm file, rendered in a <webview> (file://)
//   kind "markdown"  a local .md file, rendered by the app's markdown pipeline
//   kind "url"       an http(s) address, rendered in a <webview>
//
// Keys are session ids; a terminal that has not registered its session yet
// uses "terminal:<terminalId>" and its tabs move to the session id once known.
//
// Whether the panel is open is stored per session too (`panelVisible`), next
// to that session's tabs: one session can have the panel open on a page while
// the next one shows only its terminal. A session with no flag of its own
// follows its tabs — visible when it has some, hidden when it has none. The
// panel's *width* is not here: that is one setting for the whole window.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expandHomeFolder, isWindows } from "./lib/platformPaths.js";

const SAVE_DEBOUNCE_MILLISECONDS = 200;

export function expandHomePath(target, platform = process.platform) {
  return expandHomeFolder(target, { platform, homeDirectory: os.homedir() });
}

// "file:///Users/me/page.html" -> "/Users/me/page.html"
// "file:///C:/Users/me/page.html" -> "C:\Users\me\page.html"
// A Windows file URL carries the drive after the third slash, so that slash
// has to go or the path starts at the root of the current drive instead.
export function filePathFromUrl(target, platform = process.platform) {
  const withoutScheme = decodeURIComponent(String(target || "").replace(/^file:\/\//i, ""));
  if (isWindows(platform) && /^\/[A-Za-z]:/.test(withoutScheme)) {
    return withoutScheme.slice(1).replace(/\//g, "\\");
  }
  return withoutScheme;
}

// Turns what the user (or the CLI) typed into a tab description, or throws
// with a readable message. Relative paths resolve against `baseDirectory`.
export function describeTarget(rawTarget, baseDirectory) {
  const trimmed = String(rawTarget || "").trim();
  if (!trimmed) {
    throw new Error("Nothing to open: give a file path or a URL.");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "url", target: trimmed, title: trimmed.replace(/^https?:\/\//i, "").replace(/\/$/, "") };
  }
  let filePath = trimmed;
  if (/^file:\/\//i.test(filePath)) {
    filePath = filePathFromUrl(filePath);
  }
  filePath = expandHomePath(filePath);
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(baseDirectory || os.homedir(), filePath);
  }
  filePath = path.normalize(filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`The file does not exist: ${filePath}`);
  }
  if (fs.statSync(filePath).isDirectory()) {
    throw new Error(`That is a folder, not a page: ${filePath}`);
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return { kind: "markdown", target: filePath, title: path.basename(filePath) };
  }
  if (extension === ".html" || extension === ".htm") {
    return { kind: "html", target: filePath, title: path.basename(filePath) };
  }
  throw new Error(`Only .html, .md files and http(s) URLs can be opened: ${filePath}`);
}

export function createPanelTabStore({ storagePath, onChange }) {
  let tabsBySession = {};
  let saveTimer = null;

  try {
    const saved = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    if (saved && typeof saved === "object" && saved.sessions && typeof saved.sessions === "object") {
      tabsBySession = saved.sessions;
    }
  } catch (error) {
    tabsBySession = {};
  }

  function save() {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(storagePath), { recursive: true });
        fs.writeFileSync(storagePath, JSON.stringify({ version: 1, sessions: tabsBySession }, null, 2));
      } catch (error) {
        console.log(`[panel] could not save ${storagePath}: ${error.message}`);
      }
    }, SAVE_DEBOUNCE_MILLISECONDS);
  }

  function emptyState() {
    return { tabs: [], activeTabId: null };
  }

  // A session that was never shown or hidden by hand follows its tabs.
  function visibilityOf(state) {
    if (typeof state.panelVisible === "boolean") {
      return state.panelVisible;
    }
    return state.tabs.length > 0;
  }

  // A copy the renderer can keep; never the stored object itself.
  function get(sessionKey) {
    const state = sessionKey ? tabsBySession[sessionKey] : null;
    if (!state) {
      return { tabs: [], activeTabId: null, panelVisible: false };
    }
    return {
      tabs: state.tabs.map((tab) => ({ ...tab })),
      activeTabId: state.activeTabId,
      panelVisible: visibilityOf(state)
    };
  }

  function announce(sessionKey, reveal) {
    save();
    if (onChange) {
      onChange({ sessionKey, state: get(sessionKey), reveal: Boolean(reveal) });
    }
  }

  // Opens (or re-activates) a tab. `reveal` asks the renderer to show the
  // panel if that session is on screen.
  function open(sessionKey, description, { reveal = true } = {}) {
    if (!sessionKey) {
      throw new Error("No session to attach the tab to.");
    }
    const state = tabsBySession[sessionKey] || emptyState();
    let tab = state.tabs.find((existing) => existing.kind === description.kind && existing.target === description.target);
    if (!tab) {
      tab = { tabId: randomUUID(), kind: description.kind, target: description.target, title: description.title };
      state.tabs.push(tab);
    }
    state.activeTabId = tab.tabId;
    if (reveal) {
      // Opening a page is asking to see it: this session's panel goes up.
      state.panelVisible = true;
    }
    tabsBySession[sessionKey] = state;
    announce(sessionKey, reveal);
    return { ...tab };
  }

  function close(sessionKey, tabId) {
    const state = tabsBySession[sessionKey];
    if (!state) {
      return;
    }
    const index = state.tabs.findIndex((tab) => tab.tabId === tabId);
    if (index === -1) {
      return;
    }
    state.tabs.splice(index, 1);
    if (state.activeTabId === tabId) {
      const neighbour = state.tabs[index] || state.tabs[index - 1] || null;
      state.activeTabId = neighbour ? neighbour.tabId : null;
    }
    if (state.tabs.length === 0) {
      delete tabsBySession[sessionKey];
    }
    announce(sessionKey, false);
  }

  // The Show / Hide panel button and `clauding panel show|hide`: the flag is
  // written for that one session, never for the whole window.
  function setVisible(sessionKey, visible) {
    if (!sessionKey) {
      return;
    }
    const state = tabsBySession[sessionKey] || emptyState();
    state.panelVisible = Boolean(visible);
    if (state.tabs.length === 0 && !state.panelVisible) {
      // Nothing left worth remembering: an empty session is hidden anyway.
      delete tabsBySession[sessionKey];
    } else {
      tabsBySession[sessionKey] = state;
    }
    announce(sessionKey, false);
  }

  function activate(sessionKey, tabId) {
    const state = tabsBySession[sessionKey];
    if (!state || !state.tabs.some((tab) => tab.tabId === tabId)) {
      return;
    }
    state.activeTabId = tabId;
    announce(sessionKey, false);
  }

  // The renderer learned a better title (a web page's <title>).
  function setTitle(sessionKey, tabId, title) {
    const state = tabsBySession[sessionKey];
    const tab = state ? state.tabs.find((existing) => existing.tabId === tabId) : null;
    if (!tab || !title || tab.title === title) {
      return;
    }
    tab.title = title;
    announce(sessionKey, false);
  }

  // Tabs opened under "terminal:<id>" before the CLI registered its session
  // move to the session id.
  function migrate(fromKey, toKey) {
    const state = tabsBySession[fromKey];
    if (!state || fromKey === toKey) {
      return;
    }
    const existing = tabsBySession[toKey] || emptyState();
    for (const tab of state.tabs) {
      if (!existing.tabs.some((known) => known.kind === tab.kind && known.target === tab.target)) {
        existing.tabs.push(tab);
      }
    }
    existing.activeTabId = state.activeTabId || existing.activeTabId;
    if (typeof state.panelVisible === "boolean") {
      existing.panelVisible = state.panelVisible;
    }
    tabsBySession[toKey] = existing;
    delete tabsBySession[fromKey];
    announce(toKey, false);
  }

  // The session was deleted: its tabs have nothing left to belong to.
  function forgetSession(sessionKey) {
    if (!sessionKey || !tabsBySession[sessionKey]) {
      return false;
    }
    delete tabsBySession[sessionKey];
    announce(sessionKey, false);
    return true;
  }

  return { get, open, close, activate, setTitle, setVisible, migrate, forgetSession };
}
