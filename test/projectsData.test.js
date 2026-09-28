// CL-26 — the Projects view's data layer: ClickUp statuses → buckets, the
// ClickUp client (fake fetch, never the network), git branches in a
// throw-away repository, gh's JSON, linking sessions to tasks, the pipeline
// stages, the numbers on top, one whole project snapshot, and the store.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BUCKETS, SPEC_STAGES, bucketForStatus, specStageForStatus } from "../electron/lib/statusBuckets.js";
import {
  createClickupClient,
  dependsOnFrom,
  mapTask,
  readClickupToken,
  specUrlFrom,
  taskIdFromLink
} from "../electron/lib/clickupClient.js";
import { inspectRepository, parseBranchRefs, parseWorktrees, taskIdFromBranch } from "../electron/lib/gitInspector.js";
import { ciStateFrom, pullRequestsByTask } from "../electron/lib/pullRequests.js";
import { linkSessionsToTasks, roleForAgent, taskIdsMentionedIn } from "../electron/lib/taskLinker.js";
import { buildStage, specStage, whatNeedsUser } from "../electron/lib/pipelineStage.js";
import { dailyPace, deadlineTimeline, pace, peopleBreakdown, workDaysBetween } from "../electron/lib/projectStats.js";
import { buildProjectSnapshot } from "../electron/lib/projectSnapshot.js";
import { createProjectBoardStore, readBoardsFile } from "../electron/projectBoards.js";

const DAY = 24 * 60 * 60 * 1000;
// Monday 2026-09-28, noon local time.
const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();

// ---- statuses --------------------------------------------------------------

test("Typical ClickUp statuses land in the right bucket", () => {
  const expected = {
    Open: BUCKETS.open,
    "pending review": BUCKETS.open,
    "in progress": BUCKETS.inProgress,
    feedback: BUCKETS.feedback,
    "issues found": BUCKETS.issuesFound,
    "IN STAGING": BUCKETS.inStaging,
    "ready for prod": BUCKETS.done,
    "release candidate": BUCKETS.done,
    "in prod": BUCKETS.done,
    document: BUCKETS.done,
    Closed: BUCKETS.done
  };
  for (const [status, bucket] of Object.entries(expected)) {
    assert.equal(bucketForStatus(status, "custom"), bucket, status);
  }
});

test("an unknown status falls back to its ClickUp type, else shows as other", () => {
  assert.equal(bucketForStatus("parked", "closed"), BUCKETS.done);
  assert.equal(bucketForStatus("parked", "open"), BUCKETS.open);
  assert.equal(bucketForStatus("parked", "custom"), BUCKETS.other);
  assert.equal(bucketForStatus("product sync", "custom"), BUCKETS.other, "prod inside product is not a match");
});

test("a project's own override wins over the built-in rules", () => {
  assert.equal(bucketForStatus("QA passed", "custom", { "qa passed": BUCKETS.done }), BUCKETS.done);
});

test("planning statuses map to spec stages, ready for review is review", () => {
  assert.equal(specStageForStatus("to do", "open"), SPEC_STAGES.noSpec);
  assert.equal(specStageForStatus("writing spec", "custom"), SPEC_STAGES.draft);
  assert.equal(specStageForStatus("ready for review", "custom"), SPEC_STAGES.review);
  assert.equal(specStageForStatus("approved", "custom"), SPEC_STAGES.approved);
  assert.equal(specStageForStatus("whatever", "closed"), SPEC_STAGES.approved);
});

// ---- ClickUp ---------------------------------------------------------------

function rawTask(overrides = {}) {
  return {
    id: "abc123aa1",
    name: "Search page",
    url: "https://app.clickup.com/t/abc123aa1",
    status: { status: "in staging", type: "custom", color: "#2ecd6f" },
    assignees: [{ id: 42, username: "Alex Doe", color: "#e04f8a" }],
    date_created: String(NOW - 20 * DAY),
    date_updated: String(NOW - DAY),
    date_closed: null,
    due_date: null,
    parent: null,
    list: { id: "901300000001", name: "Web build list" },
    folder: { id: "901300000010", name: "Web development" },
    space: { id: "900000000099" },
    dependencies: [
      { task_id: "abc123aa1", depends_on: "def456aa1", type: 1 },
      { task_id: "abc999zzz", depends_on: "abc123aa1", type: 1 }
    ],
    custom_fields: [],
    ...overrides
  };
}

test("a task keeps what the cards need; dependencies only in the waiting direction", () => {
  const task = mapTask(rawTask());
  assert.equal(task.id, "abc123aa1");
  assert.equal(task.status, "in staging");
  assert.equal(task.listName, "Web build list");
  assert.deepEqual(task.dependsOn, ["def456aa1"]);
  assert.equal(task.assignees[0].id, "42");
  assert.equal(task.assignees[0].initials, "AD");
  assert.equal(task.createdAt, NOW - 20 * DAY);
  assert.deepEqual(dependsOnFrom("a", [{ task_id: "b", depends_on: "a" }]), []);
});

test("the Spec URL field is found by name, only when it holds a link", () => {
  assert.equal(specUrlFrom([{ name: "Spec URL", type: "url", value: " https://app.clickup.com/999999/v/dc/doc-1/page-1 " }]),
    "https://app.clickup.com/999999/v/dc/doc-1/page-1");
  assert.equal(specUrlFrom([{ name: "Spec URL", type: "url", value: "" }]), null);
  assert.equal(specUrlFrom([{ name: "Figma", type: "url", value: "https://figma.com/x" }]), null);
});

test("task links and bare ids become task ids; doc links do not", () => {
  assert.equal(taskIdFromLink("https://app.clickup.com/t/abc123aa1"), "abc123aa1");
  assert.equal(taskIdFromLink("https://app.clickup.com/t/999999/abc123aa1"), "abc123aa1");
  assert.equal(taskIdFromLink("abc123aa1"), "abc123aa1");
  assert.equal(taskIdFromLink("https://app.clickup.com/999999/v/dc/doc-1/page-1"), null);
});

function fakeFetch(routes, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const route = routes.find(([pattern]) => url.includes(pattern));
    if (!route) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const [, status, body] = route;
    return { ok: status < 400, status, json: async () => body };
  };
}

test("the client pages through a list, sends the raw token and never writes", async () => {
  const calls = [];
  const client = createClickupClient({
    token: "pk_test",
    minimumGapMilliseconds: 0,
    fetchImplementation: fakeFetch(
      [
        ["page=0", 200, { tasks: [rawTask()], last_page: false }],
        ["page=1", 200, { tasks: [rawTask({ id: "abc123aa2", name: "Menu", dependencies: [] })], last_page: true }]
      ],
      calls
    )
  });
  const tasks = await client.listTasks("901300000001");
  assert.deepEqual(tasks.map((task) => task.name), ["Search page", "Menu"]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.headers.Authorization, "pk_test");
    assert.match(call.url, /include_closed=true&subtasks=true/);
  }
});

test("no token, a refused token and a dead network are told apart", async () => {
  const noToken = createClickupClient({ token: null, minimumGapMilliseconds: 0, fetchImplementation: fakeFetch([]) });
  await assert.rejects(noToken.getTask("x"), { kind: "no-token" });
  const refused = createClickupClient({ token: "bad", minimumGapMilliseconds: 0, fetchImplementation: fakeFetch([["/task/", 401, {}]]) });
  await assert.rejects(refused.getTask("x"), { kind: "unauthorized" });
  const offline = createClickupClient({
    token: "pk",
    minimumGapMilliseconds: 0,
    fetchImplementation: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }
  });
  await assert.rejects(offline.getTask("x"), { kind: "network" });
  // A failed request does not jam the queue for the next one.
  const recovering = createClickupClient({
    token: "pk",
    minimumGapMilliseconds: 0,
    fetchImplementation: fakeFetch([["/task/good", 200, rawTask()]])
  });
  await assert.rejects(recovering.getTask("bad"));
  assert.equal((await recovering.getTask("good")).name, "Search page");
});

test("the token comes from the environment first, the Keychain on a Mac, else nothing", async () => {
  assert.equal(await readClickupToken({ environment: { CLAUDING_CLICKUP_TOKEN: " pk_env " } }), "pk_env");
  assert.equal(await readClickupToken({ environment: {}, platform: "linux" }), null);
  let asked = null;
  const token = await readClickupToken({
    environment: {},
    platform: "darwin",
    execFileImplementation: (command, commandArguments, options, done) => {
      asked = [command, ...commandArguments];
      done(null, "pk_keychain\n");
    }
  });
  assert.equal(token, "pk_keychain");
  assert.deepEqual(asked, ["security", "find-generic-password", "-a", "clickup-api", "-s", "clickup-api-token", "-w"]);
  const missing = await readClickupToken({
    environment: {},
    platform: "darwin",
    execFileImplementation: (command, commandArguments, options, done) => done(new Error("not found"), "")
  });
  assert.equal(missing, null);
});

// ---- git -------------------------------------------------------------------

test("CU branch names carry the task id, suffixes and all", () => {
  assert.equal(taskIdFromBranch("CU-abc123aa1"), "abc123aa1");
  assert.equal(taskIdFromBranch("CU-abc123aa1-1"), "abc123aa1");
  assert.equal(taskIdFromBranch("CU-abc123aa1-fix"), "abc123aa1");
  assert.equal(taskIdFromBranch("refs/remotes/origin/CU-abc123aa2"), "abc123aa2");
  assert.equal(taskIdFromBranch("favicons"), null);
  assert.equal(taskIdFromBranch("staging"), null);
});

test("refs and worktree lists are parsed", () => {
  const branches = parseBranchRefs(
    ["refs/heads/CU-abc123aa1", "refs/remotes/origin/CU-abc123aa1", "refs/remotes/origin/CU-abc123aa2", "refs/heads/favicons", "refs/remotes/origin/HEAD"].join("\n")
  );
  assert.deepEqual(
    branches.map((branch) => [branch.name, branch.local, branch.remote]),
    [["CU-abc123aa1", true, true], ["CU-abc123aa2", false, true]]
  );
  const worktrees = parseWorktrees("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/CU-1\nHEAD def\nbranch refs/heads/CU-abc123aa3\n");
  assert.deepEqual(worktrees, [{ path: "/repo", branch: "main" }, { path: "/wt/CU-1", branch: "CU-abc123aa3" }]);
});

function git(folder, ...gitArguments) {
  return execFileSync("git", ["-C", folder, ...gitArguments], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" }
  });
}

function commitFile(folder, name, text) {
  fs.writeFileSync(path.join(folder, name), text);
  git(folder, "add", name);
  git(folder, "commit", "--quiet", "-m", `add ${name}`);
}

test("a real repository: ahead count, staging, worktree and uncommitted changes", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-git-"));
  const origin = path.join(scratch, "origin");
  const checkout = path.join(scratch, "website");
  fs.mkdirSync(origin);
  git(origin, "init", "--quiet", "-b", "main");
  commitFile(origin, "base.txt", "base\n");
  git(origin, "branch", "staging");
  execFileSync("git", ["clone", "--quiet", origin, checkout]);
  git(checkout, "checkout", "--quiet", "-b", "CU-abc123aa1", "origin/main");
  commitFile(checkout, "leaderboards.txt", "one\n");
  commitFile(checkout, "leaderboards2.txt", "two\n");
  git(checkout, "push", "--quiet", "origin", "CU-abc123aa1");
  // Search page reached staging on the origin side.
  git(origin, "checkout", "--quiet", "staging");
  git(origin, "merge", "--quiet", "--no-edit", "CU-abc123aa1");
  git(origin, "checkout", "--quiet", "main");
  git(checkout, "fetch", "--quiet", "origin");
  // User profile: a local branch in its own worktree, not pushed, with an edit.
  git(checkout, "checkout", "--quiet", "main");
  const worktree = path.join(scratch, "wt-friends");
  git(checkout, "worktree", "add", "--quiet", "-b", "CU-abc123aa3", worktree, "origin/main");
  commitFile(worktree, "friends.txt", "friends\n");
  fs.writeFileSync(path.join(worktree, "friends.txt"), "changed\n");

  const result = await inspectRepository({ name: "website", localPath: checkout });
  assert.equal(result.available, true);
  const [leaderboards] = result.branchesByTask["abc123aa1"];
  assert.equal(leaderboards.aheadOfBase, 2);
  assert.equal(leaderboards.inStaging, true);
  assert.equal(leaderboards.pushed, true);
  const [friends] = result.branchesByTask["abc123aa3"];
  assert.equal(friends.aheadOfBase, 1);
  assert.equal(friends.inStaging, false);
  assert.equal(friends.pushed, false);
  assert.equal(fs.realpathSync(friends.worktreePath), fs.realpathSync(worktree));
  assert.equal(friends.uncommitted, true);

  const missing = await inspectRepository({ name: "mobile", localPath: path.join(scratch, "nope") });
  assert.equal(missing.available, false);
  assert.equal(missing.error, "not-a-repository");
});

// ---- GitHub ----------------------------------------------------------------

test("CI state reads check runs and commit statuses", () => {
  assert.equal(ciStateFrom([]), "none");
  assert.equal(ciStateFrom([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]), "passing");
  assert.equal(ciStateFrom([{ status: "IN_PROGRESS", conclusion: "" }]), "pending");
  assert.equal(ciStateFrom([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "failing");
});

test("pull requests are grouped by the task in their branch name", () => {
  const byTask = pullRequestsByTask("website", [
    { number: 4812, headRefName: "CU-abc123aa1", baseRefName: "staging", state: "MERGED", url: "u1", updatedAt: "2026-09-18T10:00:00Z", statusCheckRollup: [] },
    { number: 4799, headRefName: "CU-abc123aa1-1", baseRefName: "staging", state: "CLOSED", url: "u2", updatedAt: "2026-09-10T10:00:00Z", statusCheckRollup: [] },
    { number: 4700, headRefName: "favicons", baseRefName: "staging", state: "OPEN", url: "u3", updatedAt: "2026-09-21T10:00:00Z" }
  ]);
  assert.deepEqual(Object.keys(byTask), ["abc123aa1"]);
  assert.deepEqual(byTask["abc123aa1"].map((pull) => [pull.number, pull.state]), [[4812, "merged"], [4799, "closed"]]);
});

// ---- sessions ↔ tasks --------------------------------------------------------

const AGENTS = [
  { id: "agent-spec", name: "Spec Author", emoji: "✍️" },
  { id: "agent-builder", name: "Builder", emoji: "🔨" },
  { id: "agent-todo", name: "TODO", emoji: "✅" }
];

test("roles come from the agent, and the user's own mapping wins", () => {
  assert.equal(roleForAgent(AGENTS[0]), "spec");
  assert.equal(roleForAgent(AGENTS[1]), "builder");
  assert.equal(roleForAgent(AGENTS[2]), "other");
  assert.equal(roleForAgent(null), "other");
  assert.equal(roleForAgent(AGENTS[2], { "agent-todo": "builder" }), "builder");
});

test("mentions are found as ClickUp links and CU ids", () => {
  assert.deepEqual(
    [...taskIdsMentionedIn("You are the builder, task: https://app.clickup.com/t/abc123aa1 and CU-abc123aa2")],
    ["abc123aa1", "abc123aa2"]
  );
});

test("sessions link by hand, by branch, by first prompt, by transcript — and can be unlinked", () => {
  const sessions = [
    { sessionId: "s-branch", title: "Profile builder", gitBranch: "CU-abc123aa3", workingDirectory: "/wt/CU-abc123aa3", lastModified: NOW - DAY },
    { sessionId: "s-prompt", title: "checkout", firstPrompt: "Build https://app.clickup.com/t/abc123aa5", lastModified: NOW - 2 * DAY },
    { sessionId: "s-spec", title: "spec-search", firstPrompt: "spec for search", lastModified: NOW - 3 * DAY },
    { sessionId: "s-manual", title: "notes", gitBranch: "CU-abc123aa3", lastModified: NOW },
    { sessionId: "s-unrelated", title: "notes app", lastModified: NOW }
  ];
  const links = linkSessionsToTasks({
    sessions,
    taskIds: ["abc123aa3", "abc123aa5", "def456aa1"],
    sessionAgents: { "s-branch": "agent-builder", "s-spec": "agent-spec" },
    agents: AGENTS,
    manualLinks: {
      "def456aa1": { sessionIds: [] },
      "abc123aa5": { sessionIds: ["s-manual"] },
      "abc123aa3": { sessionIds: [], unlinkedSessionIds: ["s-manual"] }
    },
    transcriptTextBySession: { "s-spec": "…planning task https://app.clickup.com/t/def456aa1…" }
  });
  assert.deepEqual(links.get("abc123aa3").map((link) => [link.sessionId, link.via, link.role]), [["s-branch", "branch", "builder"]]);
  assert.deepEqual(
    links.get("abc123aa5").map((link) => [link.sessionId, link.via]),
    [["s-manual", "manual"], ["s-prompt", "mention"]]
  );
  assert.deepEqual(links.get("def456aa1").map((link) => [link.sessionId, link.via, link.role]), [["s-spec", "transcript", "spec"]]);
  assert.equal([...links.values()].flat().some((link) => link.sessionId === "s-unrelated"), false);
});

// ---- pipeline --------------------------------------------------------------

test("spec stage: a spec-role session lifts no-spec to session; review waits on the user", () => {
  const writing = specStage({ planningTask: { status: "to do", statusType: "open" }, specSessions: [{ needsAnswer: false }] });
  assert.equal(writing.steps[writing.index], "session");
  assert.equal(writing.state, "now");
  const review = specStage({ planningTask: { status: "in review", statusType: "custom" } });
  assert.equal(review.steps[review.index], "review");
  assert.equal(review.state, "wait");
  const unknown = specStage({ planningTask: null });
  assert.equal(unknown.known, false);
  assert.equal(unknown.state, "done");
});

test("build stage follows builder → branch → PR → staging → QA", () => {
  const step = (stage) => stage.steps[stage.index];
  assert.equal(step(buildStage({ bucket: BUCKETS.open })), "open");
  assert.equal(step(buildStage({ bucket: BUCKETS.inProgress, builderSessions: [{}] })), "builder");
  assert.equal(step(buildStage({ bucket: BUCKETS.inProgress, builderSessions: [{}], branches: [{ inStaging: false }] })), "branch");
  assert.equal(step(buildStage({ bucket: BUCKETS.feedback, branches: [{}], pullRequests: [{ state: "open" }] })), "pr");
  assert.equal(step(buildStage({ bucket: BUCKETS.inProgress, branches: [{ inStaging: true }] })), "staging");
  const qa = buildStage({ bucket: BUCKETS.inStaging, branches: [{ inStaging: true }] });
  assert.equal(step(qa), "qa");
  assert.equal(qa.state, "now", "QA is other people's step: nothing waits on the user");
  assert.equal(qa.steps[qa.handOffIndex], "staging", "the user's part is handed off at staging");
  assert.equal(buildStage({ bucket: BUCKETS.open, specApproved: false }).index, -1);
});

test("what waits on the user: a question first, then red CI, review, feedback, QA", () => {
  assert.equal(whatNeedsUser({ sessions: [{ needsAnswer: true, title: "checkout", sessionId: "s" }] }).kind, "session-question");
  assert.equal(whatNeedsUser({ pullRequests: [{ state: "open", ci: "failing", number: 7 }] }).kind, "red-ci");
  assert.equal(whatNeedsUser({ bucket: BUCKETS.feedback, assignedToUser: true }).kind, "feedback");
  assert.equal(whatNeedsUser({ bucket: BUCKETS.feedback, assignedToUser: false }), null);
  assert.equal(whatNeedsUser({ bucket: BUCKETS.inStaging, assignedToUser: true }).kind, "qa");
});

// ---- numbers ---------------------------------------------------------------

test("work days skip weekends", () => {
  // Monday noon → next Monday noon: Tue, Wed, Thu, Fri, Mon.
  assert.equal(workDaysBetween(NOW, NOW + 7 * DAY), 5);
  assert.equal(workDaysBetween(NOW, NOW - DAY), 0);
});

test("the timeline places deadlines and finds the next one", () => {
  const timeline = deadlineTimeline(
    [
      { label: "Launch", date: NOW + 50 * DAY },
      { label: "Specs v1", date: NOW - 23 * DAY },
      { label: "Feature freeze", date: NOW + 17 * DAY }
    ],
    { now: NOW }
  );
  assert.deepEqual(timeline.deadlines.map((deadline) => deadline.label), ["Specs v1", "Feature freeze", "Launch"]);
  assert.equal(timeline.next.label, "Feature freeze");
  assert.equal(timeline.next.daysLeft, 17);
  assert.ok(timeline.elapsedFraction > 0.3 && timeline.elapsedFraction < 0.33);
  assert.equal(deadlineTimeline([], { now: NOW }).next, null);
});

test("pace, people and the daily line", () => {
  const tasks = [
    { bucket: BUCKETS.done, closedAt: NOW - 3 * DAY, createdAt: NOW - 30 * DAY, assignees: [] },
    { bucket: BUCKETS.done, closedAt: NOW - 10 * DAY, createdAt: NOW - 30 * DAY, assignees: [] },
    { bucket: BUCKETS.done, closedAt: NOW - 2 * 60 * 60 * 1000, createdAt: NOW - 30 * DAY, assignees: [] },
    { bucket: BUCKETS.inProgress, createdAt: NOW - 20 * DAY, assignees: [{ id: "42", name: "Alex" }] },
    { bucket: BUCKETS.inStaging, createdAt: NOW - 20 * DAY, assignees: [{ id: "42", name: "Alex" }] },
    { bucket: BUCKETS.open, createdAt: NOW - 5 * DAY, assignees: [{ id: "7", name: "Sam" }] },
    { bucket: BUCKETS.open, createdAt: NOW - 5 * DAY, assignees: [] }
  ];
  const result = pace(tasks, { now: NOW, lastDeadline: NOW + 28 * DAY });
  assert.equal(result.leftToClose, 4);
  assert.equal(result.actualPerWeek, 1.5);
  assert.equal(result.neededPerWeek, 1);
  const people = peopleBreakdown(tasks, "42");
  assert.deepEqual(people.map((person) => [person.name, person.total]), [["Alex", 2], ["Sam", 1], ["Nobody", 1]]);
  assert.equal(people[0].isUser, true);
  const daily = dailyPace(tasks, { now: NOW, deadline: { label: "Feature freeze", date: NOW + 7 * DAY } });
  assert.equal(daily.tasks, 4);
  assert.equal(daily.workDays, 5);
  assert.equal(daily.perDay, 0.8);
  assert.equal(daily.closedToday, 1);
});

// ---- one whole project ---------------------------------------------------------

function websiteFixture() {
  const build = (id, name, status, extra = {}) =>
    mapTask(rawTask({ id, name, url: `https://app.clickup.com/t/${id}`, status: { status, type: status === "Open" ? "open" : "custom" }, dependencies: [], ...extra }));
  const planning = (id, name, status, specUrl) =>
    mapTask(rawTask({
      id,
      name,
      status: { status, type: "custom" },
      dependencies: [],
      list: { id: "901300000002", name: "Planning list" },
      custom_fields: specUrl ? [{ name: "Spec URL", type: "url", value: specUrl }] : []
    }));
  const dependsOn = (taskId, planningId) => ({ dependencies: [{ task_id: taskId, depends_on: planningId }] });
  const buildTasks = [
    build("abc123aa1", "Search page", "in staging", dependsOn("abc123aa1", "def456aa1")),
    build("abc123aa3", "User profile", "in progress", dependsOn("abc123aa3", "def456aa2")),
    build("abc123aa4", "Profile — edit modal", "in progress", { parent: "abc123aa3" }),
    build("abc123aa5", "Checkout", "feedback"),
    build("abc123opn", "Toast alerts", "Open", { assignees: [] }),
    build("abc123don", "Menu", "ready for prod", { date_closed: String(NOW - 4 * DAY) })
  ];
  const planningTasks = [
    planning("def456aa1", "Search page", "approved", "https://app.clickup.com/999999/v/dc/doc-1/page-1"),
    planning("def456aa2", "User profile", "approved", "https://app.clickup.com/999999/v/dc/doc-1/page-2"),
    planning("def456aa3", "Order history", "in review", "https://app.clickup.com/999999/v/dc/doc-1/page-3"),
    planning("def456aa4", "Newsletter", "to do", null)
  ];
  const sessions = [
    { sessionId: "s-profile", title: "Profile builder", gitBranch: "CU-abc123aa3", lastModified: NOW - 60 * 1000, statusGroup: "running" },
    { sessionId: "s-checkout", title: "checkout", firstPrompt: "https://app.clickup.com/t/abc123aa5", lastModified: NOW - DAY, needsAnswer: true },
    { sessionId: "s-progress", title: "spec-order-history", firstPrompt: "planning https://app.clickup.com/t/def456aa3", lastModified: NOW - 2 * DAY }
  ];
  return {
    board: {
      id: "website",
      name: "Website",
      clickupUserId: "42",
      clickup: { buildListName: "Web build list", planningListName: "Planning list" },
      deadlines: [
        { id: "d1", label: "Feature freeze", date: NOW + 17 * DAY },
        { id: "d2", label: "Launch", date: NOW + 50 * DAY }
      ],
      upNext: ["abc123opn"]
    },
    buildTasks,
    planningTasks,
    sessions,
    sessionAgents: { "s-profile": "agent-builder", "s-checkout": "agent-builder", "s-progress": "agent-spec" },
    agents: AGENTS,
    repositoryResults: [
      {
        repository: "website",
        available: true,
        branchesByTask: {
          "abc123aa1": [{ repository: "website", name: "CU-abc123aa1", local: true, pushed: true, aheadOfBase: 7, inStaging: true }],
          "abc123aa3": [{ repository: "website", name: "CU-abc123aa3", local: true, pushed: false, aheadOfBase: 7, inStaging: false }]
        }
      }
    ],
    pullRequestResults: [{ available: true, byTask: { "abc123aa1": [{ number: 4812, state: "merged", ci: "passing" }] } }],
    now: NOW
  };
}

test("a project that names its own spec link field reads that field", () => {
  const fixture = websiteFixture();
  const renamed = fixture.planningTasks.map((task) => ({
    ...task,
    customFields: task.customFields.map((field) => ({ ...field, name: "Design document" }))
  }));
  const withDefault = buildProjectSnapshot({ ...fixture, planningTasks: renamed });
  assert.equal(withDefault.cards.find((entry) => entry.id === "abc123aa1").specUrl, null);
  const withSetting = buildProjectSnapshot({ ...fixture, planningTasks: renamed, board: { ...fixture.board, specUrlFieldName: "design document" } });
  assert.equal(withSetting.cards.find((entry) => entry.id === "abc123aa1").specUrl, "https://app.clickup.com/999999/v/dc/doc-1/page-1");
});

test("a whole project: cards, stages, filters, spec pipeline and numbers", () => {
  const snapshot = buildProjectSnapshot(websiteFixture());
  const card = (id) => snapshot.cards.find((entry) => entry.id === id);

  // Subtasks fold into their parent; unclaimed planning tasks become spec cards.
  assert.deepEqual(snapshot.cards.map((entry) => entry.id), ["abc123aa1", "abc123aa3", "abc123aa5", "abc123opn", "abc123don", "def456aa3", "def456aa4"]);
  assert.equal(card("abc123aa3").subtaskCount, 1);
  assert.equal(card("def456aa3").kind, "spec");

  // Search page: planning → spec URL, merged PR, in staging → the QA step,
  // which is other people's: the task waits on others, nothing on the user.
  const leaderboards = card("abc123aa1");
  assert.equal(leaderboards.specUrl, "https://app.clickup.com/999999/v/dc/doc-1/page-1");
  assert.equal(leaderboards.spec.state, "done");
  assert.equal(leaderboards.build.steps[leaderboards.build.index], "qa");
  assert.equal(leaderboards.perspective, "waiting");
  assert.equal(leaderboards.needs, null);

  // User profile: builder by branch, unpushed branch.
  const friends = card("abc123aa3");
  assert.deepEqual(friends.builderSessions.map((session) => session.sessionId), ["s-profile"]);
  assert.equal(friends.build.steps[friends.build.index], "branch");
  assert.equal(friends.needs.kind, "unpushed");

  // Checkout: no planning task known, a builder session asking a question.
  assert.equal(card("abc123aa5").spec.known, false);
  assert.equal(card("abc123aa5").needs.kind, "session-question");

  // Order history spec: in review with its spec-role session.
  const progress = card("def456aa3");
  assert.equal(progress.spec.steps[progress.spec.index], "review");
  assert.deepEqual(progress.specSessions.map((session) => session.sessionId), ["s-progress"]);

  // My focus: things waiting on the user first; Up next is kept as pinned.
  assert.equal(snapshot.filters.focus[0] === "abc123aa5" || snapshot.cards.find((entry) => entry.id === snapshot.filters.focus[0]).needs !== null, true);
  assert.ok(snapshot.filters.focus.includes("abc123opn"), "pinned to Up next");
  assert.ok(snapshot.filters.focus.includes("abc123don"), "ready for prod is the user's own work again (the deploy)");
  assert.ok(!snapshot.filters.focus.includes("abc123aa1"), "waiting on others is not in focus");
  assert.deepEqual(snapshot.filters.upNext, ["abc123opn"]);

  // Spec pipeline counts by stage.
  const stageCount = (stage) => snapshot.specPipeline.find((entry) => entry.stage === stage).count;
  assert.equal(stageCount("noSpec"), 1);
  assert.equal(stageCount("review"), 1);
  assert.equal(stageCount("approved"), 2);

  // Numbers on top count every task and subtask: 5 tasks + 1 subtask.
  assert.equal(snapshot.stats.total, 6);
  assert.equal(snapshot.stats.topLevel, 5);
  assert.equal(snapshot.stats.subtasks, 1);
  assert.equal(snapshot.stats.buckets.inStaging, 1);
  assert.equal(snapshot.stats.buckets.inProgress, 2, "the task and its subtask");
  assert.equal(snapshot.stats.buckets.done, 1);
  // From the user's side: in progress, open and ready for prod are hers;
  // in staging and feedback wait on others; nothing is closed yet.
  assert.equal(snapshot.stats.pace.leftToClose, 4);
  assert.equal(snapshot.stats.inQueue, 4);
  assert.equal(snapshot.stats.waiting, 2);
  assert.equal(snapshot.stats.closed, 0);
  assert.equal(snapshot.stats.specsInReview, 1);
  assert.equal(snapshot.timeline.next.label, "Feature freeze");
  assert.equal(snapshot.dailyPace.tasks, 4, "the queue over the work days to the next deadline");
  // With subtasks switched off, only the five tasks count.
  const topOnly = buildProjectSnapshot({ ...websiteFixture(), board: { ...websiteFixture().board, countSubtasks: false } });
  assert.equal(topOnly.stats.total, 5);
  assert.equal(topOnly.stats.inQueue, 3);
  assert.equal(topOnly.dailyPace.tasks, 3);
  assert.equal(topOnly.cards.find((entry) => entry.id === "abc123aa3").subtasks.length, 1, "still listed on its card");
  assert.equal(snapshot.summary.nextDeadline.daysLeft, 17);
});

// ---- the store ---------------------------------------------------------------

test("the store keeps projects, cleans what it reads and survives a broken file", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-boards-"));
  const storagePath = path.join(folder, "project-boards.json");
  const store = createProjectBoardStore({ storagePath });
  const board = store.addBoard({
    name: "  Website  ",
    clickup: { seedTaskId: "abc123aa1" },
    repositories: [{ name: "website", localPath: "/Users/someone/website", githubSlug: "acme/website" }, { name: "" }],
    deadlines: [{ label: "Feature freeze", date: NOW }, { label: "", date: NOW }],
    statusOverrides: { "qa passed": "done", weird: "nonsense" }
  });
  assert.equal(board.name, "Website");
  assert.equal(board.repositories.length, 1);
  assert.equal(board.repositories[0].stagingBranch, "staging");
  assert.equal(board.repositories[0].baseBranch, "main");
  assert.equal(board.specUrlFieldName, "Spec URL", "the spec link field has a default name");
  assert.equal(board.deadlines.length, 1);
  assert.deepEqual(board.statusOverrides, { "qa passed": "done" });

  store.setUpNext(board.id, ["abc123opn", "abc123opn", "abc123aa5"]);
  store.linkSession(board.id, "abc123aa5", "s-1");
  store.unlinkSession(board.id, "abc123aa3", "s-1");
  store.flush();
  const reread = readBoardsFile(storagePath).boards[0];
  assert.deepEqual(reread.upNext, ["abc123opn", "abc123aa5"]);
  assert.deepEqual(reread.manualLinks["abc123aa5"].sessionIds, ["s-1"]);
  assert.deepEqual(reread.manualLinks["abc123aa3"].unlinkedSessionIds, ["s-1"]);

  fs.writeFileSync(storagePath, "{ not json");
  assert.deepEqual(readBoardsFile(storagePath).boards, []);
  assert.ok(fs.existsSync(`${storagePath}.bak`));
});

// ---- the service: finding lists, the cache, offline -------------------------

test("the service finds both lists from one task, caches ClickUp and survives going offline", async () => {
  const { createProjectDataService } = await import("../electron/projectData.js");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-projectdata-"));
  const boardStore = createProjectBoardStore({ storagePath: path.join(folder, "project-boards.json") });
  const board = boardStore.addBoard({ name: "Website", clickup: { seedTaskId: "abc123aa1" } });

  const buildList = { id: "901300000001", name: "Web build list" };
  const planningList = { id: "901300000002", name: "Planning list" };
  const leaderboards = rawTask({ list: buildList });
  const planningTask = rawTask({ id: "def456aa1", name: "Search page", list: planningList, dependencies: [], status: { status: "approved", type: "custom" } });
  let online = true;
  const calls = [];
  const fetchImplementation = async (url) => {
    calls.push(url);
    if (!online) {
      throw new Error("offline");
    }
    const body = (() => {
      if (url.includes("/task/abc123aa1")) return leaderboards;
      if (url.includes("/task/def456aa1")) return planningTask;
      if (url.includes(`/list/${buildList.id}/task`)) return { tasks: [leaderboards], last_page: true };
      if (url.includes(`/list/${planningList.id}/task`)) return { tasks: [planningTask], last_page: true };
      return null;
    })();
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  };
  let clock = NOW;
  const service = createProjectDataService({
    boardStore,
    cacheDirectory: path.join(folder, "project-cache"),
    getSessions: async () => [],
    getAgents: () => ({ agents: [], sessionAgents: {} }),
    readToken: async () => "pk_test",
    fetchImplementation,
    inspectRepositoryImplementation: async () => ({ available: true, branchesByTask: {} }),
    listPullRequestsImplementation: async () => ({ available: true, byTask: {} }),
    fixturePath: null,
    now: () => clock
  });

  const first = await service.snapshot(board.id);
  assert.equal(first.sources.clickup.ok, true);
  assert.equal(first.cards[0].specUrl, null, "the fixture planning task has no Spec URL field");
  assert.equal(first.cards[0].spec.state, "done", "approved planning task");
  const saved = boardStore.getBoard(board.id).clickup;
  assert.equal(saved.buildListName, "Web build list");
  assert.equal(saved.planningListName, "Planning list");

  // Within five minutes: the cache, no request at all.
  const before = calls.length;
  clock += 60 * 1000;
  const cached = await service.snapshot(board.id);
  assert.equal(calls.length, before);
  assert.equal(cached.sources.clickup.fromCache, true);

  // ↻ while offline: the cached tasks stay, the header says why.
  online = false;
  const offline = await service.snapshot(board.id, { refresh: true });
  assert.equal(offline.sources.clickup.ok, false);
  assert.equal(offline.sources.clickup.error, "network");
  assert.equal(offline.cards.length, 1);

  // The left list reads the cache only.
  const [summary] = service.summaries();
  assert.equal(summary.name, "Website");
  assert.equal(summary.summary.inQueue, 0, "in staging is not on the user's plate");
  assert.equal(summary.summary.waiting, 1);
});
