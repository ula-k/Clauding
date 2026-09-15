// The skills Claude Code can load, read straight from the skills folder
// (<skillsRoot>/<name>/SKILL.md). The app never writes here except for the
// one built-in skill it seeds (see builtins.js); everything else in that
// folder was written by the user or by a session running the skill-maker.
//
// A SKILL.md starts with YAML frontmatter:
//
//   ---
//   name: skill-maker
//   description: Turn a conversation into Claude Code skills. Use when …
//   ---
//
// Only `name` and `description` are read. A file without frontmatter still
// shows up: the folder name stands in for the name and the first paragraph
// for the description, because a skill the user can see is more useful than
// a skill the list silently drops.
import fs from "node:fs";
import path from "node:path";

// The skills the app ships with (builtin/skills/<name>/SKILL.md). They are
// listed first in the Skills menu and marked as the app's own.
export const BUILTIN_SKILL_NAME = "skill-maker";
export const BUILTIN_SKILL_NAMES = [BUILTIN_SKILL_NAME, "clauding-agents"];

const DESCRIPTION_MAX_CHARACTERS = 300;
const READ_MAX_CHARACTERS = 20000;

function readTextQuietly(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, READ_MAX_CHARACTERS);
  } catch (error) {
    return "";
  }
}

function tidy(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// The frontmatter block, as plain "key: value" lines — no YAML parser for
// two fields. A value may be quoted and may run over several indented lines.
export function readFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  if (!match) {
    return {};
  }
  const fields = {};
  let currentKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (keyValue) {
      currentKey = keyValue[1].toLowerCase();
      fields[currentKey] = keyValue[2];
    } else if (currentKey && /^\s+\S/.test(line)) {
      fields[currentKey] = `${fields[currentKey]} ${line.trim()}`;
    }
  }
  for (const [key, value] of Object.entries(fields)) {
    fields[key] = tidy(value).replace(/^["']|["']$/g, "");
  }
  return fields;
}

// The first real paragraph of the body, used when there is no description.
function firstParagraph(text) {
  const body = String(text || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const cleaned = tidy(block.replace(/^#+\s*/, ""));
    if (cleaned && !cleaned.startsWith("#")) {
      return cleaned;
    }
  }
  return "";
}

function describeSkill(folderPath) {
  const filePath = path.join(folderPath, "SKILL.md");
  const text = readTextQuietly(filePath);
  const fields = readFrontmatter(text);
  const folderName = path.basename(folderPath);
  const description = fields.description || firstParagraph(text);
  return {
    name: fields.name || folderName,
    folderName,
    description: description.slice(0, DESCRIPTION_MAX_CHARACTERS),
    folder: folderPath,
    filePath,
    builtin: BUILTIN_SKILL_NAMES.includes(folderName)
  };
}

// Every <skillsRoot>/<folder>/SKILL.md, the built-in ones first and
// the rest by name. Read from disk on every call: the list is short, a
// session can write a new skill at any moment, and a stale menu would be
// worse than the read.
export function listSkills(skillsRoot) {
  const root = String(skillsRoot || "").trim();
  if (!root) {
    return [];
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const folderPath = path.join(root, entry.name);
    if (!fs.existsSync(path.join(folderPath, "SKILL.md"))) {
      continue;
    }
    skills.push(describeSkill(folderPath));
  }
  skills.sort((first, second) => {
    if (first.builtin !== second.builtin) {
      return first.builtin ? -1 : 1;
    }
    return first.name.localeCompare(second.name);
  });
  return skills;
}
