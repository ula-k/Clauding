// CL-25 — the Skills tab of the side panel: what it draws
// (src/renderer/skillsList.js) and the tab itself, which is a view of the
// skills folder and is never written to panel-tabs.json
// (electron/panelTabs.js).
//
// No window and no skills folder: the model is handed plain objects, and
// the store writes into a throw-away folder under the system temporary one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSkillsList, matchesSkillSearch, skillSourceLabel, sortSkills } from "../src/renderer/skillsList.js";
import { createPanelTabStore, describeTarget } from "../electron/panelTabs.js";

function skill(name, extra = {}) {
  return {
    name,
    folder: `/Users/someone/.claude/skills/${name}`,
    filePath: `/Users/someone/.claude/skills/${name}/SKILL.md`,
    description: "",
    builtin: false,
    ...extra
  };
}

const CATALOGUE = [
  skill("zebra-notes", { description: "Keeps notes about zebras." }),
  skill("clauding-agents", { builtin: true, description: "Use the clauding command from inside a Clauding terminal." }),
  skill("anki-examples", { description: "Generate simple Chinese example sentences for Anki cards." }),
  skill("skill-maker", { builtin: true, description: "Turn a conversation into Claude Code skills." })
];

// ---- the order ----------------------------------------------------------

test("the app's own skills come first, everything else by name", () => {
  assert.deepEqual(
    sortSkills(CATALOGUE).map((entry) => entry.name),
    ["clauding-agents", "skill-maker", "anki-examples", "zebra-notes"]
  );
});

test("sorting leaves the list it was given alone", () => {
  const original = CATALOGUE.map((entry) => entry.name);
  sortSkills(CATALOGUE);
  assert.deepEqual(CATALOGUE.map((entry) => entry.name), original);
});

test("nothing at all is an empty list, not an error", () => {
  assert.deepEqual(sortSkills(null), []);
  assert.deepEqual(buildSkillsList().rows, []);
});

// ---- the search field ---------------------------------------------------

test("the search matches the name and the description, whatever the case", () => {
  const entry = skill("kanal-telegram", { description: "Rozmowa z Ulą przez Telegram z lokalnej sesji." });
  assert.equal(matchesSkillSearch(entry, "TELEGRAM"), true, "the name");
  assert.equal(matchesSkillSearch(entry, "rozmowa"), true, "the description");
  assert.equal(matchesSkillSearch(entry, "figma"), false);
});

test("an empty field matches everything", () => {
  assert.equal(matchesSkillSearch(skill("anything"), ""), true);
  assert.equal(matchesSkillSearch(skill("anything"), "   "), true);
});

test("the count says how many are shown out of how many there are", () => {
  const all = buildSkillsList({ skills: CATALOGUE });
  assert.equal(all.total, 4);
  assert.equal(all.shown, 4);
  assert.equal(all.filtered, false);

  const narrowed = buildSkillsList({ skills: CATALOGUE, query: "chinese" });
  assert.equal(narrowed.total, 4, "the total is the whole folder, not the match count");
  assert.equal(narrowed.shown, 1);
  assert.equal(narrowed.filtered, true);
  assert.deepEqual(narrowed.rows.map((entry) => entry.name), ["anki-examples"]);
});

test("a search that matches nothing still knows how many skills there are", () => {
  const nothing = buildSkillsList({ skills: CATALOGUE, query: "nothing like this" });
  assert.equal(nothing.shown, 0);
  assert.equal(nothing.total, 4);
});

// ---- where a skill comes from -------------------------------------------

test("a built-in skill says so", () => {
  assert.equal(skillSourceLabel(skill("skill-maker", { builtin: true })), "built-in");
  assert.equal(
    skillSourceLabel(skill("skill-maker", { builtin: true }), { builtinLabel: "wbudowana" }),
    "wbudowana"
  );
});

test("a skill inside a plugin is named by its plugin", () => {
  const inPlugin = skill("figma-code-connect", {
    folder: "/Users/someone/.claude/plugins/figma/skills/figma-code-connect"
  });
  assert.equal(skillSourceLabel(inPlugin), "plugin figma");
  assert.equal(skillSourceLabel(inPlugin, { pluginLabel: "wtyczka" }), "wtyczka figma");
});

test("anything else is the folder it sits in, with the home folder shortened", () => {
  assert.equal(skillSourceLabel(skill("anki-examples")), "~/.claude/skills");
  assert.equal(
    skillSourceLabel(skill("elsewhere", { folder: "/opt/shared/skills/elsewhere" })),
    "/opt/shared/skills"
  );
  assert.equal(skillSourceLabel(skill("nowhere", { folder: "" })), "");
  assert.equal(skillSourceLabel(null), "");
});

test("a Windows path is read the same way", () => {
  const onWindows = skill("scan-me", { folder: "C:\\Users\\someone\\.claude\\skills\\scan-me" });
  assert.equal(skillSourceLabel(onWindows), "~\\.claude\\skills");
});

test("every row carries the label the tab draws on its right", () => {
  const list = buildSkillsList({ skills: CATALOGUE });
  assert.deepEqual(
    list.rows.map((entry) => entry.sourceLabel),
    ["built-in", "built-in", "~/.claude/skills", "~/.claude/skills"]
  );
});

// ---- the tab itself -----------------------------------------------------

test("one skills tab per session, reused rather than opened twice", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-skills-tab-"));
  const store = createPanelTabStore({ storagePath: path.join(folder, "panel-tabs.json") });
  const first = store.openSkills("session-a");
  const second = store.openSkills("session-a");
  assert.equal(first.tabId, second.tabId);
  const state = store.get("session-a");
  assert.equal(state.tabs.filter((tab) => tab.kind === "skills").length, 1);
  assert.equal(state.activeTabId, first.tabId);
  assert.equal(state.panelVisible, true, "a catalogue nobody can see is no catalogue");
});

test("the skills tab is never written to panel-tabs.json", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-skills-tab-"));
  const storagePath = path.join(folder, "panel-tabs.json");
  const store = createPanelTabStore({ storagePath });
  const pagePath = path.join(folder, "page.html");
  fs.writeFileSync(pagePath, "<h1>page</h1>");
  store.open("session-a", describeTarget(pagePath, folder));
  store.openSkills("session-a");
  await new Promise((resolve) => setTimeout(resolve, 450));
  const saved = JSON.parse(fs.readFileSync(storagePath, "utf8"));
  const kinds = saved.sessions["session-a"].tabs.map((tab) => tab.kind);
  assert.deepEqual(kinds, ["html"], "the page is kept, the catalogue is not");
});
