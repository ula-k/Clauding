// CL-10 — the right panel belongs to the session, not to the window: its
// tabs and its "shown / hidden" flag are stored per session and survive a
// restart (electron/panelTabs.js). panel-tabs.json is written into a
// throw-away folder under the system temporary folder.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPanelTabStore, describeTarget, expandHomePath } from "../electron/panelTabs.js";

const SAVE_WAIT_MILLISECONDS = 450;

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-panel-"));
}

function pageIn(folder, fileName, text = "<h1>page</h1>") {
  const filePath = path.join(folder, fileName);
  fs.writeFileSync(filePath, text);
  return filePath;
}

function storeIn(folder) {
  const storagePath = path.join(folder, "panel-tabs.json");
  return { storagePath, store: createPanelTabStore({ storagePath }) };
}

function waitForSave() {
  return new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MILLISECONDS));
}

test("a session nobody has opened anything for has no tabs and a hidden panel", () => {
  const { store } = storeIn(scratchFolder());
  assert.deepEqual(store.get("session-one"), { tabs: [], activeTabId: null, panelVisible: false });
  assert.deepEqual(store.get(null), { tabs: [], activeTabId: null, panelVisible: false });
});

test("opening a page puts the panel up for that session and makes the tab active", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder);
  const page = pageIn(folder, "plan.html");
  const tab = store.open("session-one", describeTarget(page, folder));
  const state = store.get("session-one");
  assert.equal(state.panelVisible, true);
  assert.equal(state.activeTabId, tab.tabId);
  assert.deepEqual(state.tabs.map((entry) => entry.kind), ["html"]);
  assert.equal(state.tabs[0].title, "plan.html");
  assert.deepEqual(store.get("other-session").tabs, [], "another session keeps its own panel");
  assert.equal(store.get("other-session").panelVisible, false);
});

test("opening the same page twice only re-activates the tab", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder);
  const page = pageIn(folder, "plan.html");
  const first = store.open("session-one", describeTarget(page, folder));
  store.open("session-one", describeTarget(pageIn(folder, "notes.md", "# notes"), folder));
  const again = store.open("session-one", describeTarget(page, folder));
  assert.equal(again.tabId, first.tabId);
  assert.equal(store.get("session-one").tabs.length, 2);
  assert.equal(store.get("session-one").activeTabId, first.tabId);
});

test("a page opened without revealing leaves the panel where the user put it", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder);
  store.open("session-one", describeTarget(pageIn(folder, "plan.html"), folder));
  store.setVisible("session-one", false);
  store.open("session-one", describeTarget(pageIn(folder, "second.html"), folder), { reveal: false });
  assert.equal(store.get("session-one").panelVisible, false, "the session was hidden on purpose");
  assert.equal(store.get("session-one").tabs.length, 2, "the tab is there, waiting behind the hidden panel");
});

test("a session with nothing in it at all is hidden, and remembers nothing", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder);
  // Hiding a session that has no tabs leaves nothing worth storing, so the
  // flag goes with it: the next page opened for that session shows up.
  store.setVisible("session-one", false);
  assert.equal(store.get("session-one").panelVisible, false);
  store.open("session-one", describeTarget(pageIn(folder, "plan.html"), folder), { reveal: false });
  assert.equal(store.get("session-one").panelVisible, true, "a session that has tabs and no flag follows its tabs");
});

test("closing the last tab of a session forgets it again", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder);
  const first = store.open("session-one", describeTarget(pageIn(folder, "one.html"), folder));
  const second = store.open("session-one", describeTarget(pageIn(folder, "two.html"), folder));
  store.close("session-one", first.tabId);
  assert.deepEqual(store.get("session-one").tabs.map((tab) => tab.title), ["two.html"]);
  assert.equal(store.get("session-one").activeTabId, second.tabId, "the neighbour takes over");
  store.close("session-one", second.tabId);
  assert.deepEqual(store.get("session-one"), { tabs: [], activeTabId: null, panelVisible: false });
});

test("show and hide are remembered for that one session", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder);
  store.open("session-one", describeTarget(pageIn(folder, "plan.html"), folder));
  store.setVisible("session-one", false);
  assert.equal(store.get("session-one").panelVisible, false, "hidden on purpose, even though it has a tab");
  store.setVisible("session-one", true);
  assert.equal(store.get("session-one").panelVisible, true);
  store.setVisible("session-two", true);
  assert.equal(store.get("session-two").panelVisible, true, "shown on purpose, even with no tabs");
});

test("tabs opened before the CLI registered a session move to the session id", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder);
  const early = store.open("terminal:terminal-one", describeTarget(pageIn(folder, "early.html"), folder));
  store.setVisible("terminal:terminal-one", true);
  store.migrate("terminal:terminal-one", "session-one");
  const state = store.get("session-one");
  assert.deepEqual(state.tabs.map((tab) => tab.tabId), [early.tabId]);
  assert.equal(state.activeTabId, early.tabId);
  assert.equal(state.panelVisible, true);
  assert.deepEqual(store.get("terminal:terminal-one").tabs, [], "the temporary key is gone");
});

test("migrating into a session that already has the same page does not double it", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder);
  const page = pageIn(folder, "plan.html");
  store.open("session-one", describeTarget(page, folder));
  store.open("terminal:terminal-one", describeTarget(page, folder));
  store.open("terminal:terminal-one", describeTarget(pageIn(folder, "extra.html"), folder));
  store.migrate("terminal:terminal-one", "session-one");
  assert.deepEqual(store.get("session-one").tabs.map((tab) => tab.title), ["plan.html", "extra.html"]);
});

test("every session gets its own panel back after a restart", async () => {
  const folder = scratchFolder();
  const first = storeIn(folder);
  first.store.open("session-one", describeTarget(pageIn(folder, "one.html"), folder));
  first.store.open("session-two", describeTarget(pageIn(folder, "two.html"), folder));
  first.store.setVisible("session-two", false);
  await waitForSave();

  const saved = JSON.parse(fs.readFileSync(first.storagePath, "utf8"));
  assert.equal(saved.version, 1);
  const reopened = createPanelTabStore({ storagePath: first.storagePath });
  assert.equal(reopened.get("session-one").panelVisible, true);
  assert.deepEqual(reopened.get("session-one").tabs.map((tab) => tab.title), ["one.html"]);
  assert.equal(reopened.get("session-two").panelVisible, false);
  assert.deepEqual(reopened.get("session-two").tabs.map((tab) => tab.title), ["two.html"]);
});

test("what may be opened: local pages, notes and web addresses, nothing else", () => {
  const folder = scratchFolder();
  const page = pageIn(folder, "plan.html");
  const notes = pageIn(folder, "notes.md", "# notes");
  const sheet = pageIn(folder, "data.csv", "one,two");

  assert.deepEqual(describeTarget(page, folder), { kind: "html", target: page, title: "plan.html" });
  assert.deepEqual(describeTarget(notes, folder), { kind: "markdown", target: notes, title: "notes.md" });
  assert.equal(describeTarget("https://example.com/", folder).kind, "url");
  assert.equal(describeTarget("https://example.com/", folder).title, "example.com");
  assert.throws(() => describeTarget(sheet, folder), /only/i);
  assert.throws(() => describeTarget("", folder), /file path or a URL/i);
  assert.throws(() => describeTarget(path.join(folder, "gone.html"), folder), /does not exist/i);
  assert.throws(() => describeTarget(folder, folder), /folder/i);
});

test("a relative path is resolved against the folder the command ran in", () => {
  const folder = scratchFolder();
  const page = pageIn(folder, "plan.html");
  assert.equal(describeTarget("plan.html", folder).target, page);
  assert.equal(describeTarget("./plan.html", folder).target, page);
  assert.equal(describeTarget(`file://${page}`, folder).target, page);
  assert.equal(expandHomePath("~"), os.homedir());
  assert.equal(expandHomePath("~/Desktop"), path.join(os.homedir(), "Desktop"));
  assert.equal(expandHomePath("/opt/work"), "/opt/work");
});

test("a page's own title replaces the file name once the panel knows it", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder);
  const tab = store.open("session-one", describeTarget(pageIn(folder, "plan.html"), folder));
  store.setTitle("session-one", tab.tabId, "The plan");
  assert.equal(store.get("session-one").tabs[0].title, "The plan");
  store.setTitle("session-one", tab.tabId, "");
  assert.equal(store.get("session-one").tabs[0].title, "The plan", "an empty title is ignored");
});
