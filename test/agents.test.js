// CL-15 — the agents store and what a definition folder suggests
// (electron/agents.js). Definition folders are written into a throw-away
// folder under the system temporary folder, agents.json lives there too, and
// no session is ever started.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_COLOR_TOKENS,
  DEFAULT_AGENT_COLOR,
  DEFAULT_AGENT_EMOJI,
  buildAgentSystemPrompt,
  createAgentStore,
  inspectDefinitionFile,
  inspectDefinitionFolder
} from "../electron/agents.js";

const SAVE_WAIT_MILLISECONDS = 400;

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-agents-"));
}

// A definition folder with the given files: { "spec-writer.md": "# Agent: …" }
function definitionFolderWith(folderName, files) {
  const folder = path.join(scratchFolder(), folderName);
  fs.mkdirSync(folder, { recursive: true });
  for (const [fileName, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(folder, fileName), text);
  }
  return folder;
}

function storeIn(folder, savedState) {
  const storagePath = path.join(folder, "agents.json");
  if (savedState !== undefined) {
    fs.writeFileSync(storagePath, typeof savedState === "string" ? savedState : JSON.stringify(savedState));
  }
  return { storagePath, store: createAgentStore({ storagePath }) };
}

function waitForSave() {
  return new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MILLISECONDS));
}

test("a definition folder suggests the file named after it, then README, then the only one", () => {
  const byFolderName = definitionFolderWith("spec-writer", {
    "spec-writer.md": "# Agent: Spec Writer\n",
    "README.md": "# Readme\n",
    "notes.md": "# Notes\n"
  });
  assert.equal(path.basename(inspectDefinitionFolder(byFolderName).definitionFile), "spec-writer.md");

  const withReadme = definitionFolderWith("something-else", {
    "README.md": "# Readme agent\n",
    "notes.md": "# Notes\n"
  });
  assert.equal(path.basename(inspectDefinitionFolder(withReadme).definitionFile), "README.md");

  const onlyOne = definitionFolderWith("lonely", { "whatever.md": "# The only one\n" });
  assert.equal(path.basename(inspectDefinitionFolder(onlyOne).definitionFile), "whatever.md");

  const empty = definitionFolderWith("empty", {});
  const inspected = inspectDefinitionFolder(empty);
  assert.equal(inspected.definitionFile, "");
  assert.deepEqual(inspected.markdownFiles, []);
  assert.equal(inspected.name, "empty", "with no file to read, the folder's own name is the suggestion");
  assert.equal(inspected.emoji, DEFAULT_AGENT_EMOJI);
});

test("the folder lists only its own markdown files, sorted", () => {
  const folder = definitionFolderWith("mixed", {
    "zebra.md": "# Zebra\n",
    "alpha.MD": "# Alpha\n",
    "readme.txt": "not markdown",
    "picture.png": "not markdown"
  });
  assert.deepEqual(inspectDefinitionFolder(folder).markdownFiles, ["alpha.MD", "zebra.md"]);
});

test("the name comes from the first heading, without the Agent prefix", () => {
  const folder = definitionFolderWith("spec-writer", {
    "spec-writer.md": "Some preamble\n\n# Agent: Spec Writer\n\nYou write specs.\n"
  });
  const inspected = inspectDefinitionFolder(folder);
  assert.equal(inspected.name, "Spec Writer");

  const plainHeading = definitionFolderWith("plain", { "plain.md": "# Template Keeper\n" });
  assert.equal(inspectDefinitionFolder(plainHeading).name, "Template Keeper");

  const noHeading = definitionFolderWith("no-heading", { "no-heading.md": "just text\n" });
  assert.equal(inspectDefinitionFolder(noHeading).name, "no-heading", "the folder name is the fallback");
});

test("the emoji comes from the first whole emoji in the definition", () => {
  const folder = definitionFolderWith("scribe", { "scribe.md": "# 📐 Scribe\n\nHe measures 🧪 things.\n" });
  assert.equal(inspectDefinitionFolder(folder).emoji, "📐");

  const composed = definitionFolderWith("dev", { "dev.md": "# 🧑‍💻 Developer\n" });
  assert.equal(inspectDefinitionFolder(composed).emoji, "🧑‍💻", "a joined emoji stays whole");

  const none = definitionFolderWith("plain", { "plain.md": "# Plain\n" });
  assert.equal(inspectDefinitionFolder(none).emoji, DEFAULT_AGENT_EMOJI);
});

test("a single definition file suggests the same name and emoji", () => {
  const folder = definitionFolderWith("spec-writer", { "other.md": "# Launcher\n\nShips things 🚀.\n" });
  const inspected = inspectDefinitionFile(path.join(folder, "other.md"));
  assert.equal(inspected.name, "Launcher");
  assert.equal(inspected.emoji, "🚀");
  assert.equal(inspectDefinitionFile("").definitionFile, "");
  const missing = inspectDefinitionFile(path.join(folder, "gone.md"));
  assert.equal(missing.name, "gone", "an unreadable file still names itself");
});

// Known problem (CL-15): a heading that starts with an emoji suggests that
// emoji in the emoji field AND leaves it at the front of the suggested name,
// so an agent added straight from the suggestions wears its emoji twice —
// once in its circle, once in its name. The app is not changed here; the
// expectation below is what the form should suggest.
test("the suggested name does not repeat the emoji the heading starts with", () => {
  const folder = definitionFolderWith("launcher", { "launcher.md": "# 🚀 Launcher\n" });
  const inspected = inspectDefinitionFolder(folder);
  assert.equal(inspected.emoji, "🚀");
  assert.equal(inspected.name, "Launcher");
});

test("an agent needs a name, a folder and a file inside that folder", () => {
  const folder = definitionFolderWith("spec-writer", { "spec-writer.md": "# Agent: Spec Writer\n" });
  const { store } = storeIn(scratchFolder());
  assert.throws(
    () => store.addAgent({ name: "", definitionFolder: folder, definitionFile: path.join(folder, "spec-writer.md") }),
    /name/i
  );
  assert.throws(() => store.addAgent({ name: "Nameless folder", definitionFolder: "", definitionFile: "" }), /name/i);
  assert.throws(
    () =>
      store.addAgent({
        name: "Outside",
        definitionFolder: folder,
        definitionFile: path.join(folder, "..", "elsewhere.md")
      }),
    /definition/i
  );
});

test("a definition file given by its bare name is resolved inside the folder", () => {
  const folder = definitionFolderWith("spec-writer", { "spec-writer.md": "# Agent: Spec Writer\n" });
  const { store } = storeIn(scratchFolder());
  const agent = store.addAgent({
    name: "Spec Writer",
    definitionFolder: folder,
    definitionFile: "spec-writer.md"
  });
  assert.equal(agent.definitionFile, path.join(folder, "spec-writer.md"));
});

test("the emoji is cut to one whole character and the colour must be a palette token", () => {
  const folder = definitionFolderWith("spec-writer", { "spec-writer.md": "# Agent: Spec Writer\n" });
  const { store } = storeIn(scratchFolder());
  const draft = { name: "Spec Writer", definitionFolder: folder, definitionFile: "spec-writer.md" };

  assert.equal(store.addAgent({ ...draft, emoji: "✅ Test" }).emoji, "✅");
  assert.equal(store.addAgent({ ...draft, emoji: "  🧑‍💻 dev  " }).emoji, "🧑‍💻");
  assert.equal(store.addAgent({ ...draft, emoji: "" }).emoji, DEFAULT_AGENT_EMOJI);
  assert.equal(store.addAgent({ ...draft, color: "#ff0000" }).color, DEFAULT_AGENT_COLOR);
  assert.equal(store.addAgent({ ...draft, color: AGENT_COLOR_TOKENS[3] }).color, AGENT_COLOR_TOKENS[3]);
});

test("deleting an agent takes every session link with it", () => {
  const folder = definitionFolderWith("spec-writer", { "spec-writer.md": "# Agent: Spec Writer\n" });
  const { store } = storeIn(scratchFolder());
  const first = store.addAgent({ name: "First", definitionFolder: folder, definitionFile: "spec-writer.md" });
  const second = store.addAgent({ name: "Second", definitionFolder: folder, definitionFile: "spec-writer.md" });
  store.linkSession("session-one", first.id);
  store.linkSession("session-two", second.id);
  assert.equal(store.linkSession("session-three", "no-such-agent"), false);

  store.deleteAgent(first.id);
  const state = store.get();
  assert.equal(state.agents.length, 1);
  assert.equal(state.sessionAgents["session-one"], undefined);
  assert.equal(state.sessionAgents["session-two"], second.id);
});

test("a link to a session with no transcript is kept, not treated as broken", async () => {
  const folder = definitionFolderWith("spec-writer", { "spec-writer.md": "# Agent: Spec Writer\n" });
  const first = storeIn(scratchFolder());
  const agent = first.store.addAgent({ name: "Spec Writer", definitionFolder: folder, definitionFile: "spec-writer.md" });
  // A terminal closed before its first message leaves a link but no
  // conversation on disk; the store must not mind.
  first.store.linkSession("session-that-never-wrote-anything", agent.id);
  await waitForSave();

  const reopened = createAgentStore({ storagePath: first.storagePath });
  assert.equal(reopened.get().sessionAgents["session-that-never-wrote-anything"], agent.id);
});

test("an agents.json full of rubbish still gives a usable Agents tab", () => {
  const folder = definitionFolderWith("spec-writer", { "spec-writer.md": "# Agent: Spec Writer\n" });
  const { store } = storeIn(scratchFolder(), {
    version: 1,
    agents: [
      { id: "good", name: "Good", definitionFolder: folder, definitionFile: "spec-writer.md", color: "not a token" },
      { id: "good", name: "Duplicate id", definitionFolder: folder, definitionFile: "spec-writer.md" },
      { name: "No id", definitionFolder: folder, definitionFile: "spec-writer.md" },
      { id: "no-folder", name: "No folder" },
      { id: "outside", name: "Outside", definitionFolder: folder, definitionFile: "/etc/hosts" },
      "not an object",
      null
    ],
    sessionAgents: { "session-one": "good", "session-two": "gone", "session-three": 7 }
  });
  const state = store.get();
  assert.deepEqual(state.agents.map((agent) => agent.name), ["Good"]);
  assert.equal(state.agents[0].color, DEFAULT_AGENT_COLOR);
  assert.deepEqual(state.sessionAgents, { "session-one": "good" });
});

test("an agents.json that is not even JSON is treated as empty", () => {
  const { store } = storeIn(scratchFolder(), "{ not json at all");
  assert.deepEqual(store.get().agents, []);
});

test("the appended prompt carries the preamble, who the agent is and the whole definition", () => {
  const folder = definitionFolderWith("spec-writer", {
    "spec-writer.md": "# Agent: Spec Writer\n\nYou write specs and nothing else.\n"
  });
  const agent = {
    id: "agent-one",
    name: "Spec Writer",
    emoji: "📐",
    definitionFolder: folder,
    definitionFile: path.join(folder, "spec-writer.md")
  };
  const prompt = buildAgentSystemPrompt("PREAMBLE TEXT", agent);
  assert.ok(prompt.startsWith("PREAMBLE TEXT"), "the preamble comes first");
  assert.ok(prompt.includes('You are running as the agent "Spec Writer"'));
  assert.ok(prompt.includes(agent.definitionFile), "the agent is told where its definition lives");
  assert.ok(prompt.includes(folder), "and which folder holds its working files");
  assert.ok(prompt.includes("You write specs and nothing else."), "the definition itself is appended");
});

test("the working folder of an agent is remembered once, not on every start", () => {
  const folder = definitionFolderWith("spec-writer", { "spec-writer.md": "# Agent: Spec Writer\n" });
  const { store } = storeIn(scratchFolder());
  const agent = store.addAgent({ name: "Spec Writer", definitionFolder: folder, definitionFile: "spec-writer.md" });
  assert.equal(agent.lastWorkingDirectory, null);
  assert.equal(store.rememberWorkingDirectory(agent.id, "/Users/someone/Documents/projects/website"), true);
  assert.equal(store.rememberWorkingDirectory(agent.id, "/Users/someone/Documents/projects/website"), false);
  assert.equal(store.agentById(agent.id).lastWorkingDirectory, "/Users/someone/Documents/projects/website");
  assert.equal(store.agentById("no-such-agent"), null);
});
