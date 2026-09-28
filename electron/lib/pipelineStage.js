// Projects view: where a task is in the user's own pipeline — the two rows
// of dots on a task card — and whether it is waiting on the user.
//
//   Spec:  noSpec → session → draft → review → approved
//   Build: open → builder → branch → PR → staging → QA → prod
//
// A stage is { steps, index, state }: `index` is the current step, every
// step before it is done, `state` is "now" (moving) or "wait" (standing on
// the user). A build that has not started because its spec is not approved
// yet has index -1.
import { BUCKETS, SPEC_STAGES, SPEC_STAGE_ORDER, specStageForStatus } from "./statusBuckets.js";
import { SESSION_ROLES } from "./taskLinker.js";

export const BUILD_STEPS = ["open", "builder", "branch", "pr", "staging", "qa", "prod"];
export const SPEC_STEPS = SPEC_STAGE_ORDER;

const STATE_NOW = "now";
const STATE_WAIT = "wait";
const STATE_DONE = "done";

export function specStage({ planningTask, specSessions = [], statusOverrides = {} }) {
  let stage = planningTask
    ? specStageForStatus(planningTask.status, planningTask.statusType, statusOverrides)
    : SPEC_STAGES.noSpec;
  // A task with no planning task but already being built: its spec lives
  // somewhere else, and whoever built it had one. Treat it as approved
  // rather than drawing a red "no spec".
  if (!planningTask && specSessions.length === 0) {
    return { steps: SPEC_STEPS, index: SPEC_STEPS.length - 1, state: STATE_DONE, known: false };
  }
  if (stage === SPEC_STAGES.noSpec && specSessions.length > 0) {
    stage = SPEC_STAGES.session;
  }
  const index = SPEC_STEPS.indexOf(stage);
  if (stage === SPEC_STAGES.approved) {
    return { steps: SPEC_STEPS, index, state: STATE_DONE, known: true };
  }
  const waitsOnUser = stage === SPEC_STAGES.review || specSessions.some((session) => session.needsAnswer);
  return { steps: SPEC_STEPS, index, state: waitsOnUser ? STATE_WAIT : STATE_NOW, known: true };
}

// `branches` = every CU branch of this task across repos (gitInspector),
// `pullRequests` = its PRs across repos (pullRequests.js), newest first.
export function buildStage({ bucket, builderSessions = [], branches = [], pullRequests = [], specApproved = true }) {
  if (!specApproved && bucket === BUCKETS.open && builderSessions.length === 0 && branches.length === 0) {
    return { steps: BUILD_STEPS, index: -1, state: STATE_NOW };
  }
  let index = 0;
  if (builderSessions.length > 0) {
    index = 1;
  }
  if (branches.length > 0) {
    index = 2;
  }
  if (pullRequests.length > 0) {
    index = 3;
  }
  if (branches.some((branch) => branch.inStaging) || pullRequests.some((pull) => pull.state === "merged")) {
    index = 4;
  }
  if (bucket === BUCKETS.inStaging || bucket === BUCKETS.issuesFound) {
    index = Math.max(index, 5);
  }
  if (bucket === BUCKETS.done) {
    return { steps: BUILD_STEPS, index: BUILD_STEPS.length - 1, state: STATE_DONE };
  }
  const waitsOnUser =
    bucket === BUCKETS.feedback ||
    bucket === BUCKETS.inStaging ||
    builderSessions.some((session) => session.needsAnswer) ||
    pullRequests.some((pull) => pull.state === "open" && pull.ci === "failing");
  return { steps: BUILD_STEPS, index, state: waitsOnUser ? STATE_WAIT : STATE_NOW };
}

// The gold "● …" pill on a card: the one thing the task is waiting on the
// user for, most urgent first, or null.
export function whatNeedsUser({ bucket, spec, sessions = [], branches = [], pullRequests = [], assignedToUser }) {
  const blocked = sessions.find((session) => session.needsAnswer);
  if (blocked) {
    return { kind: "session-question", sessionId: blocked.sessionId, title: blocked.title, label: `${blocked.title} needs an answer` };
  }
  const redPull = pullRequests.find((pull) => pull.state === "open" && pull.ci === "failing");
  if (redPull) {
    return { kind: "red-ci", number: redPull.number, label: `CI failing on PR #${redPull.number}` };
  }
  if (spec && spec.known && spec.steps[spec.index] === SPEC_STAGES.review) {
    return { kind: "spec-review", label: "spec waiting for your approval" };
  }
  if (bucket === BUCKETS.feedback && assignedToUser) {
    return { kind: "feedback", label: "waiting for your feedback" };
  }
  if (bucket === BUCKETS.inStaging && assignedToUser) {
    return { kind: "qa", label: "QA on staging" };
  }
  const unpushed = branches.find((branch) => branch.local && !branch.pushed && (branch.aheadOfBase || 0) > 0);
  if (unpushed && sessions.some((session) => session.role === SESSION_ROLES.builder)) {
    return { kind: "unpushed", branch: unpushed.name, label: `${unpushed.name} not pushed` };
  }
  return null;
}
