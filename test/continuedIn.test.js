// A session Claude Code sent to the background goes on under a new id, and
// its old transcript ends in a `continued-in` line (electron/lib/continuedIn.js).
// The list, every id-keyed store and the resume follow the new id; a resume of
// a session alive in the CLI's background daemon attaches to it
// (electron/lib/openGuard.js).
//
// Dry: temporary files only, no Electron, no SDK call, no `claude`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adoptedSessionId,
  attachArguments,
  carryKeyedValue,
  carryListedId,
  continuationFromTail,
  followContinuations,
  isAliveInBackground
} from "../electron/lib/continuedIn.js";
import { conversationGuardInput, resumeOpenDecision } from "../electron/lib/openGuard.js";
import { DISABLE_AGENT_VIEW_VARIABLE, buildTerminalEnvironment } from "../electron/lib/claudeArguments.js";
import { collectLiveStatusFrom } from "../electron/lib/liveStatusCore.js";
import { createAgentStore } from "../electron/agents.js";
import { createSessionGroupStore } from "../electron/sessionGroups.js";
import { createSessionFlagsStore } from "../electron/sessionFlags.js";
import { createOpenTerminalsStore } from "../electron/openTerminals.js";
import { openPlanForSession } from "../src/renderer/sessionLookup.js";

const OLD_ID = "11111111-2222-4333-8444-555555555555";
const NEW_ID = "66666666-7777-4888-8999-000000000000";

function line(entry) {
  return JSON.stringify(entry);
}

const CONTINUED_TAIL = [
  'h":"cut in half by the tail read"}',
  line({ type: "assistant", sessionId: OLD_ID, message: { role: "assistant", content: [] } }),
  line({ type: "system", subtype: "informational", content: "Backgrounding after the current tool finishes…" }),
  line({ type: "cost-state", sessionId: OLD_ID }),
  line({ type: "continued-in", sessionId: OLD_ID, continuedInSessionId: NEW_ID }),
  line({ type: "last-prompt", lastPrompt: "…", sessionId: OLD_ID }),
  line({ type: "cost-state", sessionId: OLD_ID }),
  ""
].join("\n");

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-continued-in-"));
}

function waitForSave() {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

test("a transcript that ends in continued-in names its continuation", () => {
  assert.equal(continuationFromTail(CONTINUED_TAIL), NEW_ID);
});

test("a conversation that went on in the old file afterwards is its own session again", () => {
  const resumedAfterwards = CONTINUED_TAIL + line({ type: "user", sessionId: OLD_ID, message: { role: "user", content: "hi" } }) + "\n";
  assert.equal(continuationFromTail(resumedAfterwards), null);
  assert.equal(continuationFromTail(line({ type: "user" })), null);
  assert.equal(continuationFromTail(""), null);
  assert.equal(
    continuationFromTail(line({ type: "continued-in", continuedInSessionId: "../../etc/passwd" })),
    null,
    "an id that is not an id is not followed"
  );
});

test("continuations are followed to the end, never in a circle, only to transcripts that exist", () => {
  const chain = { first: "second", second: "third", third: null };
  assert.equal(followContinuations("first", { readContinuation: (sessionId) => chain[sessionId] }), "third");
  const circle = { one: "two", two: "one" };
  assert.equal(followContinuations("one", { readContinuation: (sessionId) => circle[sessionId] }), "two");
  assert.equal(
    followContinuations("first", { readContinuation: (sessionId) => chain[sessionId], transcriptExists: (sessionId) => sessionId !== "third" }),
    "second"
  );
  assert.equal(followContinuations("alone", { readContinuation: () => null }), "alone");
});

test("a keyed value and a listed id move to the continuation, unless it has its own", () => {
  const original = { [OLD_ID]: "builder", other: "kevin" };
  const carried = carryKeyedValue(original, OLD_ID, NEW_ID);
  assert.deepEqual(carried, { other: "kevin", [NEW_ID]: "builder" });
  assert.deepEqual(original, { [OLD_ID]: "builder", other: "kevin" }, "the input is left alone");
  assert.deepEqual(carryKeyedValue({ [OLD_ID]: "builder", [NEW_ID]: "mine" }, OLD_ID, NEW_ID), { [NEW_ID]: "mine" });
  assert.equal(carryKeyedValue(original, "absent", NEW_ID), original);
  assert.deepEqual(carryListedId([OLD_ID, "other", NEW_ID], OLD_ID, NEW_ID), [NEW_ID, "other"]);
});

test("a resume of a session alive in the background daemon attaches, a plain one elsewhere is refused", () => {
  const backgroundEntry = { sessionId: NEW_ID, pid: 36926, alive: true, kind: "bg" };
  assert.deepEqual(resumeOpenDecision({ sessionId: NEW_ID, registryEntries: [backgroundEntry] }), { action: "attach", pid: 36926 });
  assert.equal(isAliveInBackground([backgroundEntry], NEW_ID), true);
  assert.deepEqual(attachArguments(NEW_ID), ["--resume", NEW_ID], "nothing that would make the CLI refuse to attach");
  const terminalAppEntry = { sessionId: OLD_ID, pid: 4242, alive: true, kind: "interactive" };
  assert.equal(resumeOpenDecision({ sessionId: OLD_ID, registryEntries: [terminalAppEntry] }).action, "refuse");
  assert.equal(isAliveInBackground([{ ...backgroundEntry, alive: false }], NEW_ID), false);
});

test("the row of a background session resumes (attaches) on a click instead of only being shown", () => {
  const status = collectLiveStatusFrom({
    processEntries: [{ sessionId: NEW_ID, pid: 36926, kind: "bg", rawStatus: "idle", workingDirectory: "/Users/someone" }]
  }).get(NEW_ID);
  assert.equal(status.kind, "bg");
  const row = { sessionId: NEW_ID, workingDirectory: "/Users/someone", folderMissing: false, liveStatus: status };
  assert.equal(openPlanForSession(row), "resume");
  assert.equal(openPlanForSession({ ...row, liveStatus: { ...status, kind: null } }), "elsewhere");
});

test("the agent link follows the continuation and is saved", async () => {
  const folder = scratchFolder();
  const definitionFolder = path.join(folder, "builder");
  fs.mkdirSync(definitionFolder);
  fs.writeFileSync(path.join(definitionFolder, "builder.md"), "# Agent: Builder\n");
  const storagePath = path.join(folder, "agents.json");
  const store = createAgentStore({ storagePath });
  const builder = store.addAgent({ name: "Builder", definitionFolder, definitionFile: path.join(definitionFolder, "builder.md") });
  store.setSessionAgent(OLD_ID, builder.id);
  assert.equal(store.carrySession(OLD_ID, NEW_ID), true);
  assert.equal(store.get().sessionAgents[NEW_ID], builder.id);
  assert.equal(OLD_ID in store.get().sessionAgents, false);
  assert.equal(store.carrySession(OLD_ID, NEW_ID), false, "a second time changes nothing");
  await waitForSave();
  assert.equal(JSON.parse(fs.readFileSync(storagePath, "utf8")).sessionAgents[NEW_ID], builder.id);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("the group, color, tags and hiding follow the continuation", () => {
  const folder = scratchFolder();
  const store = createSessionGroupStore({ storagePath: path.join(folder, "groups.json") });
  const group = store.createGroup("Work");
  store.assignSession(OLD_ID, group.id);
  store.setSessionColor(OLD_ID, "--project-color-2");
  const { tag } = store.createTag({ label: "research" });
  store.setSessionsTag([OLD_ID], tag.id, true);
  assert.equal(store.carrySession(OLD_ID, NEW_ID), true);
  const state = store.get();
  assert.equal(state.membership[NEW_ID], group.id);
  assert.equal(state.colors[NEW_ID], "--project-color-2");
  assert.deepEqual(state.sessionTags[NEW_ID], [tag.id]);
  assert.equal(OLD_ID in state.membership || OLD_ID in state.colors || OLD_ID in state.sessionTags, false);
  assert.equal(store.carrySession(OLD_ID, NEW_ID), false);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("the extra flags follow the continuation", () => {
  const folder = scratchFolder();
  const store = createSessionFlagsStore({ storagePath: path.join(folder, "session-flags.json") });
  store.remember(OLD_ID, "--channels plugin:telegram@official");
  assert.equal(store.carry(OLD_ID, NEW_ID), true);
  assert.equal(store.flagsFor(NEW_ID), "--channels plugin:telegram@official");
  assert.equal(store.flagsFor(OLD_ID), "");
  fs.rmSync(folder, { recursive: true, force: true });
});

test("the 'was open' offer is the continuation, never the stale copy, and the file says so", () => {
  const folder = scratchFolder();
  const filePath = path.join(folder, "open-terminals.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 1, terminals: [{ sessionId: OLD_ID, workingDirectory: folder, agentId: "builder", extraArguments: "", selected: true }] })
  );
  const store = createOpenTerminalsStore({ filePath });
  assert.equal(store.carry(OLD_ID, NEW_ID), true);
  assert.equal(store.restoreOffer().selectedSessionId, NEW_ID);
  assert.equal(store.offeredBySession().get(NEW_ID).agentId, "builder");
  assert.equal(store.offeredBySession().has(OLD_ID), false);
  const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(written.terminals.map((entry) => entry.sessionId), [NEW_ID]);
  fs.rmSync(folder, { recursive: true, force: true });
});

// The four copies: `claude --resume <old>` was started four times, each one
// ran and registered the continuation, so the registry named NEW_ID for every
// pid while the app kept looking for OLD_ID.
const CHAIN = { [OLD_ID]: NEW_ID };
const followChain = (sessionId) => CHAIN[sessionId] || sessionId;

function guardFor(sessionId, records, registryEntries) {
  const target = followChain(sessionId);
  return resumeOpenDecision(
    conversationGuardInput({ sessionId: target, records, registryEntries, resolveContinuation: followChain })
  );
}

test("a terminal adopts the id the registry reports for its own pid, and the stores follow", () => {
  assert.deepEqual(
    adoptedSessionId({ trackedSessionId: OLD_ID, registeredSessionId: NEW_ID, resolveContinuation: followChain }),
    { sessionId: NEW_ID, carryFrom: OLD_ID }
  );
  // The registry still naming the old id: the continuation is what is shown.
  assert.deepEqual(
    adoptedSessionId({ trackedSessionId: OLD_ID, registeredSessionId: OLD_ID, resolveContinuation: followChain }),
    { sessionId: NEW_ID, carryFrom: OLD_ID }
  );
  assert.deepEqual(adoptedSessionId({ trackedSessionId: NEW_ID, registeredSessionId: OLD_ID, resolveContinuation: followChain }), {
    sessionId: NEW_ID,
    carryFrom: null
  });
  // A brand new session and a fork's new id link without carrying anything.
  assert.deepEqual(adoptedSessionId({ trackedSessionId: null, registeredSessionId: "fresh" }), { sessionId: "fresh", carryFrom: null });
  assert.deepEqual(adoptedSessionId({ trackedSessionId: OLD_ID, registeredSessionId: "copy", isFork: true }), {
    sessionId: "copy",
    carryFrom: null
  });
});

test("four copies: a terminal already showing the conversation is shown, whichever id is clicked", () => {
  // Spawned with --resume OLD_ID, not linked yet (the registry entry comes later).
  const justStarted = { terminalId: "first", pid: 77782, sessionId: OLD_ID, resumeSessionId: OLD_ID };
  for (const clicked of [OLD_ID, NEW_ID]) {
    assert.deepEqual(guardFor(clicked, [justStarted], []), { action: "show", terminalId: "first" });
  }
  // Linked: the record says NEW_ID, the row clicked says OLD_ID.
  const linked = { ...justStarted, sessionId: NEW_ID };
  assert.deepEqual(guardFor(OLD_ID, [linked], []), { action: "show", terminalId: "first" });
});

test("four copies: a registry entry naming the continuation for another pid refuses a second writer", () => {
  const registry = [{ sessionId: NEW_ID, pid: 78720, alive: true, kind: "interactive" }];
  for (const clicked of [OLD_ID, NEW_ID]) {
    assert.equal(guardFor(clicked, [], registry).action, "refuse");
  }
  // The same conversation alive in the background daemon is attached to.
  assert.deepEqual(guardFor(OLD_ID, [], [{ sessionId: NEW_ID, pid: 36926, alive: true, kind: "bg" }]), {
    action: "attach",
    pid: 36926
  });
  // A fork of the conversation is not its owner: the fork has its own id.
  const fork = { terminalId: "fork", pid: 1, sessionId: "copy", resumeSessionId: OLD_ID, forkedFromSessionId: OLD_ID };
  assert.deepEqual(guardFor(OLD_ID, [fork], []), { action: "spawn" });
});

test("every claude the app starts has the CLI's agent view off", () => {
  const environment = buildTerminalEnvironment({ baseEnvironment: { PATH: "/usr/bin" }, terminalId: "terminal-1" });
  assert.equal(environment[DISABLE_AGENT_VIEW_VARIABLE], "1");
  assert.equal(DISABLE_AGENT_VIEW_VARIABLE, "CLAUDE_CODE_DISABLE_AGENT_VIEW");
  // Attaching to a session already in the daemon: the CLI refuses with the
  // variable set (checked against a real background session, CLI 2.1.292).
  const attaching = buildTerminalEnvironment({
    baseEnvironment: { PATH: "/usr/bin", [DISABLE_AGENT_VIEW_VARIABLE]: "1" },
    terminalId: "terminal-2",
    attachToBackground: true
  });
  assert.equal(DISABLE_AGENT_VIEW_VARIABLE in attaching, false);
});
