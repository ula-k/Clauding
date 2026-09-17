// The user's agents: a name, an emoji, and the folder a definition is
// read from. The definition folder is NOT the folder the agent works in —
// that one is picked per session in the "+ New" sheet. Saved to
// <userData>/agents.json.
//
// File shape (version 1):
//   {
//     "version": 1,
//     "agents": [
//       {
//         "id": "<uuid>",
//         "name": "Spec Writer",
//         "emoji": "✦",
//         "color": "--project-color-0",
//         "definitionFolder": "/Users/<you>/Documents/agents/spec-writer",
//         "definitionFile": "/Users/<you>/Documents/agents/spec-writer/spec-writer.md",
//         "lastWorkingDirectory": "/Users/<you>/Documents/projects/website",
//         "lastUsedAt": 1730000000000,
//         "extraClaudeArguments": "--channels plugin:telegram"
//       }
//     ],
//     "sessionAgents": { "<sessionId>": "<agentId>" }
//   }
//
// `color` is still written, and always has the same value: agents are not
// colored any more. What tells one agent from another is its emoji, which
// sits in one neutral circle wherever it is drawn, and the palette belongs
// to the sessions instead (see electron/sessionGroups.js). The key is kept
// so an agents.json written by an older version still reads, and one
// written here still opens in an older one. `sessionAgents` says which
// agent a session was started with, so the list can draw its badge long
// after the terminal is gone. Anything unexpected in the file is dropped when it is read — a
// broken agents.json must never keep the app from starting.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mergeExtraArguments } from "./lib/claudeArguments.js";

const SAVE_DEBOUNCE_MILLISECONDS = 150;
const MAXIMUM_NAME_LENGTH = 60;
const DEFINITION_PREVIEW_CHARACTERS = 20000;

export const DEFAULT_AGENT_EMOJI = "✦";

// The one value the `color` field of an agent ever has. Nothing reads it any
// more — the badge is a neutral circle — but the field stays in agents.json
// so the file keeps its shape across versions.
export const IGNORED_AGENT_COLOR = "--project-color-0";

// One emoji including its variation selector, skin tone and any ZWJ parts,
// so "👩‍💻" is taken as one character and not as three.
const EMOJI_PATTERN =
  /\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])?(?:‍\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])?)*/u;

function cleanName(rawName) {
  return String(rawName || "").replace(/\s+/g, " ").trim().slice(0, MAXIMUM_NAME_LENGTH);
}

// The emoji field is free text, but only its first whole character ever
// reaches the store: the first grapheme cluster, so "🧑‍💻" and "👩🏽‍🔬"
// stay in one piece and a pasted "✅ Test" is stored as "✅".
// src/renderer/emojiChoices.js keeps the same rule for the field itself.
function firstGrapheme(text) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const segment of segmenter.segment(text)) {
      return segment.segment;
    }
    return "";
  }
  return Array.from(text)[0] || "";
}

function cleanEmoji(rawEmoji) {
  const text = String(rawEmoji || "").trim();
  if (!text) {
    return DEFAULT_AGENT_EMOJI;
  }
  return firstGrapheme(text) || DEFAULT_AGENT_EMOJI;
}

// The marker that says an agent came with the app rather than from the
// user. Only a short slug is kept; anything else counts as "not built in".
function cleanBuiltin(rawBuiltin) {
  const marker = String(rawBuiltin || "").trim();
  return /^[a-z][a-z0-9-]{0,40}$/.test(marker) ? marker : null;
}

function cleanFolder(rawFolder) {
  const folder = String(rawFolder || "").trim();
  return folder ? path.resolve(folder) : "";
}

// The definition file always has to sit inside the definition folder: the
// form offers the folder's own .md files, and a stored path that wandered
// off (an edited agents.json) is brought back to the folder.
function cleanDefinitionFile(rawFile, definitionFolder) {
  const file = String(rawFile || "").trim();
  if (!file || !definitionFolder) {
    return "";
  }
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(definitionFolder, file);
  const relative = path.relative(definitionFolder, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "";
  }
  return resolved;
}

const MAXIMUM_EXTRA_ARGUMENTS_LENGTH = 500;

function cleanExtraArguments(rawText) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim().slice(0, MAXIMUM_EXTRA_ARGUMENTS_LENGTH);
  return mergeExtraArguments([text]).join(" ");
}

function sanitizeAgent(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) {
    return null;
  }
  const definitionFolder = cleanFolder(entry.definitionFolder);
  const definitionFile = cleanDefinitionFile(entry.definitionFile, definitionFolder);
  const name = cleanName(entry.name);
  if (!definitionFolder || !definitionFile || !name) {
    return null;
  }
  const lastWorkingDirectory = cleanFolder(entry.lastWorkingDirectory);
  return {
    id: entry.id,
    name,
    emoji: cleanEmoji(entry.emoji),
    // Kept in the file, ignored everywhere: see IGNORED_AGENT_COLOR.
    color: IGNORED_AGENT_COLOR,
    definitionFolder,
    definitionFile,
    lastWorkingDirectory: lastWorkingDirectory || null,
    // When this agent was last put to work: a session started as it, or a
    // session assigned to it. The "Assign to agent" menus show the most
    // used agents first and settle ties with this.
    lastUsedAt: Number.isFinite(entry.lastUsedAt) ? Number(entry.lastUsedAt) : null,
    // Which built-in this agent is ("agent-maker"), or null for the user's
    // own. A built-in can be recolored and renamed but never deleted, and
    // the app puts a missing one back at the next start.
    builtin: cleanBuiltin(entry.builtin),
    // Extra `claude` flags every session this agent runs gets, on top of
    // the ones in settings.json — "--channels plugin:telegram" for an agent
    // that talks to Ula on Telegram, say. Flags the app sets itself are
    // dropped here (see mergeExtraArguments).
    extraClaudeArguments: cleanExtraArguments(entry.extraClaudeArguments)
  };
}

function emptyState() {
  return { agents: [], sessionAgents: {} };
}

function sanitize(saved) {
  const state = emptyState();
  if (!saved || typeof saved !== "object") {
    return state;
  }
  const knownIds = new Set();
  if (Array.isArray(saved.agents)) {
    for (const entry of saved.agents) {
      const agent = sanitizeAgent(entry);
      if (agent && !knownIds.has(agent.id)) {
        knownIds.add(agent.id);
        state.agents.push(agent);
      }
    }
  }
  // The agents that came with the app are always at the top of the list, in
  // the order they were seeded; the user's own keep their own order under
  // them. A plain stable sort does both.
  state.agents = state.agents
    .map((agent, position) => ({ agent, position }))
    .sort((first, second) => {
      const firstIsBuiltin = first.agent.builtin ? 0 : 1;
      const secondIsBuiltin = second.agent.builtin ? 0 : 1;
      return firstIsBuiltin - secondIsBuiltin || first.position - second.position;
    })
    .map((entry) => entry.agent);
  if (saved.sessionAgents && typeof saved.sessionAgents === "object") {
    for (const [sessionId, agentId] of Object.entries(saved.sessionAgents)) {
      if (typeof agentId === "string" && knownIds.has(agentId)) {
        state.sessionAgents[sessionId] = agentId;
      }
    }
  }
  return state;
}

// The heading a definition file starts with, without the "Agent:" prefix
// definition files often use ("# Agent: Spec Writer" -> "Spec Writer").
function headingName(definitionText) {
  const headingMatch = String(definitionText || "").match(/^#\s+(.+)$/m);
  if (!headingMatch) {
    return "";
  }
  const withoutPrefix = headingMatch[1].replace(/^agent\s*[::]\s*/i, "");
  // A heading like "# 🚀 Launcher" — or "# Agent: Launcher 🚀", the form the
  // Agent Maker writes — already lends its emoji to the emoji field, so the
  // name must not carry it a second time, at either end.
  const withoutLeadingEmoji = withoutPrefix.replace(new RegExp("^" + EMOJI_PATTERN.source + "\\s*", "u"), "");
  const withoutTrailingEmoji = withoutLeadingEmoji.replace(new RegExp("\\s*" + EMOJI_PATTERN.source + "\\s*$", "u"), "");
  return cleanName(withoutTrailingEmoji);
}

function firstEmoji(definitionText) {
  const found = String(definitionText || "").slice(0, DEFINITION_PREVIEW_CHARACTERS).match(EMOJI_PATTERN);
  return found ? cleanEmoji(found[0]) : DEFAULT_AGENT_EMOJI;
}

function readTextQuietly(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return "";
  }
}

// What the "add agent" form needs the moment a folder is picked: the
// folder's own .md files, which of them is the definition (the usual
// convention is agenci/<name>/<name>.md, then README.md, then the only .md
// there is), and the name and emoji suggested from that file.
export function inspectDefinitionFolder(rawFolder) {
  const definitionFolder = cleanFolder(rawFolder);
  if (!definitionFolder) {
    return { definitionFolder: "", markdownFiles: [], definitionFile: "", name: "", emoji: DEFAULT_AGENT_EMOJI };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(definitionFolder, { withFileTypes: true });
  } catch (error) {
    entries = [];
  }
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((first, second) => first.localeCompare(second));
  const folderName = path.basename(definitionFolder).toLowerCase();
  const byFolderName = markdownFiles.find((fileName) => fileName.toLowerCase() === `${folderName}.md`);
  const readme = markdownFiles.find((fileName) => fileName.toLowerCase() === "readme.md");
  const onlyOne = markdownFiles.length === 1 ? markdownFiles[0] : null;
  const chosen = byFolderName || readme || onlyOne || markdownFiles[0] || "";
  const definitionText = chosen ? readTextQuietly(path.join(definitionFolder, chosen)) : "";
  return {
    definitionFolder,
    markdownFiles,
    definitionFile: chosen ? path.join(definitionFolder, chosen) : "",
    name: headingName(definitionText) || cleanName(path.basename(definitionFolder)),
    emoji: firstEmoji(definitionText)
  };
}

// The name and emoji a single .md file suggests, for the form's file select
// (picking another file re-fills the two fields).
export function inspectDefinitionFile(rawFile) {
  const filePath = String(rawFile || "").trim();
  if (!filePath) {
    return { definitionFile: "", name: "", emoji: DEFAULT_AGENT_EMOJI };
  }
  const definitionText = readTextQuietly(filePath);
  return {
    definitionFile: path.resolve(filePath),
    name: headingName(definitionText) || cleanName(path.basename(filePath, path.extname(filePath))),
    emoji: firstEmoji(definitionText)
  };
}

// The one block of text a terminal running as an agent gets appended to the
// CLI's system prompt: the app's own preamble first (it still runs inside
// Clauding), then who it is, then the definition itself — and, last, the one
// job this particular terminal was opened for, if it has one ("Distil THIS
// conversation into a new agent definition…"). A terminal with a task but no
// agent (Harvest skills) gets the preamble and the task alone.
export function buildAgentSystemPrompt(preamble, agent, taskPrompt) {
  const task = String(taskPrompt || "").trim();
  if (!agent) {
    return [preamble, task ? "---" : "", task].filter(Boolean).join("\n\n");
  }
  const definitionText = readTextQuietly(agent.definitionFile);
  const introduction =
    `You are running as the agent "${agent.name}". Your full definition follows; follow it. ` +
    `It lives at ${agent.definitionFile}; its folder ${agent.definitionFolder} holds your working files.`;
  return [preamble, "---", introduction, definitionText, task ? "---" : "", task]
    .filter(Boolean)
    .join("\n\n");
}

export function createAgentStore({ storagePath, onChange, log }) {
  let state = emptyState();
  let saveTimer = null;

  try {
    state = sanitize(JSON.parse(fs.readFileSync(storagePath, "utf8")));
  } catch (error) {
    state = emptyState();
  }

  function save() {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(storagePath), { recursive: true });
        fs.writeFileSync(storagePath, JSON.stringify({ version: 1, ...state }, null, 2));
      } catch (error) {
        if (log) {
          log(`[agents] could not save ${storagePath}: ${error.message}`);
        }
      }
    }, SAVE_DEBOUNCE_MILLISECONDS);
  }

  // A copy the renderer can keep; never the stored objects themselves.
  function get() {
    return {
      agents: state.agents.map((agent) => ({ ...agent })),
      sessionAgents: { ...state.sessionAgents }
    };
  }

  function announce() {
    save();
    if (onChange) {
      onChange(get());
    }
  }

  function agentById(agentId) {
    const found = state.agents.find((agent) => agent.id === agentId);
    return found ? { ...found } : null;
  }

  function addAgent(draft) {
    const agent = sanitizeAgent({ ...draft, id: randomUUID() });
    if (!agent) {
      throw new Error("An agent needs a name, a definition folder and a definition file inside it.");
    }
    state.agents.push(agent);
    announce();
    return { ...agent };
  }

  function updateAgent(agentId, draft) {
    const position = state.agents.findIndex((agent) => agent.id === agentId);
    if (position === -1) {
      return get();
    }
    const merged = sanitizeAgent({ ...state.agents[position], ...draft, id: agentId });
    if (!merged) {
      return get();
    }
    state.agents[position] = merged;
    announce();
    return get();
  }

  // Deleting an agent also drops every session's link to it: a badge in a
  // color nothing explains any more would only be noise.
  function deleteAgent(agentId) {
    const position = state.agents.findIndex((agent) => agent.id === agentId);
    if (position === -1) {
      return get();
    }
    // A built-in is part of the app, not of the user's list: the menu does
    // not offer Delete for one, and a request that gets here anyway (an
    // edited agents.json, a stale window) is ignored rather than obeyed.
    if (state.agents[position].builtin) {
      return get();
    }
    state.agents.splice(position, 1);
    for (const [sessionId, linkedAgentId] of Object.entries(state.sessionAgents)) {
      if (linkedAgentId === agentId) {
        delete state.sessionAgents[sessionId];
      }
    }
    announce();
    return get();
  }

  // The built-in agents the app ships with (see electron/builtins.js). Adds
  // the agent when agents.json has none flagged with this marker, and puts
  // its definition path back when the folder the app ships from has moved.
  // `force` is the "Restore built-in" action: name, emoji, color and paths
  // all go back to what the app ships.
  function ensureBuiltinAgent(draft, { force = false } = {}) {
    const marker = cleanBuiltin(draft && draft.builtin);
    if (!marker) {
      throw new Error("A built-in agent needs its marker.");
    }
    const position = state.agents.findIndex((agent) => agent.builtin === marker);
    if (position === -1) {
      const agent = sanitizeAgent({ ...draft, builtin: marker, id: randomUUID() });
      if (!agent) {
        throw new Error("The built-in agent definition is not readable.");
      }
      // Built-ins first, always: the list is read top down and the Agent
      // Maker is the one a new user needs before any agent of their own.
      state.agents.unshift(agent);
      announce();
      return { status: "added", agent: { ...agent } };
    }
    const existing = state.agents[position];
    const definitionMissing = !fs.existsSync(existing.definitionFile);
    if (!force && !definitionMissing) {
      return { status: "present", agent: { ...existing } };
    }
    const repaired = force
      ? { ...draft, builtin: marker }
      : { definitionFolder: draft.definitionFolder, definitionFile: draft.definitionFile };
    const merged = sanitizeAgent({ ...existing, ...repaired, id: existing.id, builtin: marker });
    if (!merged) {
      return { status: "present", agent: { ...existing } };
    }
    state.agents[position] = merged;
    announce();
    return { status: force ? "restored" : "repaired", agent: { ...merged } };
  }

  // "Assign to agent" on a session row or in the terminal header — the way
  // an older session, started long before its agent existed, is attached to
  // one. A null agent id removes the link again.
  function setSessionAgent(sessionId, agentId) {
    if (!sessionId) {
      return false;
    }
    if (!agentId) {
      if (!(sessionId in state.sessionAgents)) {
        return false;
      }
      delete state.sessionAgents[sessionId];
      announce();
      return true;
    }
    if (!state.agents.some((agent) => agent.id === agentId)) {
      return false;
    }
    if (state.sessionAgents[sessionId] === agentId) {
      return false;
    }
    state.sessionAgents[sessionId] = agentId;
    const assigned = state.agents.find((agent) => agent.id === agentId);
    if (assigned) {
      assigned.lastUsedAt = Date.now();
    }
    announce();
    return true;
  }

  // The session was deleted: the link to its agent goes with it.
  function forgetSession(sessionId) {
    if (!sessionId || !(sessionId in state.sessionAgents)) {
      return false;
    }
    delete state.sessionAgents[sessionId];
    announce();
    return true;
  }

  // Called when a terminal's CLI finally registers its session id, so the
  // row in the list can show the agent that started it.
  function linkSession(sessionId, agentId) {
    if (!sessionId || !agentId || state.sessionAgents[sessionId] === agentId) {
      return false;
    }
    if (!state.agents.some((agent) => agent.id === agentId)) {
      return false;
    }
    state.sessionAgents[sessionId] = agentId;
    announce();
    return true;
  }

  // The folder the "+ New" sheet preselects next time this agent is picked.
  function rememberWorkingDirectory(agentId, workingDirectory) {
    const agent = state.agents.find((entry) => entry.id === agentId);
    const folder = cleanFolder(workingDirectory);
    if (!agent) {
      return false;
    }
    const sameFolder = !folder || agent.lastWorkingDirectory === folder;
    if (folder) {
      agent.lastWorkingDirectory = folder;
    }
    // Starting a session as an agent is using it, whether or not the folder
    // is the same one as last time.
    agent.lastUsedAt = Date.now();
    announce();
    return !sameFolder;
  }

  // agents.json was edited outside the app (main.js watches it). Compared
  // as the renderer would see it, so the store's own saves — which write
  // the very same thing back — raise no change; an unreadable or
  // half-written file changes nothing at all.
  function reloadFromDisk() {
    let loaded = null;
    try {
      loaded = sanitize(JSON.parse(fs.readFileSync(storagePath, "utf8")));
    } catch (error) {
      return false;
    }
    if (JSON.stringify(loaded) === JSON.stringify(state)) {
      return false;
    }
    state = loaded;
    if (log) {
      log(`[agents] re-read ${storagePath} after a change on disk`);
    }
    if (onChange) {
      onChange(get());
    }
    return true;
  }

  return {
    get,
    agentById,
    addAgent,
    updateAgent,
    deleteAgent,
    ensureBuiltinAgent,
    setSessionAgent,
    forgetSession,
    linkSession,
    rememberWorkingDirectory,
    reloadFromDisk
  };
}
