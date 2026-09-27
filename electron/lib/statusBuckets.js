// Projects view: where a ClickUp status lands.
//
// Every list has its own statuses ("in staging", "ready for prod", "pending
// review"…), and the overview only has room for six buckets. A status is
// matched by its name first, then by the type ClickUp gives it (open /
// custom / closed / done); anything that fits neither shows up as "other"
// instead of being quietly counted somewhere wrong. A project can override
// single statuses by name (board.statusOverrides).
//
// Planning tasks — the ones whose Spec URL field points at a spec page — go
// through the same idea with their own stages (see specStageForStatus).

export const BUCKETS = {
  open: "open",
  inProgress: "inProgress",
  feedback: "feedback",
  issuesFound: "issuesFound",
  inStaging: "inStaging",
  done: "done",
  other: "other"
};

// The order the overview draws them in, left to right.
export const BUCKET_ORDER = [
  BUCKETS.open,
  BUCKETS.inProgress,
  BUCKETS.feedback,
  BUCKETS.issuesFound,
  BUCKETS.inStaging,
  BUCKETS.done
];

// Checked top to bottom; the first rule whose words appear in the status
// name wins. "ready for prod" is done for this view: nothing is left for a
// developer to do, only a release.
const BUCKET_RULES = [
  { bucket: BUCKETS.done, words: ["ready for prod", "release candidate", "in prod", "released", "document", "closed", "complete", "done", "shipped"] },
  { bucket: BUCKETS.inStaging, words: ["staging", "in qa", "qa"] },
  { bucket: BUCKETS.issuesFound, words: ["issues found", "issue found", "bug", "failed", "rejected", "reopened"] },
  { bucket: BUCKETS.feedback, words: ["feedback", "in review", "code review", "waiting", "blocked", "on hold"] },
  { bucket: BUCKETS.inProgress, words: ["in progress", "progress", "doing", "building", "development", "active"] },
  { bucket: BUCKETS.open, words: ["pending review", "open", "to do", "todo", "backlog", "not started", "new", "planned"] }
];

function normalizeStatusName(statusName) {
  return String(statusName || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function matchesWord(statusName, word) {
  // Whole words only, so "prod" never matches inside "product".
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(statusName);
}

export function bucketForStatus(statusName, statusType, overrides = {}) {
  const normalized = normalizeStatusName(statusName);
  const override = Object.entries(overrides || {}).find(
    ([overriddenName]) => normalizeStatusName(overriddenName) === normalized
  );
  if (override && Object.values(BUCKETS).includes(override[1])) {
    return override[1];
  }
  for (const rule of BUCKET_RULES) {
    if (rule.words.some((word) => matchesWord(normalized, word))) {
      return rule.bucket;
    }
  }
  if (statusType === "closed" || statusType === "done") {
    return BUCKETS.done;
  }
  if (statusType === "open") {
    return BUCKETS.open;
  }
  return BUCKETS.other;
}

export function isClosedBucket(bucket) {
  return bucket === BUCKETS.done;
}

// ---- Spec stages ---------------------------------------------------------

export const SPEC_STAGES = {
  noSpec: "noSpec",
  session: "session",
  draft: "draft",
  review: "review",
  approved: "approved"
};

export const SPEC_STAGE_ORDER = [
  SPEC_STAGES.noSpec,
  SPEC_STAGES.session,
  SPEC_STAGES.draft,
  SPEC_STAGES.review,
  SPEC_STAGES.approved
];

// Review is checked before approved so "ready for review" is not read as
// ready.
const SPEC_STAGE_RULES = [
  { stage: SPEC_STAGES.review, words: ["review", "approval", "feedback", "waiting"] },
  { stage: SPEC_STAGES.approved, words: ["approved", "ready for dev", "ready for development", "ready", "done", "closed", "complete", "published"] },
  { stage: SPEC_STAGES.draft, words: ["draft", "writing", "in progress", "progress", "spec"] },
  { stage: SPEC_STAGES.noSpec, words: ["open", "to do", "todo", "backlog", "not started", "new"] }
];

// What the planning task's own status says about its spec. The session
// stage is not a ClickUp status: pipelineStage.js raises "noSpec" to
// "session" when a Spec Writer session is linked to the task.
export function specStageForStatus(statusName, statusType, overrides = {}) {
  const normalized = normalizeStatusName(statusName);
  const override = Object.entries(overrides || {}).find(
    ([overriddenName]) => normalizeStatusName(overriddenName) === normalized
  );
  if (override && SPEC_STAGE_ORDER.includes(override[1])) {
    return override[1];
  }
  for (const rule of SPEC_STAGE_RULES) {
    if (rule.words.some((word) => matchesWord(normalized, word))) {
      return rule.stage;
    }
  }
  if (statusType === "closed" || statusType === "done") {
    return SPEC_STAGES.approved;
  }
  return SPEC_STAGES.noSpec;
}
