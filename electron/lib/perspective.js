// Projects view: where a task stands *from the user's side*.
//
// ClickUp's statuses say where a task is in the team's process; the user
// needs to know whether it is on her plate. Every status lands in one of
// three places:
//
//   myQueue  I must act: open, in progress, issues found, ready for prod
//            (the deploy is hers again)
//   waiting  nothing from me right now: feedback, in staging, in QA,
//            a release candidate
//   closed   final: in prod, released, closed
//
// A task on staging is not done — it is waiting, and it can come back
// (issues found) or move on to "ready for prod", which is the user's work
// again. Every number that says "left", "pace" or "per day" counts tasks
// leaving the queue, and a task that comes back re-enters it.
//
// The defaults are matched by the status's words, then by its bucket; a
// project can move any status (board.perspectiveOverrides) and can let a
// developer-status custom field decide (board.developerStatusMap: value →
// place). The field is the project's choice (board.developerStatusFieldName)
// or detected: a drop-down whose name mentions "dev", else one whose name
// ends in "status" and is not QA's.
import { BUCKETS } from "./statusBuckets.js";

export const PERSPECTIVES = { myQueue: "myQueue", waiting: "waiting", closed: "closed" };
export const PERSPECTIVE_ORDER = [PERSPECTIVES.myQueue, PERSPECTIVES.waiting, PERSPECTIVES.closed];

// Checked top to bottom, whole words: "ready for prod" is the user's again
// before "prod" could read as closed.
const PERSPECTIVE_RULES = [
  { perspective: PERSPECTIVES.myQueue, words: ["ready for prod", "ready for deploy", "ready to deploy", "ready for release", "to deploy"] },
  { perspective: PERSPECTIVES.closed, words: ["in prod", "released", "shipped", "closed", "complete", "completed", "done", "document", "archived"] },
  { perspective: PERSPECTIVES.waiting, words: ["release candidate", "staging", "qa", "in review", "code review", "feedback", "waiting", "blocked", "on hold"] }
];

const BUCKET_DEFAULTS = {
  [BUCKETS.open]: PERSPECTIVES.myQueue,
  [BUCKETS.inProgress]: PERSPECTIVES.myQueue,
  [BUCKETS.issuesFound]: PERSPECTIVES.myQueue,
  [BUCKETS.feedback]: PERSPECTIVES.waiting,
  [BUCKETS.inStaging]: PERSPECTIVES.waiting,
  [BUCKETS.done]: PERSPECTIVES.closed,
  [BUCKETS.other]: PERSPECTIVES.myQueue
};

function normalize(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hasWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(text);
}

function overrideFor(overrides, key) {
  const wanted = normalize(key);
  const entry = Object.entries(overrides || {}).find(([name]) => normalize(name) === wanted);
  return entry && PERSPECTIVE_ORDER.includes(entry[1]) ? entry[1] : null;
}

// Where a status lands with no project settings at all.
export function automaticPerspective(statusName, statusType, bucket) {
  const name = normalize(statusName);
  for (const rule of PERSPECTIVE_RULES) {
    if (rule.words.some((word) => hasWord(name, word))) {
      return rule.perspective;
    }
  }
  if (statusType === "closed" || statusType === "done") {
    return PERSPECTIVES.closed;
  }
  return BUCKET_DEFAULTS[bucket] || PERSPECTIVES.myQueue;
}

export function perspectiveForStatus(statusName, statusType, bucket, overrides = {}) {
  return overrideFor(overrides, statusName) || automaticPerspective(statusName, statusType, bucket);
}

// fields: [{ name, type }] → the developer-status field's name, or null.
export function detectDeveloperStatusField(fields) {
  const dropDowns = (fields || []).filter((field) => field && field.type === "drop_down" && field.name);
  const byDev = dropDowns.find((field) => /dev/i.test(field.name));
  if (byDev) {
    return byDev.name;
  }
  const byStatus = dropDowns.find((field) => /status\s*$/i.test(field.name.trim()) && !/\bqa\b/i.test(field.name));
  return byStatus ? byStatus.name : null;
}

export function developerStatusFieldOf(board, fields) {
  const chosen = board && board.developerStatusFieldName ? String(board.developerStatusFieldName).trim() : "";
  return chosen || detectDeveloperStatusField(fields);
}

// A task's value of that field (the option's name), or null.
export function developerStatusOf(task, fieldName) {
  if (!fieldName) {
    return null;
  }
  const wanted = normalize(fieldName);
  const field = (task.customFields || []).find((candidate) => normalize(candidate.name) === wanted);
  if (!field || field.value === null || field.value === undefined || field.value === "") {
    return null;
  }
  return String(field.value);
}

// The task's place: the developer field when the project mapped its value,
// else the status.
export function taskPerspective(task, { overrides = {}, developerFieldName = null, developerStatusMap = {} } = {}) {
  const developerStatus = developerStatusOf(task, developerFieldName);
  const fromField = developerStatus ? overrideFor(developerStatusMap, developerStatus) : null;
  return {
    perspective: fromField || perspectiveForStatus(task.status, task.statusType, task.bucket, overrides),
    developerStatus,
    decidedBy: fromField ? "developerStatus" : "status"
  };
}

// ---- movement over time ------------------------------------------------------

// ClickUp's time in status for one task ([{ status, type, since }], one
// entry per status with the time it was first entered) → the task's path
// through the three places, oldest first, repeats merged.
export function perspectivePath(statusHistory, { bucketOf, overrides = {} }) {
  const steps = (statusHistory || [])
    .filter((entry) => entry && Number.isFinite(entry.since))
    .sort((first, second) => first.since - second.since)
    .map((entry) => ({ at: entry.since, perspective: perspectiveForStatus(entry.status, entry.type, bucketOf(entry.status, entry.type), overrides) }));
  const path = [];
  for (const step of steps) {
    if (path.length === 0 || path[path.length - 1].perspective !== step.perspective) {
      path.push(step);
    }
  }
  return path;
}

// Where a task was at a moment, from its path; before its first step it
// did not exist yet (null).
export function perspectiveAt(path, time) {
  let current = null;
  for (const step of path || []) {
    if (step.at <= time) {
      current = step.perspective;
    }
  }
  return current;
}

// Moments the task left the queue (myQueue → waiting / closed), and came
// back into it.
export function queueMoves(path) {
  const left = [];
  const returned = [];
  for (let position = 1; position < (path || []).length; position += 1) {
    const before = path[position - 1].perspective;
    const after = path[position].perspective;
    if (before === PERSPECTIVES.myQueue && after !== PERSPECTIVES.myQueue) {
      left.push(path[position].at);
    } else if (before !== PERSPECTIVES.myQueue && after === PERSPECTIVES.myQueue) {
      returned.push(path[position].at);
    }
  }
  return { left, returned };
}

// A path for a task ClickUp gave no history for: from the moves this app
// saw between two refreshes (the cache keeps them), else from its close
// date, else where it is now, since it was created.
export function fallbackPath(task, perspective, observedMoves = []) {
  const created = task.createdAt || 0;
  const moves = (observedMoves || []).filter((move) => move.taskId === task.id).sort((first, second) => first.at - second.at);
  if (moves.length === 0) {
    // ClickUp's own close date is a hand-off the list answer does carry.
    const closedAt = task.closedAt || task.doneAt || null;
    if (perspective !== PERSPECTIVES.myQueue && closedAt && closedAt >= created) {
      return [
        { at: created, perspective: PERSPECTIVES.myQueue },
        { at: closedAt, perspective }
      ];
    }
    return [{ at: created, perspective }];
  }
  const path = [{ at: created, perspective: moves[0].from }];
  for (const move of moves) {
    path.push({ at: move.at, perspective: move.to });
  }
  return path;
}
