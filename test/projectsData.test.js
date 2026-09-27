// CL-26 — the Projects view's data layer: ClickUp statuses → buckets, the
// ClickUp client (fake fetch, never the network), git branches in a
// throw-away repository, gh's JSON, linking sessions to tasks, the pipeline
// stages, the numbers on top, one whole Groove snapshot, and the store.
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

test("Groove's and Walktober's statuses land in the right bucket", () => {
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
    id: "86ak7bh2e",
    name: "Leaderboards",
    url: "https://app.clickup.com/t/86ak7bh2e",
    status: { status: "in staging", type: "custom", color: "#2ecd6f" },
    assignees: [{ id: 42, username: "Ula Kuczyńska", color: "#e04f8a" }],
    date_created: String(NOW - 20 * DAY),
    date_updated: String(NOW - DAY),
    date_closed: null,
    due_date: null,
    parent: null,
    list: { id: "901300000001", name: "Initial Build Web" },
    folder: { id: "901300000010", name: "Groove Web Development" },
    space: { id: "901313890025" },
    dependencies: [
      { task_id: "86ak7bh2e", depends_on: "86ajn44t6", type: 1 },
      { task_id: "86zzzzzzz", depends_on: "86ak7bh2e", type: 1 }
    ],
    custom_fields: [],
    ...overrides
  };
}

test("a task keeps what the cards need; dependencies only in the waiting direction", () => {
  const task = mapTask(rawTask());
  assert.equal(task.id, "86ak7bh2e");
  assert.equal(task.status, "in staging");
  assert.equal(task.listName, "Initial Build Web");
  assert.deepEqual(task.dependsOn, ["86ajn44t6"]);
  assert.equal(task.assignees[0].id, "42");
  assert.equal(task.assignees[0].initials, "UK");
  assert.equal(task.createdAt, NOW - 20 * DAY);
  assert.deepEqual(dependsOnFrom("a", [{ task_id: "b", depends_on: "a" }]), []);
});

test("the Spec URL field is found by name, only when it holds a link", () => {
  assert.equal(specUrlFrom([{ name: "Spec URL", type: "url", value: " https://app.clickup.com/1281535/v/dc/173fz-212393/173fz-303673 " }]),
    "https://app.clickup.com/1281535/v/dc/173fz-212393/173fz-303673");
  assert.equal(specUrlFrom([{ name: "Spec URL", type: "url", value: "" }]), null);
  assert.equal(specUrlFrom([{ name: "Figma", type: "url", value: "https://figma.com/x" }]), null);
});

test("task links and bare ids become task ids; doc links do not", () => {
  assert.equal(taskIdFromLink("https://app.clickup.com/t/86ak7bh2e"), "86ak7bh2e");
  assert.equal(taskIdFromLink("https://app.clickup.com/t/1281535/86ak7bh2e"), "86ak7bh2e");
  assert.equal(taskIdFromLink("86ak7bh2e"), "86ak7bh2e");
  assert.equal(taskIdFromLink("https://app.clickup.com/1281535/v/dc/173fz-212393/173fz-303673"), null);
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
        ["page=1", 200, { tasks: [rawTask({ id: "86ak7bgn3", name: "Menu", dependencies: [] })], last_page: true }]
      ],
      calls
    )
  });
  const tasks = await client.listTasks("901300000001");
  assert.deepEqual(tasks.map((task) => task.name), ["Leaderboards", "Menu"]);
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
  assert.equal((await recovering.getTask("good")).name, "Leaderboards");
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
  assert.equal(taskIdFromBranch("CU-86ak7bh2e"), "86ak7bh2e");
  assert.equal(taskIdFromBranch("CU-86ak7bh2e-1"), "86ak7bh2e");
  assert.equal(taskIdFromBranch("CU-86ak7bh2e-WAL"), "86ak7bh2e");
  assert.equal(taskIdFromBranch("refs/remotes/origin/CU-86ak7bgn3"), "86ak7bgn3");
  assert.equal(taskIdFromBranch("favicons"), null);
  assert.equal(taskIdFromBranch("docker-staging"), null);
});

test("refs and worktree lists are parsed", () => {
  const branches = parseBranchRefs(
    ["refs/heads/CU-86ak7bh2e", "refs/remotes/origin/CU-86ak7bh2e", "refs/remotes/origin/CU-86ak7bgn3", "refs/heads/favicons", "refs/remotes/origin/HEAD"].join("\n")
  );
  assert.deepEqual(
    branches.map((branch) => [branch.name, branch.local, branch.remote]),
    [["CU-86ak7bh2e", true, true], ["CU-86ak7bgn3", false, true]]
  );
  const worktrees = parseWorktrees("worktree /repo\nHEAD abc\nbranch refs/heads/docker-deploy\n\nworktree /wt/CU-1\nHEAD def\nbranch refs/heads/CU-86ak7brvp\n");
  assert.deepEqual(worktrees, [{ path: "/repo", branch: "docker-deploy" }, { path: "/wt/CU-1", branch: "CU-86ak7brvp" }]);
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
  const checkout = path.join(scratch, "blueprint");
  fs.mkdirSync(origin);
  git(origin, "init", "--quiet", "-b", "docker-deploy");
  commitFile(origin, "base.txt", "base\n");
  git(origin, "branch", "docker-staging");
  execFileSync("git", ["clone", "--quiet", origin, checkout]);
  git(checkout, "checkout", "--quiet", "-b", "CU-86ak7bh2e", "origin/docker-deploy");
  commitFile(checkout, "leaderboards.txt", "one\n");
  commitFile(checkout, "leaderboards2.txt", "two\n");
  git(checkout, "push", "--quiet", "origin", "CU-86ak7bh2e");
  // Leaderboards reached staging on the origin side.
  git(origin, "checkout", "--quiet", "docker-staging");
  git(origin, "merge", "--quiet", "--no-edit", "CU-86ak7bh2e");
  git(origin, "checkout", "--quiet", "docker-deploy");
  git(checkout, "fetch", "--quiet", "origin");
  // Friends: a local branch in its own worktree, not pushed, with an edit.
  git(checkout, "checkout", "--quiet", "docker-deploy");
  const worktree = path.join(scratch, "wt-friends");
  git(checkout, "worktree", "add", "--quiet", "-b", "CU-86ak7brvp", worktree, "origin/docker-deploy");
  commitFile(worktree, "friends.txt", "friends\n");
  fs.writeFileSync(path.join(worktree, "friends.txt"), "changed\n");

  const result = await inspectRepository({ name: "blueprint", localPath: checkout });
  assert.equal(result.available, true);
  const [leaderboards] = result.branchesByTask["86ak7bh2e"];
  assert.equal(leaderboards.aheadOfBase, 2);
  assert.equal(leaderboards.inStaging, true);
  assert.equal(leaderboards.pushed, true);
  const [friends] = result.branchesByTask["86ak7brvp"];
  assert.equal(friends.aheadOfBase, 1);
  assert.equal(friends.inStaging, false);
  assert.equal(friends.pushed, false);
  assert.equal(fs.realpathSync(friends.worktreePath), fs.realpathSync(worktree));
  assert.equal(friends.uncommitted, true);

  const missing = await inspectRepository({ name: "prime", localPath: path.join(scratch, "nope") });
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
  const byTask = pullRequestsByTask("blueprint", [
    { number: 4812, headRefName: "CU-86ak7bh2e", baseRefName: "docker-staging", state: "MERGED", url: "u1", updatedAt: "2026-09-18T10:00:00Z", statusCheckRollup: [] },
    { number: 4799, headRefName: "CU-86ak7bh2e-1", baseRefName: "docker-staging", state: "CLOSED", url: "u2", updatedAt: "2026-09-10T10:00:00Z", statusCheckRollup: [] },
    { number: 4700, headRefName: "favicons", baseRefName: "docker-staging", state: "OPEN", url: "u3", updatedAt: "2026-09-21T10:00:00Z" }
  ]);
  assert.deepEqual(Object.keys(byTask), ["86ak7bh2e"]);
  assert.deepEqual(byTask["86ak7bh2e"].map((pull) => [pull.number, pull.state]), [[4812, "merged"], [4799, "closed"]]);
});

// ---- sessions ↔ tasks --------------------------------------------------------

const AGENTS = [
  { id: "agent-spec", name: "Spec Writer", emoji: "✍️" },
  { id: "agent-builder", name: "Feature Builder", emoji: "🔨" },
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
    [...taskIdsMentionedIn("Jesteś builderem, task: https://app.clickup.com/t/86ak7bh2e oraz CU-86ak7bgn3")],
    ["86ak7bh2e", "86ak7bgn3"]
  );
});

test("sessions link by hand, by branch, by first prompt, by transcript — and can be unlinked", () => {
  const sessions = [
    { sessionId: "s-branch", title: "Friends builder", gitBranch: "CU-86ak7brvp", workingDirectory: "/wt/CU-86ak7brvp", lastModified: NOW - DAY },
    { sessionId: "s-prompt", title: "recipes", firstPrompt: "Zrób https://app.clickup.com/t/86ak7bx9h", lastModified: NOW - 2 * DAY },
    { sessionId: "s-spec", title: "spec-leaderboards", firstPrompt: "spec for leaderboards", lastModified: NOW - 3 * DAY },
    { sessionId: "s-manual", title: "notes", gitBranch: "CU-86ak7brvp", lastModified: NOW },
    { sessionId: "s-unrelated", title: "langtrainer", lastModified: NOW }
  ];
  const links = linkSessionsToTasks({
    sessions,
    taskIds: ["86ak7brvp", "86ak7bx9h", "86ajn44t6"],
    sessionAgents: { "s-branch": "agent-builder", "s-spec": "agent-spec" },
    agents: AGENTS,
    manualLinks: {
      "86ajn44t6": { sessionIds: [] },
      "86ak7bx9h": { sessionIds: ["s-manual"] },
      "86ak7brvp": { sessionIds: [], unlinkedSessionIds: ["s-manual"] }
    },
    transcriptTextBySession: { "s-spec": "…planning task https://app.clickup.com/t/86ajn44t6…" }
  });
  assert.deepEqual(links.get("86ak7brvp").map((link) => [link.sessionId, link.via, link.role]), [["s-branch", "branch", "builder"]]);
  assert.deepEqual(
    links.get("86ak7bx9h").map((link) => [link.sessionId, link.via]),
    [["s-manual", "manual"], ["s-prompt", "mention"]]
  );
  assert.deepEqual(links.get("86ajn44t6").map((link) => [link.sessionId, link.via, link.role]), [["s-spec", "transcript", "spec"]]);
  assert.equal([...links.values()].flat().some((link) => link.sessionId === "s-unrelated"), false);
});

// ---- pipeline --------------------------------------------------------------

test("spec stage: a Spec Writer session lifts no-spec to session; review waits on the user", () => {
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
  assert.equal(qa.state, "wait");
  assert.equal(buildStage({ bucket: BUCKETS.open, specApproved: false }).index, -1);
});

test("what waits on the user: a question first, then red CI, review, feedback, QA", () => {
  assert.equal(whatNeedsUser({ sessions: [{ needsAnswer: true, title: "recipes", sessionId: "s" }] }).kind, "session-question");
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
    { bucket: BUCKETS.inProgress, createdAt: NOW - 20 * DAY, assignees: [{ id: "42", name: "Ula" }] },
    { bucket: BUCKETS.inStaging, createdAt: NOW - 20 * DAY, assignees: [{ id: "42", name: "Ula" }] },
    { bucket: BUCKETS.open, createdAt: NOW - 5 * DAY, assignees: [{ id: "7", name: "Roger" }] },
    { bucket: BUCKETS.open, createdAt: NOW - 5 * DAY, assignees: [] }
  ];
  const result = pace(tasks, { now: NOW, lastDeadline: NOW + 28 * DAY });
  assert.equal(result.leftToClose, 4);
  assert.equal(result.actualPerWeek, 1.5);
  assert.equal(result.neededPerWeek, 1);
  const people = peopleBreakdown(tasks, "42");
  assert.deepEqual(people.map((person) => [person.name, person.total]), [["Ula", 2], ["Roger", 1], ["Nobody", 1]]);
  assert.equal(people[0].isUser, true);
  const daily = dailyPace(tasks, { now: NOW, deadline: { label: "Feature freeze", date: NOW + 7 * DAY } });
  assert.equal(daily.tasks, 4);
  assert.equal(daily.workDays, 5);
  assert.equal(daily.perDay, 0.8);
  assert.equal(daily.closedToday, 1);
});

// ---- one whole project ---------------------------------------------------------

function grooveFixture() {
  const build = (id, name, status, extra = {}) =>
    mapTask(rawTask({ id, name, url: `https://app.clickup.com/t/${id}`, status: { status, type: status === "Open" ? "open" : "custom" }, dependencies: [], ...extra }));
  const planning = (id, name, status, specUrl) =>
    mapTask(rawTask({
      id,
      name,
      status: { status, type: "custom" },
      dependencies: [],
      list: { id: "901300000002", name: "Groove Planning" },
      custom_fields: specUrl ? [{ name: "Spec URL", type: "url", value: specUrl }] : []
    }));
  const dependsOn = (taskId, planningId) => ({ dependencies: [{ task_id: taskId, depends_on: planningId }] });
  const buildTasks = [
    build("86ak7bh2e", "Leaderboards", "in staging", dependsOn("86ak7bh2e", "86ajn44t6")),
    build("86ak7brvp", "Friends", "in progress", dependsOn("86ak7brvp", "86ajn44f1")),
    build("86ak7brv1", "Friends — user modal", "in progress", { parent: "86ak7brvp" }),
    build("86ak7bx9h", "Recipes", "feedback"),
    build("86ak7open", "Toast alerts", "Open", { assignees: [] }),
    build("86ak7done", "Menu", "ready for prod", { date_closed: String(NOW - 4 * DAY) })
  ];
  const planningTasks = [
    planning("86ajn44t6", "Leaderboards", "approved", "https://app.clickup.com/1281535/v/dc/173fz-212393/173fz-303673"),
    planning("86ajn44f1", "Friends", "approved", "https://app.clickup.com/1281535/v/dc/173fz-212393/173fz-300001"),
    planning("86ajn44ps", "Progress Status", "in review", "https://app.clickup.com/1281535/v/dc/173fz-212393/173fz-301613"),
    planning("86ajn44so", "Song links", "to do", null)
  ];
  const sessions = [
    { sessionId: "s-friends", title: "Friends builder", gitBranch: "CU-86ak7brvp", lastModified: NOW - 60 * 1000, statusGroup: "running" },
    { sessionId: "s-recipes", title: "recipes", firstPrompt: "https://app.clickup.com/t/86ak7bx9h", lastModified: NOW - DAY, needsAnswer: true },
    { sessionId: "s-progress", title: "spec-progress-status", firstPrompt: "planning https://app.clickup.com/t/86ajn44ps", lastModified: NOW - 2 * DAY }
  ];
  return {
    board: {
      id: "groove",
      name: "Groove",
      clickupUserId: "42",
      clickup: { buildListName: "Initial Build Web", planningListName: "Groove Planning" },
      deadlines: [
        { id: "d1", label: "Feature freeze", date: NOW + 17 * DAY },
        { id: "d2", label: "Launch", date: NOW + 50 * DAY }
      ],
      upNext: ["86ak7open"]
    },
    buildTasks,
    planningTasks,
    sessions,
    sessionAgents: { "s-friends": "agent-builder", "s-recipes": "agent-builder", "s-progress": "agent-spec" },
    agents: AGENTS,
    repositoryResults: [
      {
        repository: "blueprint",
        available: true,
        branchesByTask: {
          "86ak7bh2e": [{ repository: "blueprint", name: "CU-86ak7bh2e", local: true, pushed: true, aheadOfBase: 7, inStaging: true }],
          "86ak7brvp": [{ repository: "blueprint", name: "CU-86ak7brvp", local: true, pushed: false, aheadOfBase: 7, inStaging: false }]
        }
      }
    ],
    pullRequestResults: [{ available: true, byTask: { "86ak7bh2e": [{ number: 4812, state: "merged", ci: "passing" }] } }],
    now: NOW
  };
}

test("a whole Groove: cards, stages, filters, spec pipeline and numbers", () => {
  const snapshot = buildProjectSnapshot(grooveFixture());
  const card = (id) => snapshot.cards.find((entry) => entry.id === id);

  // Subtasks fold into their parent; unclaimed planning tasks become spec cards.
  assert.deepEqual(snapshot.cards.map((entry) => entry.id), ["86ak7bh2e", "86ak7brvp", "86ak7bx9h", "86ak7open", "86ak7done", "86ajn44ps", "86ajn44so"]);
  assert.equal(card("86ak7brvp").subtaskCount, 1);
  assert.equal(card("86ajn44ps").kind, "spec");

  // Leaderboards: planning → spec URL, merged PR, in staging → QA waits on her.
  const leaderboards = card("86ak7bh2e");
  assert.equal(leaderboards.specUrl, "https://app.clickup.com/1281535/v/dc/173fz-212393/173fz-303673");
  assert.equal(leaderboards.spec.state, "done");
  assert.equal(leaderboards.build.steps[leaderboards.build.index], "qa");
  assert.equal(leaderboards.needs.kind, "qa");

  // Friends: builder by branch, unpushed branch.
  const friends = card("86ak7brvp");
  assert.deepEqual(friends.builderSessions.map((session) => session.sessionId), ["s-friends"]);
  assert.equal(friends.build.steps[friends.build.index], "branch");
  assert.equal(friends.needs.kind, "unpushed");

  // Recipes: no planning task known, a builder session asking a question.
  assert.equal(card("86ak7bx9h").spec.known, false);
  assert.equal(card("86ak7bx9h").needs.kind, "session-question");

  // Progress Status spec: in review with its Spec Writer session.
  const progress = card("86ajn44ps");
  assert.equal(progress.spec.steps[progress.spec.index], "review");
  assert.deepEqual(progress.specSessions.map((session) => session.sessionId), ["s-progress"]);

  // My focus: things waiting on her first; Up next is kept as pinned.
  assert.equal(snapshot.filters.focus[0] === "86ak7bx9h" || snapshot.cards.find((entry) => entry.id === snapshot.filters.focus[0]).needs !== null, true);
  assert.ok(snapshot.filters.focus.includes("86ak7open"), "pinned to Up next");
  assert.ok(!snapshot.filters.focus.includes("86ak7done"), "closed tasks never in focus");
  assert.deepEqual(snapshot.filters.upNext, ["86ak7open"]);

  // Spec pipeline counts by stage.
  const stageCount = (stage) => snapshot.specPipeline.find((entry) => entry.stage === stage).count;
  assert.equal(stageCount("noSpec"), 1);
  assert.equal(stageCount("review"), 1);
  assert.equal(stageCount("approved"), 2);

  // Numbers on top count build tasks only, subtasks excluded.
  assert.equal(snapshot.stats.total, 5);
  assert.equal(snapshot.stats.buckets.inStaging, 1);
  assert.equal(snapshot.stats.buckets.done, 1);
  assert.equal(snapshot.stats.pace.leftToClose, 4);
  assert.equal(snapshot.stats.specsInReview, 1);
  assert.equal(snapshot.timeline.next.label, "Feature freeze");
  assert.equal(snapshot.dailyPace.tasks, 4);
  assert.equal(snapshot.summary.nextDeadline.daysLeft, 17);
});

// ---- the store ---------------------------------------------------------------

test("the store keeps projects, cleans what it reads and survives a broken file", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-boards-"));
  const storagePath = path.join(folder, "project-boards.json");
  const store = createProjectBoardStore({ storagePath });
  const board = store.addBoard({
    name: "  Groove  ",
    clickup: { seedTaskId: "86ak7bh2e" },
    repositories: [{ name: "blueprint", localPath: "/Users/ula/blueprint", githubSlug: "hesdevs/blueprint" }, { name: "" }],
    deadlines: [{ label: "Feature freeze", date: NOW }, { label: "", date: NOW }],
    statusOverrides: { "qa passed": "done", weird: "nonsense" }
  });
  assert.equal(board.name, "Groove");
  assert.equal(board.repositories.length, 1);
  assert.equal(board.repositories[0].stagingBranch, "docker-staging");
  assert.equal(board.deadlines.length, 1);
  assert.deepEqual(board.statusOverrides, { "qa passed": "done" });

  store.setUpNext(board.id, ["86ak7open", "86ak7open", "86ak7bx9h"]);
  store.linkSession(board.id, "86ak7bx9h", "s-1");
  store.unlinkSession(board.id, "86ak7brvp", "s-1");
  store.flush();
  const reread = readBoardsFile(storagePath).boards[0];
  assert.deepEqual(reread.upNext, ["86ak7open", "86ak7bx9h"]);
  assert.deepEqual(reread.manualLinks["86ak7bx9h"].sessionIds, ["s-1"]);
  assert.deepEqual(reread.manualLinks["86ak7brvp"].unlinkedSessionIds, ["s-1"]);

  fs.writeFileSync(storagePath, "{ not json");
  assert.deepEqual(readBoardsFile(storagePath).boards, []);
  assert.ok(fs.existsSync(`${storagePath}.bak`));
});
