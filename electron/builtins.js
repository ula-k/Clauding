// What ships inside the app and has to exist on the user's machine before
// the two "meta" features work at all: the **Agent Maker** agent and the
// **skill-maker** skill.
//
// Both live in `builtin/` in this repository, so every copy of Clauding has
// them — an agent that makes agents is useless if each user has to write it
// first. Seeding runs once at every start:
//
//   * the agent   — added to agents.json as the FIRST agent unless one
//                   flagged `builtin: "agent-maker"` is already there. It
//                   reads its definition straight out of `builtin/`, so a
//                   new version of the app is a new definition with nothing
//                   to migrate. The user may change its emoji and color;
//                   deleting it is refused (electron/agents.js) and
//                   "Restore built-in" puts a missing one back.
//   * the skills  — copied into <skillsRoot>/<name>/SKILL.md, because
//                   Claude Code only loads skills from there. This is the
//                   ONE file the app writes under ~/.claude, so it is not
//                   written until the user has been asked: the first start
//                   shows a small sheet and the answer is remembered in
//                   settings.json (`skillMakerSeeding`). A file that is
//                   already there and byte-identical to something this app
//                   shipped is refreshed; a file the user edited is left
//                   exactly as it is and only mentioned in the log. That is
//                   the same rule preamble.md follows.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BUILTIN_SKILL_NAMES } from "./skills.js";

const electronFolder = path.dirname(fileURLToPath(import.meta.url));
const builtinFolder = path.join(electronFolder, "..", "builtin");

export const BUILTIN_AGENT_MAKER = "agent-maker";
export const BUILTIN_SETUP_AGENT = "setup";

// Everything about the built-in agent that is not the user's to change.
export const AGENT_MAKER = {
  builtin: BUILTIN_AGENT_MAKER,
  name: "Agent Maker",
  emoji: "🧬",
  definitionFolder: path.join(builtinFolder, "agents", "agent-maker"),
  definitionFile: path.join(builtinFolder, "agents", "agent-maker", "agent-maker.md"),
  extraClaudeArguments: ""
};

// The setup agent: the first thing a new user is offered ("Set up with an
// agent"), and what "+" in the Projects tab hands a new project to. It
// changes the app only through the `clauding` command, so that command is
// allowed without a question every time — and so are the few read-only
// checks its first step makes. Files it writes stay in its own working
// folder (acceptEdits only covers that folder); anything else still asks.
export const SETUP_AGENT = {
  builtin: BUILTIN_SETUP_AGENT,
  name: "Setup",
  emoji: "🧭",
  definitionFolder: path.join(builtinFolder, "agents", "setup"),
  definitionFile: path.join(builtinFolder, "agents", "setup", "setup.md"),
  // One token, no spaces: the stored flags are re-split on spaces, so a
  // quoted list would not survive agents.json. The other read-only checks
  // (claude --version, gh auth status) ask once, like any command.
  extraClaudeArguments: "--permission-mode acceptEdits --allowedTools Bash(clauding:*),Bash(which:*)"
};

// In the order they are seeded. Each new one is put above the ones already
// there, so the last in this list is the first row of the Agents tab.
export const BUILTIN_AGENTS = [AGENT_MAKER, SETUP_AGENT];

// Where a shipped skill is read from before it is copied into skillsRoot.
export function builtinSkillSource(skillName) {
  return path.join(builtinFolder, "skills", skillName, "SKILL.md");
}

// Every skill-maker text this app has ever seeded, as a SHA-256 of the exact
// bytes. A file on disk that still hashes to one of them was never touched,
// so it is replaced with the current one; anything else is the user's and
// stays. When the shipped skill changes, add the hash of the text being
// replaced here:  shasum -a 256 builtin/skills/skill-maker/SKILL.md
const PREVIOUS_BUILTIN_SKILL_HASHES = [
  // clauding-agents, before agents stopped having a color (--color went
  // from `clauding agent add`).
  "a25f50cf370dc0458286044b12e89a4c61436ffcd068abca63e20af5d8d88b2c",
  // clauding-agents, before it mentioned `clauding calendar add`.
  "6b55743ce0169473ebde8acc40ba5bdd52d3384c9e085973d2a0372ebe0615c2"
];

function hashOf(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The agent's own definition, as the store wants it. The name, folder and
// file are ours; the emoji is only a default, because the user is allowed
// to rename a built-in agent and give it another emoji.
export function builtinAgentDraft(marker = BUILTIN_AGENT_MAKER) {
  const shipped = BUILTIN_AGENTS.find((agent) => agent.builtin === marker) || AGENT_MAKER;
  return {
    name: shipped.name,
    emoji: shipped.emoji,
    definitionFolder: shipped.definitionFolder,
    definitionFile: shipped.definitionFile,
    extraClaudeArguments: shipped.extraClaudeArguments,
    builtin: shipped.builtin
  };
}

// Adds each built-in agent when agents.json has none flagged as that one;
// repairs the definition paths of one that is there but points at a folder
// this version no longer ships (the app was moved). Returns the outcome of
// the Agent Maker, as before, with every outcome under `all`.
export function seedBuiltinAgent(agentStore, log) {
  const outcomes = BUILTIN_AGENTS.map((shipped) => {
    const outcome = agentStore.ensureBuiltinAgent(builtinAgentDraft(shipped.builtin));
    if (log) {
      if (outcome.status === "added") {
        log(`[builtin] added the ${shipped.name} agent at the top of the list (${shipped.definitionFile})`);
      } else if (outcome.status === "repaired") {
        log(`[builtin] the ${shipped.name} agent pointed at a definition that is gone — put it back to ${shipped.definitionFile}`);
      }
    }
    return outcome;
  });
  return { ...outcomes[0], all: outcomes };
}

// "Restore built-in": every built-in agent back to what the app ships.
export function restoreBuiltinAgents(agentStore) {
  return BUILTIN_AGENTS.map((shipped) => agentStore.ensureBuiltinAgent(builtinAgentDraft(shipped.builtin), { force: true }));
}

// Puts <skillsRoot>/<skillName>/SKILL.md in place. Returns one of
// "created", "current", "refreshed", "kept" (the user edited it) or
// "failed" — the same vocabulary refreshStoredPreamble() uses.
export function seedBuiltinSkill(skillsRoot, skillName, log) {
  function report(line) {
    if (log) {
      log(`[builtin] ${line}`);
    }
  }
  const sourceFile = builtinSkillSource(skillName);
  let shipped = "";
  try {
    shipped = fs.readFileSync(sourceFile, "utf8");
  } catch (error) {
    report(`could not read the built-in skill at ${sourceFile}: ${error.message}`);
    return { status: "failed", skillName, filePath: null };
  }
  const targetFolder = path.join(skillsRoot, skillName);
  const targetFile = path.join(targetFolder, "SKILL.md");
  let stored = null;
  try {
    stored = fs.readFileSync(targetFile, "utf8");
  } catch (error) {
    stored = null;
  }
  if (stored === null) {
    try {
      fs.mkdirSync(targetFolder, { recursive: true });
      fs.writeFileSync(targetFile, shipped);
      report(`wrote the built-in ${skillName} skill to ${targetFile}`);
      return { status: "created", skillName, filePath: targetFile };
    } catch (writeError) {
      report(`could not write ${targetFile}: ${writeError.message}`);
      return { status: "failed", skillName, filePath: targetFile };
    }
  }
  if (stored === shipped) {
    return { status: "current", skillName, filePath: targetFile };
  }
  if (PREVIOUS_BUILTIN_SKILL_HASHES.includes(hashOf(stored))) {
    try {
      fs.writeFileSync(targetFile, shipped);
      report(`replaced the previous built-in ${skillName} in ${targetFile} with the new one`);
      return { status: "refreshed", skillName, filePath: targetFile };
    } catch (writeError) {
      report(`could not refresh ${targetFile}: ${writeError.message}`);
      return { status: "failed", skillName, filePath: targetFile };
    }
  }
  report(`${targetFile} differs from the built-in ${skillName} — left untouched (the shipped text is in ${sourceFile})`);
  return { status: "kept", skillName, filePath: targetFile };
}

// Every skill the app ships with, in one go.
export function seedBuiltinSkills(skillsRoot, log) {
  return BUILTIN_SKILL_NAMES.map((skillName) => seedBuiltinSkill(skillsRoot, skillName, log));
}

// All of them, at startup and behind "Restore built-in". `skillAnswer` is
// what settings.json remembers about the question above: only "installed"
// lets the skills be written. "Restore built-in" passes "installed" itself —
// asking for the built-ins back is an answer.
export function seedBuiltins({ agentStore, skillsRoot, log, skillAnswer = "installed" }) {
  return {
    agent: seedBuiltinAgent(agentStore, log),
    skills:
      skillAnswer === "installed"
        ? seedBuiltinSkills(skillsRoot, log)
        : BUILTIN_SKILL_NAMES.map((skillName) => ({ status: "not-asked", skillName, filePath: null }))
  };
}
