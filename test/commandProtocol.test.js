// CL-11 — what the running app does with one `clauding open` / `clauding
// panel show|hide` / `clauding tabs` / `clauding agent add|list` request
// (electron/lib/commandRequests.js).
//
// The terminal registry is a small fake — no pty, no `claude` — while the
// panel tab store and the target description are the real ones, working on
// pages inside a throw-away folder under the system temporary folder.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPanelTabStore, describeTarget } from "../electron/panelTabs.js";
import { createCommandRequestHandler } from "../electron/lib/commandRequests.js";

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-command-"));
}

function pageIn(folder, fileName, text = "<h1>page</h1>") {
  const filePath = path.join(folder, fileName);
  fs.writeFileSync(filePath, text);
  return filePath;
}

// A stand-in for the terminal registry: only what the handler asks it for.
function fakeTerminals(records) {
  const byId = new Map(records.map((record) => [record.terminalId, record]));
  return {
    get(terminalId) {
      return byId.get(terminalId) || null;
    },
    mostRecentlyFocused() {
      const live = records.filter((record) => !record.exited);
      if (live.length === 0) {
        return null;
      }
      return live.reduce((newest, record) => (record.focusedAt > newest.focusedAt ? record : newest));
    }
  };
}

function terminal(overrides) {
  return {
    terminalId: "terminal-one",
    sessionId: "session-one",
    workingDirectory: "/",
    focusedAt: 1,
    exited: false,
    ...overrides
  };
}

// The whole app the handler talks to, with the real panel store.
function appWith({ terminals = [], panelSelection = {} } = {}) {
  const folder = scratchFolder();
  const panelTabs = createPanelTabStore({ storagePath: path.join(folder, "panel-tabs.json") });
  const panelNotices = [];
  const logLines = [];
  const handler = createCommandRequestHandler({
    terminals: fakeTerminals(terminals),
    panelTabs,
    describeTarget,
    readPanelSelection() {
      return panelSelection;
    },
    onPanelCommand(notice) {
      panelNotices.push(notice);
    },
    log(line) {
      logLines.push(line);
    }
  });
  return { folder, panelTabs, panelNotices, logLines, handler };
}

test("an unknown command and a panel without show or hide are refused", async () => {
  const { handler } = appWith({ terminals: [terminal({})] });
  await assert.rejects(handler.handleCommandRequest({ command: "fly", terminalId: "terminal-one" }), /Unknown command/);
  await assert.rejects(
    handler.handleCommandRequest({ command: "panel", action: "maybe", terminalId: "terminal-one" }),
    /show\|hide/
  );
});

test("open lands in the caller's own terminal and says so without a fallback", async () => {
  const { handler, panelTabs, folder } = appWith({ terminals: [terminal({})] });
  const page = pageIn(folder, "plan.html");
  const answer = await handler.handleCommandRequest({
    command: "open",
    terminalId: "terminal-one",
    cwd: folder,
    target: page
  });
  assert.equal(answer, `Opened ${page} in the Clauding panel.`);
  assert.deepEqual(panelTabs.get("session-one").tabs.map((tab) => tab.target), [page]);
  assert.equal(panelTabs.get("session-one").panelVisible, true);
});

test("a relative path is resolved against the folder the command was run in", async () => {
  const { handler, panelTabs, folder } = appWith({
    terminals: [terminal({ workingDirectory: "/somewhere/else" })]
  });
  const page = pageIn(folder, "plan.html");
  const answer = await handler.handleCommandRequest({
    command: "open",
    terminalId: "terminal-one",
    cwd: folder,
    target: "plan.html"
  });
  assert.equal(answer, `Opened ${page} in the Clauding panel.`);
  assert.deepEqual(panelTabs.get("session-one").tabs.map((tab) => tab.target), [page]);
});

test("with no folder of its own the caller's terminal folder is used", async () => {
  const folder = scratchFolder();
  const page = pageIn(folder, "plan.html");
  const { handler } = appWith({ terminals: [terminal({ workingDirectory: folder })] });
  const answer = await handler.handleCommandRequest({
    command: "open",
    terminalId: "terminal-one",
    target: "plan.html"
  });
  assert.equal(answer, `Opened ${page} in the Clauding panel.`);
});

test("a terminal whose CLI has not registered a session yet keeps its tabs under its own key", async () => {
  const { handler, panelTabs, folder } = appWith({
    terminals: [terminal({ sessionId: null })]
  });
  await handler.handleCommandRequest({
    command: "open",
    terminalId: "terminal-one",
    cwd: folder,
    target: pageIn(folder, "plan.html")
  });
  assert.equal(panelTabs.get("terminal:terminal-one").tabs.length, 1);
});

test("without a terminal id the page goes to the session on screen, and the line says so", async () => {
  const { handler, panelTabs, folder, logLines } = appWith({
    terminals: [terminal({ terminalId: "on-screen", sessionId: "session-on-screen" })],
    panelSelection: { terminalId: "on-screen", sessionKey: "session-on-screen" }
  });
  const page = pageIn(folder, "plan.html");
  const answer = await handler.handleCommandRequest({ command: "open", terminalId: null, cwd: folder, target: page });
  assert.equal(answer, `Opened ${page} in the Clauding panel (current session).`);
  assert.equal(panelTabs.get("session-on-screen").tabs.length, 1);
  assert.equal(logLines.length, 1, "the fallback is written to the log too");
});

test("a stale terminal id falls back the same way as none at all", async () => {
  const { handler, folder } = appWith({
    terminals: [terminal({ terminalId: "on-screen", sessionId: "session-on-screen" })],
    panelSelection: { terminalId: "on-screen", sessionKey: "session-on-screen" }
  });
  const page = pageIn(folder, "plan.html");
  const answer = await handler.handleCommandRequest({
    command: "open",
    terminalId: "a-terminal-that-exited-long-ago",
    cwd: folder,
    target: page
  });
  assert.equal(answer, `Opened ${page} in the Clauding panel (current session).`);
});

test("a session on screen with no terminal of its own still takes the page", async () => {
  const { handler, panelTabs, folder } = appWith({
    terminals: [],
    panelSelection: { terminalId: null, sessionKey: "session-being-read" }
  });
  const page = pageIn(folder, "plan.html");
  const answer = await handler.handleCommandRequest({ command: "open", cwd: folder, target: page });
  assert.equal(answer, `Opened ${page} in the Clauding panel (current session).`);
  assert.equal(panelTabs.get("session-being-read").tabs.length, 1);
});

test("with nothing on screen the most recently used terminal takes it", async () => {
  const { handler, panelTabs, folder } = appWith({
    terminals: [
      terminal({ terminalId: "older", sessionId: "session-older", focusedAt: 10 }),
      terminal({ terminalId: "newer", sessionId: "session-newer", focusedAt: 20 }),
      terminal({ terminalId: "newest-but-gone", sessionId: "session-gone", focusedAt: 30, exited: true })
    ],
    panelSelection: {}
  });
  const page = pageIn(folder, "plan.html");
  const answer = await handler.handleCommandRequest({ command: "open", cwd: folder, target: page });
  assert.equal(answer, `Opened ${page} in the Clauding panel (most recent terminal).`);
  assert.equal(panelTabs.get("session-newer").tabs.length, 1);
});

test("with no terminal at all the command fails with a readable reason", async () => {
  const { handler, folder } = appWith({ terminals: [], panelSelection: {} });
  await assert.rejects(
    handler.handleCommandRequest({ command: "open", cwd: folder, target: pageIn(folder, "plan.html") }),
    /CLAUDING_TERMINAL_ID missing or stale/
  );
});

test("a file that cannot be opened fails instead of pretending", async () => {
  const { handler, folder } = appWith({ terminals: [terminal({})] });
  await assert.rejects(
    handler.handleCommandRequest({ command: "open", terminalId: "terminal-one", cwd: folder, target: "gone.html" }),
    /does not exist/
  );
  await assert.rejects(
    handler.handleCommandRequest({
      command: "open",
      terminalId: "terminal-one",
      cwd: folder,
      target: pageIn(folder, "data.csv", "one,two")
    }),
    /only/i
  );
});

test("panel show and hide write the flag for that session and tell the window", async () => {
  const { handler, panelTabs, panelNotices, folder } = appWith({ terminals: [terminal({})] });
  await handler.handleCommandRequest({
    command: "open",
    terminalId: "terminal-one",
    cwd: folder,
    target: pageIn(folder, "plan.html")
  });

  const hidden = await handler.handleCommandRequest({ command: "panel", action: "hide", terminalId: "terminal-one" });
  assert.equal(hidden, "Panel hidden.");
  assert.equal(panelTabs.get("session-one").panelVisible, false);

  const shown = await handler.handleCommandRequest({ command: "panel", action: "show", terminalId: "terminal-one" });
  assert.equal(shown, "Panel shown.");
  assert.equal(panelTabs.get("session-one").panelVisible, true);
  assert.deepEqual(panelNotices, [
    { action: "hide", sessionKey: "session-one" },
    { action: "show", sessionKey: "session-one" }
  ]);
});

test("panel show through a fallback names the fallback in its answer", async () => {
  const { handler } = appWith({
    terminals: [terminal({ terminalId: "on-screen", sessionId: "session-on-screen" })],
    panelSelection: { terminalId: "on-screen", sessionKey: "session-on-screen" }
  });
  assert.equal(await handler.handleCommandRequest({ command: "panel", action: "show" }), "Panel shown (current session).");
});

test("tabs lists this session's tabs, marking the active one", async () => {
  const { handler, folder } = appWith({ terminals: [terminal({})] });
  const empty = await handler.handleCommandRequest({ command: "tabs", terminalId: "terminal-one" });
  assert.equal(empty, "No tabs open for this session.");

  const first = pageIn(folder, "plan.html");
  const notes = pageIn(folder, "notes.md", "# notes");
  await handler.handleCommandRequest({ command: "open", terminalId: "terminal-one", cwd: folder, target: first });
  await handler.handleCommandRequest({ command: "open", terminalId: "terminal-one", cwd: folder, target: notes });
  const listed = await handler.handleCommandRequest({ command: "tabs", terminalId: "terminal-one" });
  assert.equal(listed, `  [html] ${first}\n* [markdown] ${notes}`);
});

test("tabs through a fallback says whose tabs these are", async () => {
  const { handler, folder } = appWith({
    terminals: [terminal({ terminalId: "on-screen", sessionId: "session-on-screen" })],
    panelSelection: { terminalId: "on-screen", sessionKey: "session-on-screen" }
  });
  const page = pageIn(folder, "plan.html");
  await handler.handleCommandRequest({ command: "open", terminalId: "on-screen", cwd: folder, target: page });
  const listed = await handler.handleCommandRequest({ command: "tabs" });
  assert.equal(listed, `Tabs (current session):\n* [html] ${page}`);
  const stale = await handler.handleCommandRequest({ command: "tabs", terminalId: "a-terminal-that-exited" });
  assert.equal(stale, listed, "a stale terminal id lands in the same place");

  const elsewhere = appWith({
    terminals: [terminal({ terminalId: "on-screen", sessionId: "session-with-nothing" })],
    panelSelection: { terminalId: "on-screen", sessionKey: "session-with-nothing" }
  });
  const empty = await elsewhere.handler.handleCommandRequest({ command: "tabs" });
  assert.equal(empty, "No tabs open for this session (current session).");
});

test("a web address opens as a tab of its own", async () => {
  const { handler, panelTabs } = appWith({ terminals: [terminal({})] });
  const answer = await handler.handleCommandRequest({
    command: "open",
    terminalId: "terminal-one",
    target: "https://example.com/"
  });
  assert.equal(answer, "Opened https://example.com/ in the Clauding panel.");
  assert.equal(panelTabs.get("session-one").tabs[0].kind, "url");
});

// `clauding agent add|list`: the app's agent list, reached from a session
// that has just written a definition. The store is a small fake with the
// same two calls main.js hands in.
function fakeAgentList(initialAgents = []) {
  const registered = initialAgents.slice();
  return {
    registered,
    list() {
      return registered.map((agent) => ({ ...agent }));
    },
    add(draft) {
      const agent = { id: `agent-${registered.length + 1}`, ...draft };
      registered.push(agent);
      return { ...agent };
    }
  };
}

function appWithAgents(agents) {
  const folder = scratchFolder();
  const handler = createCommandRequestHandler({
    terminals: fakeTerminals([terminal({})]),
    panelTabs: createPanelTabStore({ storagePath: path.join(folder, "panel-tabs.json") }),
    describeTarget,
    readPanelSelection() {
      return {};
    },
    agents
  });
  return { folder, handler };
}

function definitionFolderIn(folder, slug, text) {
  const definitionFolder = path.join(folder, slug);
  fs.mkdirSync(definitionFolder, { recursive: true });
  fs.writeFileSync(path.join(definitionFolder, `${slug}.md`), text);
  return definitionFolder;
}

test("agent add registers the folder with the name, emoji and colour it suggests", async () => {
  const agents = fakeAgentList();
  const { handler, folder } = appWithAgents(agents);
  const definitionFolder = definitionFolderIn(folder, "release-notes-writer", "# Agent: Release Notes Writer 📝\n\nRole.\n");
  const answer = await handler.handleCommandRequest({
    command: "agent",
    action: "add",
    definitionFolder: "release-notes-writer",
    cwd: folder
  });
  assert.equal(answer, 'Added agent "Release Notes Writer" to Clauding.');
  assert.deepEqual(agents.registered.length, 1);
  const added = agents.registered[0];
  assert.equal(added.definitionFolder, definitionFolder, "a relative folder is resolved against the caller's cwd");
  assert.equal(added.definitionFile, path.join(definitionFolder, "release-notes-writer.md"));
  assert.equal(added.emoji, "📝");
});

test("agent add takes the flags over its own suggestions", async () => {
  const agents = fakeAgentList([{ id: "one", name: "Agent Maker", emoji: "🧬", definitionFolder: "/elsewhere" }]);
  const { handler, folder } = appWithAgents(agents);
  definitionFolderIn(folder, "invoice-checker", "# Agent: Invoice Checker ✅\n");
  const answer = await handler.handleCommandRequest({
    command: "agent",
    action: "add",
    definitionFolder: path.join(folder, "invoice-checker"),
    name: "Faktury",
    emoji: "🧾",
    cwd: folder
  });
  assert.equal(answer, 'Added agent "Faktury" to Clauding.');
  const added = agents.registered[1];
  assert.equal(added.name, "Faktury");
  assert.equal(added.emoji, "🧾");
});

test("agent add refuses a folder twice, a folder that is not there and one without a definition", async () => {
  const agents = fakeAgentList();
  const { handler, folder } = appWithAgents(agents);
  const definitionFolder = definitionFolderIn(folder, "spec-writer", "# Agent: Spec Writer 📐\n");
  await handler.handleCommandRequest({ command: "agent", action: "add", definitionFolder, cwd: folder });
  await assert.rejects(
    handler.handleCommandRequest({ command: "agent", action: "add", definitionFolder, cwd: folder }),
    /already registered as "Spec Writer"/
  );
  await assert.rejects(
    handler.handleCommandRequest({ command: "agent", action: "add", definitionFolder: path.join(folder, "nowhere"), cwd: folder }),
    /there is no folder at/
  );
  fs.mkdirSync(path.join(folder, "empty-one"));
  await assert.rejects(
    handler.handleCommandRequest({ command: "agent", action: "add", definitionFolder: path.join(folder, "empty-one"), cwd: folder }),
    /no Markdown definition file/
  );
  assert.equal(agents.registered.length, 1, "nothing was registered by a refused request");
});

test("agent list prints one line per agent, and says so when there are none", async () => {
  const agents = fakeAgentList();
  const { handler, folder } = appWithAgents(agents);
  assert.equal(
    await handler.handleCommandRequest({ command: "agent", action: "list" }),
    "No agents are registered in Clauding yet."
  );
  const definitionFolder = definitionFolderIn(folder, "spec-writer", "# Agent: Spec Writer 📐\n");
  await handler.handleCommandRequest({ command: "agent", action: "add", definitionFolder, cwd: folder });
  assert.equal(
    await handler.handleCommandRequest({ command: "agent", action: "list" }),
    `📐 Spec Writer — ${definitionFolder}`
  );
});

test("an agent request without an action, and one to a window with no agent list, are refused", async () => {
  const { handler } = appWithAgents(fakeAgentList());
  await assert.rejects(handler.handleCommandRequest({ command: "agent", action: "remove" }), /clauding agent add/);
  const { handler: panelOnly } = appWith({ terminals: [terminal({})] });
  await assert.rejects(panelOnly.handleCommandRequest({ command: "agent", action: "list" }), /no agent list/);
});
