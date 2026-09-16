// CL-24 — when a terminal opened to do one job may be typed into
// (electron/lib/terminalKickoff.js), and what the two kickoff messages say
// (src/renderer/metaPrompts.js). Nothing is spawned here: the rules are
// checked on plain records and strings.
import test from "node:test";
import assert from "node:assert/strict";
import { hasBlockingDialog, isPromptReady, looksTypedByHand } from "../electron/lib/terminalKickoff.js";
import {
  agentStartKickoffMessage,
  createAgentKickoffMessage,
  harvestSkillsKickoffMessage
} from "../src/renderer/metaPrompts.js";

function readyRecord(overrides = {}) {
  return { sessionId: "session-one", registryStatus: "idle", exited: false, ...overrides };
}

test("the prompt counts as ready only with a session, an idle CLI and no dialog", () => {
  assert.equal(isPromptReady(readyRecord(), "› Try \"fix the tests\""), true);
  assert.equal(isPromptReady(readyRecord({ sessionId: null }), ""), false, "no session id yet");
  assert.equal(isPromptReady(readyRecord({ registryStatus: "busy" }), ""), false, "still working");
  assert.equal(isPromptReady(readyRecord({ registryStatus: null }), ""), false, "not registered yet");
  assert.equal(isPromptReady(readyRecord({ exited: true }), ""), false, "the terminal is gone");
  assert.equal(isPromptReady(null, ""), false);
});

test("a dialog waiting for an answer is never typed into", () => {
  assert.equal(hasBlockingDialog("Do you trust this folder? 1. Yes 2. No"), true);
  assert.equal(hasBlockingDialog("Do you want to proceed?"), true);
  assert.equal(hasBlockingDialog("Select login method"), true);
  assert.equal(hasBlockingDialog("Welcome back! What are we working on?"), false);
  assert.equal(isPromptReady(readyRecord(), "Do you trust this folder?"), false);
});

test("only real typing cancels a kickoff — xterm's own answers to the CLI do not", () => {
  assert.equal(looksTypedByHand("wait, do this instead"), true);
  assert.equal(looksTypedByHand("\r"), true, "Enter on its own is somebody pressing it");
  assert.equal(looksTypedByHand("[200~pasted text[201~"), true, "a paste is typing too");
  assert.equal(looksTypedByHand("[?62;c"), false, "device attributes");
  assert.equal(looksTypedByHand("[12;3R"), false, "a cursor position report");
  assert.equal(looksTypedByHand("[I"), false, "the pane telling the CLI it has focus");
  assert.equal(looksTypedByHand(""), false, "Escape alone closes a menu, it is not a message");
  assert.equal(looksTypedByHand(""), false);
});

test("both kickoff messages say where the session is and name the folder they write to", () => {
  const harvest = harvestSkillsKickoffMessage("/scratch/skills-root");
  const createAgent = createAgentKickoffMessage("/scratch/agents-root");
  for (const message of [harvest, createAgent]) {
    assert.match(message, /^You are now inside Clauding/, "a session taken over from a plain terminal is told where it is");
    assert.match(message, /clauding open/);
  }
  assert.match(harvest, /skill-maker skill over this conversation/);
  assert.match(harvest, /\/scratch\/skills-root/);
  assert.match(createAgent, /\/scratch\/agents-root\/<slug>\/<slug>\.md/);
  assert.match(createAgent, /wait for my approval/);
  assert.match(createAgent, /Do not describe the Agent Maker itself/);

  // A session that *starts* as an agent is told the same way who it is:
  // the definition itself is invisible in the system prompt.
  const agentStart = agentStartKickoffMessage("Spec Writer");
  assert.match(agentStart, /running as the agent "Spec Writer"/);
  assert.match(agentStart, /Read your definition/);
  assert.match(agentStart, /two sentences/);
  assert.match(agentStart, /wait for my instructions/);
});
