// What the Skills tab in the side panel draws: the skills on this Mac, in
// the order they are listed, narrowed by what is typed in the search field,
// and where each one comes from.
//
// Pure on purpose — no window, no file system — so the ordering, the filter
// and the source labels can be read (and tested) on their own. The reading
// of the folders themselves is electron/skills.js.
import { shortenHomeFolder } from "./paths.js";

// The order: the app's own skills first, then everything else by name, so
// the two that ship with Clauding are always where they were and a folder
// full of skills is alphabetical under them. `localeCompare` because the
// names are in several languages.
export function sortSkills(skills) {
  return (skills || []).slice().sort((first, second) => {
    if (Boolean(first.builtin) !== Boolean(second.builtin)) {
      return first.builtin ? -1 : 1;
    }
    return String(first.name || "").localeCompare(String(second.name || ""));
  });
}

// Where a skill lives, as the short line on the right of its row:
//
//   built-in            one of the two the app ships
//   plugin <name>       under …/plugins/<name>/…, wherever that plugin is
//   ~/.claude/skills    the folder it sits in, with the home folder shortened
//
// The two labels are handed in because they are translated.
export function skillSourceLabel(skill, { builtinLabel = "built-in", pluginLabel = "plugin" } = {}) {
  if (!skill) {
    return "";
  }
  if (skill.builtin) {
    return builtinLabel;
  }
  const folder = String(skill.folder || "");
  const plugin = /[\\/]plugins[\\/]([^\\/]+)[\\/]/.exec(folder);
  if (plugin) {
    return `${pluginLabel} ${plugin[1]}`;
  }
  const parent = folder.replace(/[\\/][^\\/]*$/, "");
  return parent ? shortenHomeFolder(parent) : "";
}

// The search field matches the **name and the description**, in one pass,
// case-insensitively — that is the whole filter, because a skill is chosen
// by what it says it is for as often as by its name.
export function matchesSkillSearch(skill, query) {
  const wanted = String(query || "").trim().toLowerCase();
  if (!wanted) {
    return true;
  }
  return `${skill.name || ""} ${skill.description || ""}`.toLowerCase().includes(wanted);
}

// Everything the tab needs at once: the rows to draw, how many skills there
// are altogether, and how many the search left — the count line says "31"
// with an empty field and "2 of 31" with something typed in it.
export function buildSkillsList({ skills, query = "", sourceOptions = {} } = {}) {
  const all = sortSkills(skills);
  const filtered = all.filter((skill) => matchesSkillSearch(skill, query));
  return {
    rows: filtered.map((skill) => ({ ...skill, sourceLabel: skillSourceLabel(skill, sourceOptions) })),
    total: all.length,
    shown: filtered.length,
    filtered: String(query || "").trim().length > 0
  };
}
