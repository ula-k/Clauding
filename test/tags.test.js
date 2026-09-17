// CL-24 — the user's own tags on a session row: the store behind them
// (electron/sessionGroups.js), what the bulk menu would do
// (src/renderer/sessionTags.js) and the search box matching a tag's label
// (src/renderer/sessionGrouping.js).
//
// Nothing here opens a window or touches the real
// ~/Library/Application Support/Clauding: every store gets its own
// groups.json in a throw-away folder under the system temporary folder.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_TAGS_PER_SESSION,
  SEEDED_TAG,
  SESSION_COLOR_TOKENS,
  TAG_LABEL_MAX_LENGTH,
  cleanTagLabel,
  createSessionGroupStore
} from "../electron/sessionGroups.js";
import {
  MAX_TAGS_PER_SESSION as RENDERER_MAX_TAGS,
  TAG_LABEL_MAX_LENGTH as RENDERER_LABEL_LIMIT,
  bulkTagPlan,
  canWearAnotherTag,
  cleanTagLabel as rendererCleanTagLabel,
  tagLabelsForSession,
  tagsForSession
} from "../src/renderer/sessionTags.js";
import { matchesSearch } from "../src/renderer/sessionGrouping.js";

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-tags-"));
}

function storeIn(savedState) {
  const storagePath = path.join(scratchFolder(), "groups.json");
  if (savedState !== undefined) {
    fs.writeFileSync(storagePath, typeof savedState === "string" ? savedState : JSON.stringify(savedState));
  }
  return createSessionGroupStore({ storagePath });
}

// ---- the shipped example -------------------------------------------------

test("a brand-new groups.json starts with the one shipped tag", () => {
  const state = storeIn().get();
  assert.deepEqual(state.tags, [{ ...SEEDED_TAG }]);
  assert.deepEqual(state.sessionTags, {});
});

test("a groups.json written before tags existed is seeded the same way", () => {
  const state = storeIn({ version: 1, groups: [], membership: {}, hidden: [] }).get();
  assert.deepEqual(state.tags, [{ ...SEEDED_TAG }]);
});

test("a catalogue the user emptied stays empty — nothing is seeded again", () => {
  const state = storeIn({ version: 1, tags: [] }).get();
  assert.deepEqual(state.tags, []);
});

test("the shipped tag is an ordinary tag: it can be renamed and deleted", () => {
  const store = storeIn();
  store.updateTag(SEEDED_TAG.id, { label: "Today", color: "--project-color-1" });
  assert.deepEqual(store.get().tags, [{ id: SEEDED_TAG.id, label: "Today", color: "--project-color-1" }]);
  store.deleteTag(SEEDED_TAG.id);
  assert.deepEqual(store.get().tags, []);
});

// ---- the label and the color --------------------------------------------

test("a label is trimmed, collapsed and cut to fifteen characters", () => {
  assert.equal(cleanTagLabel("  Finish   today  "), "Finish today");
  assert.equal(cleanTagLabel("123456789012345678"), "123456789012345");
  assert.equal(cleanTagLabel("123456789012345678").length, TAG_LABEL_MAX_LENGTH);
  assert.equal(cleanTagLabel(null), "");
});

test("the window cleans a label exactly the way the store does", () => {
  assert.equal(RENDERER_LABEL_LIMIT, TAG_LABEL_MAX_LENGTH);
  assert.equal(RENDERER_MAX_TAGS, MAX_TAGS_PER_SESSION);
  for (const text of ["  a  b ", "123456789012345678", "Finish today", ""]) {
    assert.equal(rendererCleanTagLabel(text), cleanTagLabel(text));
  }
});

test("a tag with no label at all is not made", () => {
  const store = storeIn({ version: 1, tags: [] });
  const answer = store.createTag({ label: "   ", color: "--project-color-2" });
  assert.equal(answer.tag, null);
  assert.deepEqual(answer.state.tags, []);
});

test("a color outside the palette becomes the first palette color", () => {
  const store = storeIn({ version: 1, tags: [] });
  const { tag } = store.createTag({ label: "Later", color: "#ff0000" });
  assert.equal(tag.color, SESSION_COLOR_TOKENS[0]);
});

test("a stored tag with a broken label or color is repaired or dropped", () => {
  const state = storeIn({
    version: 1,
    tags: [
      { id: "one", label: "a much too long label here", color: "#ff0000" },
      { id: "two", label: "   " },
      { id: "one", label: "duplicate id" },
      { label: "no id" }
    ]
  }).get();
  assert.deepEqual(state.tags, [{ id: "one", label: "a much too long", color: SESSION_COLOR_TOKENS[0] }]);
});

// ---- three tags per session ---------------------------------------------

test("a session wears three tags and refuses the fourth", () => {
  const store = storeIn({ version: 1, tags: [] });
  const made = ["one", "two", "three", "four"].map((label) => store.createTag({ label }).tag);
  for (const tag of made.slice(0, MAX_TAGS_PER_SESSION)) {
    const answer = store.setSessionsTag(["session-a"], tag.id, true);
    assert.deepEqual(answer.refused, []);
  }
  const refusal = store.setSessionsTag(["session-a"], made[3].id, true);
  assert.deepEqual(refusal.refused, ["session-a"]);
  assert.equal(refusal.state.sessionTags["session-a"].length, MAX_TAGS_PER_SESSION);
  assert.ok(!refusal.state.sessionTags["session-a"].includes(made[3].id));
});

test("taking a tag off never refuses, and the last one leaves no entry behind", () => {
  const store = storeIn({ version: 1, tags: [] });
  const { tag } = store.createTag({ label: "Finish today" });
  store.setSessionsTag(["session-a"], tag.id, true);
  const answer = store.setSessionsTag(["session-a"], tag.id, false);
  assert.deepEqual(answer.refused, []);
  assert.deepEqual(answer.state.sessionTags, {});
});

test("a stored session wearing four tags keeps only three, and unknown tags go", () => {
  const state = storeIn({
    version: 1,
    tags: [
      { id: "one", label: "One", color: "--project-color-1" },
      { id: "two", label: "Two", color: "--project-color-2" },
      { id: "three", label: "Three", color: "--project-color-3" },
      { id: "four", label: "Four", color: "--project-color-4" }
    ],
    sessionTags: { "session-a": ["one", "two", "three", "four"], "session-b": ["gone"], "session-c": [] }
  }).get();
  assert.deepEqual(state.sessionTags, { "session-a": ["one", "two", "three"] });
});

test("one call puts a tag on a whole selection and names who had no room", () => {
  const store = storeIn({ version: 1, tags: [] });
  const made = ["one", "two", "three", "four"].map((label) => store.createTag({ label }).tag);
  for (const tag of made.slice(0, MAX_TAGS_PER_SESSION)) {
    store.setSessionsTag(["full"], tag.id, true);
  }
  const answer = store.setSessionsTag(["full", "empty"], made[3].id, true);
  assert.deepEqual(answer.refused, ["full"]);
  assert.deepEqual(answer.state.sessionTags.empty, [made[3].id]);
});

// ---- deleting a tag, and deleting a session ------------------------------

test("deleting a tag takes it off every session at once", () => {
  const store = storeIn({ version: 1, tags: [] });
  const first = store.createTag({ label: "Finish today" }).tag;
  const second = store.createTag({ label: "Later" }).tag;
  store.setSessionsTag(["session-a", "session-b"], first.id, true);
  store.setSessionsTag(["session-a"], second.id, true);
  const state = store.deleteTag(first.id);
  assert.deepEqual(state.tags.map((tag) => tag.id), [second.id]);
  assert.deepEqual(state.sessionTags, { "session-a": [second.id] });
});

test("a deleted session is forgotten by the tags as well", () => {
  const store = storeIn({ version: 1, tags: [] });
  const { tag } = store.createTag({ label: "Finish today" });
  store.setSessionsTag(["session-a"], tag.id, true);
  const state = store.forgetSession("session-a");
  assert.deepEqual(state.sessionTags, {});
  assert.equal(state.tags.length, 1, "the catalogue itself is untouched");
});

// ---- what the window draws and what the bulk menu would do ---------------

const CATALOGUE = [
  { id: "one", label: "Finish today", color: "--project-color-4" },
  { id: "two", label: "Waiting", color: "--project-color-2" },
  { id: "three", label: "Read later", color: "--project-color-1" }
];

test("a row draws its tags in the catalogue's order, never more than three", () => {
  const sessionTags = { "session-a": ["three", "one"], "session-b": ["one", "two", "three"] };
  assert.deepEqual(
    tagsForSession("session-a", CATALOGUE, sessionTags).map((tag) => tag.label),
    ["Finish today", "Read later"]
  );
  assert.equal(tagsForSession("session-b", CATALOGUE, sessionTags).length, MAX_TAGS_PER_SESSION);
  assert.deepEqual(tagsForSession("session-c", CATALOGUE, sessionTags), []);
  assert.equal(canWearAnotherTag("session-b", sessionTags), false);
  assert.equal(canWearAnotherTag("session-a", sessionTags), true);
});

test("the bulk menu ticks a tag every picked row wears, and clicking takes it off", () => {
  const sessionTags = { "session-a": ["one"], "session-b": ["one"] };
  const plan = bulkTagPlan({ sessionIds: ["session-a", "session-b"], sessionTags, tagId: "one" });
  assert.equal(plan.state, "all");
  assert.equal(plan.applied, false);
  assert.deepEqual(plan.refused, []);
});

test("a tag only some of the picked rows wear is mixed, and clicking puts it on all", () => {
  const sessionTags = { "session-a": ["one"] };
  const plan = bulkTagPlan({ sessionIds: ["session-a", "session-b"], sessionTags, tagId: "one" });
  assert.equal(plan.state, "some");
  assert.equal(plan.applied, true);
});

test("a tag nobody in the selection wears reads as none", () => {
  const plan = bulkTagPlan({ sessionIds: ["session-a"], sessionTags: {}, tagId: "one" });
  assert.equal(plan.state, "none");
  assert.equal(plan.applied, true);
});

test("the bulk plan names the rows that already wear three tags", () => {
  const sessionTags = { full: ["one", "two", "three"], "session-b": [] };
  const plan = bulkTagPlan({ sessionIds: ["full", "session-b"], sessionTags, tagId: "four" });
  assert.equal(plan.applied, true);
  assert.deepEqual(plan.refused, ["full"]);
});

test("an empty selection asks nothing of anybody", () => {
  const plan = bulkTagPlan({ sessionIds: [], sessionTags: {}, tagId: "one" });
  assert.deepEqual(plan.sessionIds, []);
  assert.deepEqual(plan.refused, []);
});

// ---- the search box ------------------------------------------------------

test("the search box matches a tag's label as well as the name and the folder", () => {
  const session = { sessionId: "session-a", title: "Nightly build", projectLabel: "…/projects/website" };
  const labels = tagLabelsForSession("session-a", CATALOGUE, { "session-a": ["one"] });
  assert.equal(matchesSearch(session, "finish", labels), true);
  assert.equal(matchesSearch(session, "nightly", labels), true);
  assert.equal(matchesSearch(session, "waiting", labels), false);
  assert.equal(matchesSearch(session, "finish", []), false, "a session without the tag is not found by it");
});
