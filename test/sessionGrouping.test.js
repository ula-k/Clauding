// CL-03, CL-04, CL-06 — what the left column draws: buildGroupedList() turns
// the flat session list plus the stored groups into buckets, the hidden line
// and the search result (src/renderer/sessionGrouping.js). Pure functions, no
// Electron, no files.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGroupedList,
  buildAgentSessionList,
  groupIdForSession,
  matchesSearch
} from "../src/renderer/sessionGrouping.js";
import { DEFAULT_GROUP_ID } from "../src/renderer/groupConstants.js";

function session(overrides) {
  return {
    sessionId: "session",
    title: "Untitled",
    projectName: "project",
    projectLabel: "…/projects/project",
    workingDirectoryShort: "~/Documents/projects/project",
    firstPrompt: null,
    summary: null,
    agent: null,
    statusGroup: "recent",
    needsAnswer: false,
    lastModified: 1000,
    ...overrides
  };
}

const GROUPS = [
  { id: "work", name: "Work", order: 0 },
  { id: "private", name: "PRIV", order: 1 },
  { id: DEFAULT_GROUP_ID, name: null, order: 2 }
];

function build(options) {
  return buildGroupedList({
    sessions: [],
    groups: GROUPS,
    membership: {},
    hidden: [],
    collapsed: [],
    searchText: "",
    ...options
  });
}

test("buckets come in the stored order, with Default last", () => {
  const result = build({});
  assert.deepEqual(result.buckets.map((bucket) => bucket.group.id), ["work", "private", DEFAULT_GROUP_ID]);
});

test("a session with no membership lands in Default", () => {
  assert.equal(groupIdForSession("session-one", {}, GROUPS), DEFAULT_GROUP_ID);
  assert.equal(groupIdForSession("session-one", { "session-one": "work" }, GROUPS), "work");
  assert.equal(groupIdForSession("session-one", { "session-one": "gone" }, GROUPS), DEFAULT_GROUP_ID);
});

test("inside a bucket, running sessions come first and the rest by recency", () => {
  const result = build({
    sessions: [
      session({ sessionId: "old-idle", lastModified: 10 }),
      session({ sessionId: "new-idle", lastModified: 90 }),
      session({ sessionId: "old-running", statusGroup: "running", lastModified: 5 })
    ]
  });
  const defaultBucket = result.buckets[2];
  assert.deepEqual(defaultBucket.sessions.map((entry) => entry.sessionId), ["old-running", "new-idle", "old-idle"]);
  assert.equal(result.visibleCount, 3);
});

test("hidden sessions leave the buckets and are listed apart", () => {
  const result = build({
    sessions: [
      session({ sessionId: "seen" }),
      session({ sessionId: "tucked-away", lastModified: 50 }),
      session({ sessionId: "tucked-running", statusGroup: "running", lastModified: 1 })
    ],
    hidden: ["tucked-away", "tucked-running"]
  });
  assert.deepEqual(result.buckets[2].sessions.map((entry) => entry.sessionId), ["seen"]);
  assert.deepEqual(result.hiddenSessions.map((entry) => entry.sessionId), ["tucked-running", "tucked-away"]);
  assert.equal(result.visibleCount, 1, "hidden rows do not count as visible");
});

test("a bucket reports what its rows would show, so a folded group stays honest", () => {
  const result = build({
    sessions: [
      session({ sessionId: "busy", statusGroup: "running" }),
      session({ sessionId: "blocked", needsAnswer: true })
    ],
    membership: { busy: "private", blocked: "private" },
    collapsed: ["private"]
  });
  const privateBucket = result.buckets[1];
  assert.equal(privateBucket.collapsed, true);
  assert.equal(privateBucket.sessions.length, 2, "a folded group keeps its rows, the column just does not draw them");
  assert.equal(privateBucket.hasRunning, true);
  assert.equal(privateBucket.hasNeedsAnswer, true);
  assert.equal(result.buckets[0].hasRunning, false);
});

test("search matches the title, the agent, the folder and the first prompt", () => {
  const rows = [
    session({ sessionId: "by-title", title: "Blueprint onboarding" }),
    session({ sessionId: "by-agent", agent: { id: "agent-one", name: "Spec Writer" } }),
    session({
      sessionId: "by-folder",
      projectLabel: "…/projects/langtrainer",
      workingDirectoryShort: "~/Documents/projects/langtrainer"
    }),
    session({ sessionId: "by-prompt", firstPrompt: "add example sentences to the deck" }),
    session({ sessionId: "by-summary", summary: "renaming the panel handle" }),
    session({ sessionId: "unrelated" })
  ];
  const found = (query) =>
    rows.filter((entry) => matchesSearch(entry, query)).map((entry) => entry.sessionId);
  assert.deepEqual(found("blueprint"), ["by-title"]);
  assert.deepEqual(found("spec writer"), ["by-agent"]);
  assert.deepEqual(found("langtrainer"), ["by-folder"]);
  assert.deepEqual(found("example sentences"), ["by-prompt"]);
  assert.deepEqual(found("panel handle"), ["by-summary"]);
  assert.equal(found("").length, rows.length, "an empty search hides nothing");
});

test("a match inside a folded group is shown: every group opens while searching", () => {
  const result = build({
    sessions: [session({ sessionId: "secret", title: "Blueprint onboarding" })],
    membership: { secret: "private" },
    collapsed: ["private"],
    searchText: "blueprint"
  });
  assert.equal(result.buckets[1].collapsed, false, "the chevron is ignored while a query is typed");
  assert.deepEqual(result.buckets[1].sessions.map((entry) => entry.sessionId), ["secret"]);
  assert.equal(result.visibleCount, 1);
});

test("search is case-insensitive and ignores the spaces around the query", () => {
  const rows = [session({ sessionId: "one", title: "Blueprint Onboarding" })];
  assert.equal(build({ sessions: rows, searchText: "  BLUEPRINT " }).visibleCount, 1);
  assert.equal(build({ sessions: rows, searchText: "nothing here" }).visibleCount, 0);
});

test("a hidden session stays hidden while searching", () => {
  const result = build({
    sessions: [session({ sessionId: "secret", title: "Blueprint" })],
    hidden: ["secret"],
    searchText: "blueprint"
  });
  assert.equal(result.visibleCount, 0);
  assert.deepEqual(result.hiddenSessions.map((entry) => entry.sessionId), ["secret"]);
});

test("an agent's own list counts the hidden ones apart", () => {
  const rows = [
    session({ sessionId: "linked-by-store" }),
    session({ sessionId: "linked-by-terminal", agent: { id: "agent-one", name: "Spec Writer" } }),
    session({ sessionId: "linked-but-hidden" }),
    session({ sessionId: "someone-else" })
  ];
  const result = buildAgentSessionList({
    sessions: rows,
    agentId: "agent-one",
    sessionAgents: { "linked-by-store": "agent-one", "linked-but-hidden": "agent-one", "someone-else": "agent-two" },
    hidden: ["linked-but-hidden"]
  });
  assert.deepEqual(result.sessions.map((entry) => entry.sessionId).sort(), ["linked-by-store", "linked-by-terminal"]);
  assert.equal(result.hiddenCount, 1);
});
