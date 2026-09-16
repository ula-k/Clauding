// CL-04, CL-05, CL-06 — the store behind the user's own grouping of the
// session list (electron/sessionGroups.js).
//
// Nothing here touches the real ~/Library/Application Support/Clauding: every
// store gets its own groups.json inside a throw-away folder under the system
// temporary folder, and no Electron and no `claude` is involved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionGroupStore, DEFAULT_GROUP_ID } from "../electron/sessionGroups.js";

const SAVE_WAIT_MILLISECONDS = 400;

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-groups-"));
}

function storeIn(folder, savedState) {
  const storagePath = path.join(folder, "groups.json");
  if (savedState !== undefined) {
    fs.writeFileSync(storagePath, typeof savedState === "string" ? savedState : JSON.stringify(savedState));
  }
  return { storagePath, store: createSessionGroupStore({ storagePath }) };
}

function waitForSave() {
  return new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MILLISECONDS));
}

function groupNames(state) {
  return state.groups.map((group) => group.name);
}

test("a fresh store has only Default, unnamed and last", () => {
  const { store } = storeIn(scratchFolder());
  const state = store.get();
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].id, DEFAULT_GROUP_ID);
  assert.equal(state.groups[0].name, null);
  assert.deepEqual(state.membership, {});
  assert.deepEqual(state.hidden, []);
  assert.deepEqual(state.collapsed, []);
});

test("a new group opens at the top and Default stays pinned at the bottom", () => {
  const { store } = storeIn(scratchFolder());
  store.createGroup("Blueprint");
  store.createGroup("Clauding");
  const state = store.get();
  assert.deepEqual(groupNames(state), ["Clauding", "Blueprint", null]);
  assert.equal(state.groups[state.groups.length - 1].id, DEFAULT_GROUP_ID);
  assert.deepEqual(state.groups.map((group) => group.order), [0, 1, 2]);
});

test("a group name is trimmed, collapsed to single spaces and capped", () => {
  const { store } = storeIn(scratchFolder());
  const group = store.createGroup("   two    words   ");
  assert.equal(group.name, "two words");
  const long = store.createGroup("x".repeat(200));
  assert.equal(long.name.length, 60);
  assert.throws(() => store.createGroup("   "), /name/i);
});

test("move up and down swap neighbours and never move Default", () => {
  const { store } = storeIn(scratchFolder());
  const first = store.createGroup("first");
  store.createGroup("second");
  // Order now: second, first, Default.
  store.moveGroup(first.id, "up");
  assert.deepEqual(groupNames(store.get()), ["first", "second", null]);
  store.moveGroup(first.id, "down");
  assert.deepEqual(groupNames(store.get()), ["second", "first", null]);
  // "first" is the last movable group: down would swap it with Default.
  store.moveGroup(first.id, "down");
  assert.deepEqual(groupNames(store.get()), ["second", "first", null]);
  store.moveGroup(DEFAULT_GROUP_ID, "up");
  assert.deepEqual(groupNames(store.get()), ["second", "first", null]);
});

test("deleting a group sends its sessions back to Default and cannot touch Default", () => {
  const { store } = storeIn(scratchFolder());
  const group = store.createGroup("Blueprint");
  store.assignSession("session-one", group.id);
  store.setCollapsed(group.id, true);
  assert.equal(store.get().membership["session-one"], group.id);

  store.deleteGroup(group.id);
  const state = store.get();
  assert.equal(state.groups.length, 1);
  assert.equal(state.membership["session-one"], undefined, "the session is back in Default");
  assert.deepEqual(state.collapsed, [], "a deleted group is no longer collapsed");

  store.deleteGroup(DEFAULT_GROUP_ID);
  assert.equal(store.get().groups.length, 1);
});

test("assigning a session to Default or to an unknown group clears its membership", () => {
  const { store } = storeIn(scratchFolder());
  const group = store.createGroup("Blueprint");
  store.assignSession("session-one", group.id);
  store.assignSession("session-one", DEFAULT_GROUP_ID);
  assert.equal(store.get().membership["session-one"], undefined);
  store.assignSession("session-two", "no-such-group");
  assert.equal(store.get().membership["session-two"], undefined);
});

test("hiding keeps the session's group, so unhiding puts it back where it was", () => {
  const { store } = storeIn(scratchFolder());
  const group = store.createGroup("Blueprint");
  store.assignSession("session-one", group.id);
  store.setHidden("session-one", true);
  assert.deepEqual(store.get().hidden, ["session-one"]);
  assert.equal(store.get().membership["session-one"], group.id);
  store.setHidden("session-one", false);
  assert.deepEqual(store.get().hidden, []);
  assert.equal(store.get().membership["session-one"], group.id);
});

// Hiding is "stop it and put it away". The bounce-back these tests are here
// for: a session that was merely *present* in the CLI registry — an app
// terminal sitting idle — was unhidden again on the very next poll, so Hide
// looked broken. Only something that happens after the hiding brings a row
// back.
function activity(entries) {
  return new Map(Object.entries(entries).map(([sessionId, state]) => [sessionId, { busy: false, needsAnswer: false, ...state }]));
}

test("a session hidden while it was quiet stays hidden, poll after poll", () => {
  const { store } = storeIn(scratchFolder());
  store.setHidden("quiet-session", true);
  assert.equal(store.get().hiddenSince["quiet-session"].awaitingIdle, false);

  // Still there, still idle, still nothing happening: it stays away.
  assert.equal(store.unhideOnActivity(activity({ "quiet-session": { busy: false } })), false);
  assert.equal(store.unhideOnActivity(activity({})), false);
  assert.equal(store.unhideOnActivity(activity({ unrelated: { busy: true } })), false);
  assert.deepEqual(store.get().hidden, ["quiet-session"]);
});

test("a hidden session that starts working again comes back", () => {
  const { store } = storeIn(scratchFolder());
  store.setHidden("quiet-session", true);
  assert.equal(store.unhideOnActivity(activity({ "quiet-session": { busy: true } })), true);
  assert.deepEqual(store.get().hidden, []);
  assert.equal("quiet-session" in store.get().hiddenSince, false);
});

test("a hidden session that needs an answer comes back even while it is not busy", () => {
  const { store } = storeIn(scratchFolder());
  store.setHidden("asking-session", true);
  assert.equal(store.unhideOnActivity(activity({ "asking-session": { busy: false, needsAnswer: true } })), true);
  assert.deepEqual(store.get().hidden, []);
});

test("a session hidden while busy waits for busy -> quiet -> busy before coming back", () => {
  const { store } = storeIn(scratchFolder());
  // Hidden while it was working somewhere else: the app cannot stop it.
  store.setHidden("elsewhere-session", true, true);
  assert.equal(store.get().hiddenSince["elsewhere-session"].awaitingIdle, true);

  // Still busy from the same run: not an event, it stays hidden.
  assert.equal(store.unhideOnActivity(activity({ "elsewhere-session": { busy: true } })), false);
  assert.deepEqual(store.get().hidden, ["elsewhere-session"]);

  // Seen quiet once…
  assert.equal(store.unhideOnActivity(activity({ "elsewhere-session": { busy: false } })), false);
  assert.equal(store.get().hiddenSince["elsewhere-session"].awaitingIdle, false);
  assert.deepEqual(store.get().hidden, ["elsewhere-session"]);

  // …and now busy again means somebody is working in it.
  assert.equal(store.unhideOnActivity(activity({ "elsewhere-session": { busy: true } })), true);
  assert.deepEqual(store.get().hidden, []);
});

test("a session hidden while busy still comes back at once when it needs an answer", () => {
  const { store } = storeIn(scratchFolder());
  store.setHidden("elsewhere-session", true, true);
  assert.equal(store.unhideOnActivity(activity({ "elsewhere-session": { busy: true, needsAnswer: true } })), true);
  assert.deepEqual(store.get().hidden, []);
});

test("unhiding by hand forgets the note, so hiding again starts from scratch", () => {
  const { store, storagePath } = storeIn(scratchFolder());
  store.setHidden("session-one", true, true);
  store.setHidden("session-one", false);
  assert.deepEqual(store.get().hidden, []);
  assert.equal("session-one" in store.get().hiddenSince, false);
  store.setHidden("session-one", true);
  assert.equal(store.get().hiddenSince["session-one"].awaitingIdle, false);
  assert.ok(storagePath);
});

test("a deleted session is forgotten by the groups, the hidden list and the notes", () => {
  const { store } = storeIn(scratchFolder());
  const group = store.createGroup("Blueprint");
  store.assignSession("session-one", group.id);
  store.setHidden("session-one", true, true);
  assert.equal(store.forgetSession("session-two").hidden.length, 1, "an unknown session changes nothing");
  const state = store.forgetSession("session-one");
  assert.deepEqual(state.hidden, []);
  assert.equal(state.membership["session-one"], undefined);
  assert.equal("session-one" in state.hiddenSince, false);
});

test("collapsing only accepts groups that exist, Default included", () => {
  const { store } = storeIn(scratchFolder());
  const group = store.createGroup("PRIV");
  store.setCollapsed(group.id, true);
  store.setCollapsed(DEFAULT_GROUP_ID, true);
  store.setCollapsed("no-such-group", true);
  assert.deepEqual(store.get().collapsed.sort(), [DEFAULT_GROUP_ID, group.id].sort());
  store.setCollapsed(group.id, false);
  assert.deepEqual(store.get().collapsed, [DEFAULT_GROUP_ID]);
});

test("a groups.json full of rubbish still yields a usable list", () => {
  const folder = scratchFolder();
  const { store } = storeIn(folder, {
    version: 1,
    groups: [
      { id: "keep", name: "Keep", order: 2 },
      { id: "keep", name: "Duplicate", order: 3 },
      { name: "no id at all", order: 1 },
      "not an object",
      { id: "early", name: "Early", order: 0 }
    ],
    membership: { "session-one": "keep", "session-two": "gone", "session-three": DEFAULT_GROUP_ID, "session-four": 7 },
    hidden: ["session-one", 42, null],
    collapsed: ["keep", "gone", 5]
  });
  const state = store.get();
  assert.deepEqual(groupNames(state), ["Early", "Keep", null]);
  assert.deepEqual(state.membership, { "session-one": "keep" });
  assert.deepEqual(state.hidden, ["session-one"]);
  assert.deepEqual(state.collapsed, ["keep"]);
});

test("a groups.json that is not even JSON is treated as empty", () => {
  const { store } = storeIn(scratchFolder(), "{ this is not json");
  assert.deepEqual(groupNames(store.get()), [null]);
});

test("a renamed Default keeps its id and its place at the bottom", () => {
  const { store } = storeIn(scratchFolder(), {
    version: 1,
    groups: [{ id: DEFAULT_GROUP_ID, name: "Everything else", order: 0 }, { id: "top", name: "Top", order: 1 }]
  });
  const state = store.get();
  assert.deepEqual(groupNames(state), ["Top", "Everything else"]);
  assert.equal(state.groups[1].id, DEFAULT_GROUP_ID);
});

test("everything survives a round trip through the file", async () => {
  const folder = scratchFolder();
  const first = storeIn(folder);
  const group = first.store.createGroup("Blueprint");
  first.store.assignSession("session-one", group.id);
  first.store.setHidden("session-two", true);
  first.store.setCollapsed(group.id, true);
  await waitForSave();

  const saved = JSON.parse(fs.readFileSync(first.storagePath, "utf8"));
  assert.equal(saved.version, 1);

  const reopened = createSessionGroupStore({ storagePath: first.storagePath });
  const state = reopened.get();
  assert.deepEqual(groupNames(state), ["Blueprint", null]);
  assert.equal(state.membership["session-one"], group.id);
  assert.deepEqual(state.hidden, ["session-two"]);
  assert.deepEqual(state.collapsed, [group.id]);
});

test("the state handed out is a copy, not the store's own objects", () => {
  const { store } = storeIn(scratchFolder());
  const state = store.get();
  state.groups[0].name = "tampered";
  state.hidden.push("session-one");
  assert.equal(store.get().groups[0].name, null);
  assert.deepEqual(store.get().hidden, []);
});
