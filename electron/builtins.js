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
//                   to migrate. The user may change its emoji and colour;
//                   deleting it is refused (electron/agents.js) and
//                   "Restore built-in" puts a missing one back.
//   * the skill   — copied into <skillsRoot>/skill-maker/SKILL.md, because
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
import { BUILTIN_SKILL_NAME } from "./skills.js";

const electronFolder = path.dirname(fileURLToPath(import.meta.url));
const builtinFolder = path.join(electronFolder, "..", "builtin");

export const BUILTIN_AGENT_MAKER = "agent-maker";

// Everything about the built-in agent that is not the user's to change.
export const AGENT_MAKER = {
  builtin: BUILTIN_AGENT_MAKER,
  name: "Agent Maker",
  emoji: "🧬",
  color: "--project-color-0",
  definitionFolder: path.join(builtinFolder, "agents", "agent-maker"),
  definitionFile: path.join(builtinFolder, "agents", "agent-maker", "agent-maker.md")
};

export const SKILL_MAKER_SOURCE = path.join(builtinFolder, "skills", BUILTIN_SKILL_NAME, "SKILL.md");

// Every skill-maker text this app has ever seeded, as a SHA-256 of the exact
// bytes. A file on disk that still hashes to one of them was never touched,
// so it is replaced with the current one; anything else is the user's and
// stays. When the shipped skill changes, add the hash of the text being
// replaced here:  shasum -a 256 builtin/skills/skill-maker/SKILL.md
const PREVIOUS_BUILTIN_SKILL_HASHES = [];

function hashOf(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The agent's own definition, as the store wants it. The name, folder and
// file are ours; the emoji and the colour are only defaults, because the
// user is allowed to recolour a built-in agent.
export function builtinAgentDraft() {
  return {
    name: AGENT_MAKER.name,
    emoji: AGENT_MAKER.emoji,
    color: AGENT_MAKER.color,
    definitionFolder: AGENT_MAKER.definitionFolder,
    definitionFile: AGENT_MAKER.definitionFile,
    builtin: AGENT_MAKER.builtin
  };
}

// Adds the Agent Maker as the first agent when agents.json has none flagged
// as the built-in one; repairs the definition paths of one that is there but
// points at a folder this version no longer ships (the app was moved).
export function seedBuiltinAgent(agentStore, log) {
  const outcome = agentStore.ensureBuiltinAgent(builtinAgentDraft());
  if (log) {
    if (outcome.status === "added") {
      log(`[builtin] added the Agent Maker as the first agent (${AGENT_MAKER.definitionFile})`);
    } else if (outcome.status === "repaired") {
      log(`[builtin] the Agent Maker pointed at a definition that is gone — put it back to ${AGENT_MAKER.definitionFile}`);
    }
  }
  return outcome;
}

// Puts <skillsRoot>/skill-maker/SKILL.md in place. Returns one of
// "created", "current", "refreshed", "kept" (the user edited it) or
// "failed" — the same vocabulary refreshStoredPreamble() uses.
export function seedBuiltinSkill(skillsRoot, log) {
  function report(line) {
    if (log) {
      log(`[builtin] ${line}`);
    }
  }
  let shipped = "";
  try {
    shipped = fs.readFileSync(SKILL_MAKER_SOURCE, "utf8");
  } catch (error) {
    report(`could not read the built-in skill at ${SKILL_MAKER_SOURCE}: ${error.message}`);
    return { status: "failed", filePath: null };
  }
  const targetFolder = path.join(skillsRoot, BUILTIN_SKILL_NAME);
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
      report(`wrote the built-in skill-maker skill to ${targetFile}`);
      return { status: "created", filePath: targetFile };
    } catch (writeError) {
      report(`could not write ${targetFile}: ${writeError.message}`);
      return { status: "failed", filePath: targetFile };
    }
  }
  if (stored === shipped) {
    return { status: "current", filePath: targetFile };
  }
  if (PREVIOUS_BUILTIN_SKILL_HASHES.includes(hashOf(stored))) {
    try {
      fs.writeFileSync(targetFile, shipped);
      report(`replaced the previous built-in skill-maker in ${targetFile} with the new one`);
      return { status: "refreshed", filePath: targetFile };
    } catch (writeError) {
      report(`could not refresh ${targetFile}: ${writeError.message}`);
      return { status: "failed", filePath: targetFile };
    }
  }
  report(`${targetFile} differs from the built-in skill-maker — left untouched (the shipped text is in ${SKILL_MAKER_SOURCE})`);
  return { status: "kept", filePath: targetFile };
}

// Both of them, at startup and behind "Restore built-in". `skillAnswer` is
// what settings.json remembers about the question above: only "installed"
// lets the skill be written. "Restore built-in" passes "installed" itself —
// asking for the built-ins back is an answer.
export function seedBuiltins({ agentStore, skillsRoot, log, skillAnswer = "installed" }) {
  return {
    agent: seedBuiltinAgent(agentStore, log),
    skill: skillAnswer === "installed" ? seedBuiltinSkill(skillsRoot, log) : { status: "not-asked", filePath: null }
  };
}
