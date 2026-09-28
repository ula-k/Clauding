// The Projects view's own logic, kept out of the components so it can be
// tested without a window: the list on the left (variant B), the filter
// chips and their counts, what a task card shows (its link chips and its
// two rows of dots), and the words under the deadline axis.
//
// Everything here works on the snapshot the main process builds
// (electron/lib/projectSnapshot.js) and answers with plain data. Text that
// reaches the screen is returned as { key, values } for translate(), never
// as English, so the four languages stay in one place (the locale files).

export const BUCKET_ORDER = ["open", "inProgress", "feedback", "issuesFound", "inStaging", "done"];

// One color per bucket, the same everywhere: the list's thin bar, the stack
// bar, the legend, the people bars and the status pill on a card.
export const BUCKET_COLORS = {
  open: "var(--bucket-open)",
  inProgress: "var(--bucket-in-progress)",
  feedback: "var(--bucket-feedback)",
  issuesFound: "var(--bucket-issues-found)",
  inStaging: "var(--bucket-in-staging)",
  done: "var(--bucket-done)",
  other: "var(--bucket-other)"
};

export const FILTERS = ["focus", "upNext", "specs", "build", "everything"];

export const SPEC_STAGE_ORDER = ["noSpec", "session", "draft", "review", "approved"];

const SOON_DAYS = 7;

// ---- the list on the left ----------------------------------------------------

// Bucket counts → the segments of a thin bar, left to right, empty ones
// dropped. `other` goes last so an unmapped status is still visible.
export function bucketSegments(buckets) {
  const counts = buckets || {};
  const order = [...BUCKET_ORDER, "other"];
  const total = order.reduce((sum, bucket) => sum + (counts[bucket] || 0), 0);
  if (total === 0) {
    return [];
  }
  return order
    .filter((bucket) => (counts[bucket] || 0) > 0)
    .map((bucket) => ({ bucket, count: counts[bucket], fraction: counts[bucket] / total, color: BUCKET_COLORS[bucket] }));
}

// "Feature freeze in 18 d", "Launch today", "Launch tomorrow", or none.
export function deadlineLabel(nextDeadline) {
  if (!nextDeadline) {
    return { key: "projects.noDeadline", values: {}, soon: false };
  }
  const days = nextDeadline.daysLeft;
  if (days <= 0) {
    return { key: "projects.deadlineToday", values: { label: nextDeadline.label }, soon: true };
  }
  if (days === 1) {
    return { key: "projects.deadlineTomorrow", values: { label: nextDeadline.label }, soon: true };
  }
  return { key: "projects.deadlineInDays", values: { label: nextDeadline.label, count: days }, soon: days <= SOON_DAYS };
}

// Summaries (one per project, from the cache) → groups in the order they
// first appear, each project with its bar, deadline and % closed. A project
// never loaded yet has no numbers and says so.
export function projectListModel(summaries) {
  const groups = [];
  for (const entry of summaries || []) {
    const groupName = entry.group || "Work";
    let group = groups.find((candidate) => candidate.name === groupName);
    if (!group) {
      group = { name: groupName, projects: [] };
      groups.push(group);
    }
    const summary = entry.summary;
    group.projects.push({
      id: entry.id,
      name: entry.name,
      color: entry.color ? `var(${entry.color})` : "var(--project-color-0)",
      loaded: Boolean(summary),
      leftToClose: summary ? summary.leftToClose : null,
      closedPercent: summary ? Math.round((summary.closedFraction || 0) * 100) : null,
      segments: summary ? bucketSegments(summary.buckets) : [],
      deadline: summary ? deadlineLabel(summary.nextDeadline) : deadlineLabel(null)
    });
  }
  return groups;
}

// ---- filters ------------------------------------------------------------------

// A build task nobody has started: no session, no branch, still open, not
// pinned. Build and Everything fold these behind one line.
export function isNotStarted(card) {
  return (
    card.kind === "build" &&
    card.bucket === "open" &&
    card.sessions.length === 0 &&
    card.branches.length === 0 &&
    !card.upNext &&
    !card.needs
  );
}

function sortNeedsFirst(cards) {
  return [...cards].sort((first, second) => {
    if (Boolean(first.needs) !== Boolean(second.needs)) {
      return first.needs ? -1 : 1;
    }
    return (second.lastActivity || 0) - (first.lastActivity || 0);
  });
}

// The chips above the list, each with how many cards it holds.
export function filterChips(snapshot) {
  const filters = (snapshot && snapshot.filters) || {};
  return FILTERS.map((filterId) => ({ id: filterId, count: (filters[filterId] || []).length }));
}

// The cards one chip shows: the focus list keeps its own order (needs me
// first, then latest activity), Up next keeps the pinned order, the rest
// are sorted the focus way. Build and Everything return the not-started
// ones separately so they can be folded away.
export function cardsForFilter(snapshot, filterId) {
  if (!snapshot) {
    return { cards: [], notStarted: [] };
  }
  const byId = new Map(snapshot.cards.map((card) => [card.id, card]));
  const ids = (snapshot.filters && snapshot.filters[filterId]) || [];
  const cards = ids.map((cardId) => byId.get(cardId)).filter(Boolean);
  if (filterId === "focus" || filterId === "upNext") {
    return { cards, notStarted: [] };
  }
  const sorted = sortNeedsFirst(cards);
  if (filterId === "build" || filterId === "everything") {
    return { cards: sorted.filter((card) => !isNotStarted(card)), notStarted: sorted.filter(isNotStarted) };
  }
  return { cards: sorted, notStarted: [] };
}

// The spec pipeline (variant C): which stage is opened below the counters
// when the user has not picked one — the one waiting on her review if it
// has anything, else the first stage that is not empty.
export function defaultSpecStage(specPipeline) {
  const stages = specPipeline || [];
  const review = stages.find((stage) => stage.stage === "review" && stage.count > 0);
  if (review) {
    return review.stage;
  }
  const firstFilled = stages.find((stage) => stage.count > 0 && stage.stage !== "approved");
  return firstFilled ? firstFilled.stage : SPEC_STAGE_ORDER[0];
}

// ---- a task card ----------------------------------------------------------------

// A stage from pipelineStage.js → one entry per dot: "done" before the
// current step, the current step "now" or "wait", "todo" after it. A stage
// that has not started (index -1) is all "todo"; a finished one all "done".
export function pipelineDots(stage) {
  if (!stage || !Array.isArray(stage.steps)) {
    return [];
  }
  return stage.steps.map((step, index) => {
    let state = "todo";
    if (stage.state === "done" && stage.index >= 0) {
      state = index <= stage.index ? "done" : "todo";
    } else if (index < stage.index) {
      state = "done";
    } else if (index === stage.index) {
      state = stage.state === "wait" ? "wait" : "now";
    }
    return { step, state };
  });
}

// What a session chip says after its title.
export function sessionStateLabel(session, now) {
  if (session.needsAnswer) {
    return { key: "projects.sessionNeedsAnswer", values: {} };
  }
  if (session.statusGroup === "running") {
    return { key: "projects.sessionWorking", values: {} };
  }
  if (!session.lastModified) {
    return { key: "projects.sessionIdle", values: {} };
  }
  const days = Math.floor((now - session.lastModified) / (24 * 60 * 60 * 1000));
  if (days < 1) {
    return { key: "projects.sessionIdle", values: {} };
  }
  return { key: "projects.sessionIdleDays", values: { count: days } };
}

export function sessionTone(session) {
  if (session.needsAnswer) {
    return "wait";
  }
  if (session.statusGroup === "running") {
    return "now";
  }
  return "idle";
}

// The chips under a card, in the order the mockup draws them: the task in
// ClickUp, its spec, the spec sessions, the builder sessions, the branches
// (one per repository) and the pull request. Something that should be
// there and is not yet is a "missing" chip (drawn dashed).
export function cardLinks(card, { pullRequestsAvailable = true } = {}) {
  const links = [];
  links.push({ kind: "clickup", taskId: card.id, label: `CU-${card.id}`, url: card.url });
  if (card.kind === "build") {
    if (card.specUrl) {
      links.push({ kind: "spec", url: card.specUrl, label: card.planning ? card.planning.name : card.name });
    } else if (card.planning) {
      links.push({ kind: "planning", taskId: card.planning.id, label: card.planning.name, url: card.planning.url });
    } else if (card.spec && card.spec.known === false) {
      links.push({ kind: "missing", reason: "noSpecLinked" });
    }
  } else if (card.specUrl) {
    links.push({ kind: "spec", url: card.specUrl, label: card.name });
  } else {
    links.push({ kind: "missing", reason: "noSpecPage" });
  }
  for (const session of card.specSessions || []) {
    links.push({ kind: "session", role: "spec", session });
  }
  for (const session of card.builderSessions || []) {
    links.push({ kind: "session", role: session.role === "builder" ? "builder" : "other", session });
  }
  if (card.kind === "spec" && (card.specSessions || []).length === 0) {
    links.push({ kind: "missing", reason: "noSpecSession" });
  }
  if (card.kind === "spec") {
    return links;
  }
  const buildStarted = card.build && card.build.index >= 0;
  const buildDone = card.bucket === "done";
  if ((card.builderSessions || []).length === 0 && buildStarted && !buildDone && card.bucket !== "inStaging") {
    links.push({ kind: "missing", reason: "noBuilder" });
  }
  for (const branch of card.branches || []) {
    links.push({
      kind: "branch",
      repository: branch.repository,
      name: branch.name,
      ahead: branch.aheadOfBase,
      pushed: branch.pushed,
      uncommitted: Boolean(branch.uncommitted),
      inStaging: branch.inStaging === true,
      worktree: Boolean(branch.worktreePath)
    });
  }
  const pullRequest = (card.pullRequests || [])[0] || null;
  if (pullRequest) {
    links.push({
      kind: "pullRequest",
      repository: pullRequest.repository,
      number: pullRequest.number,
      state: pullRequest.state,
      ci: pullRequest.ci,
      url: pullRequest.url
    });
  } else if ((card.branches || []).length > 0 && !buildDone) {
    if (!pullRequestsAvailable) {
      links.push({ kind: "missing", reason: "ghUnavailable" });
    } else if (card.branches.some((branch) => branch.local && !branch.pushed)) {
      links.push({ kind: "missing", reason: "notPushed" });
    } else {
      links.push({ kind: "missing", reason: "noPullRequest" });
    }
  }
  return links;
}

// The gold pill on a card: which sentence, with what in it.
export function needsLabel(needs) {
  if (!needs) {
    return null;
  }
  const values = { title: needs.title || "", number: needs.number || "", branch: needs.branch || "" };
  const keys = {
    "session-question": "projects.needsSessionQuestion",
    "red-ci": "projects.needsRedCi",
    "spec-review": "projects.needsSpecReview",
    feedback: "projects.needsFeedback",
    qa: "projects.needsQa",
    unpushed: "projects.needsUnpushed"
  };
  return { key: keys[needs.kind] || "projects.needsSomething", values };
}

// ---- deadlines and numbers ----------------------------------------------------------

// The proposed line under the axis: "To make Feature freeze: 17 tasks in
// 13 work days → about 1–2 a day", and today's dots. Computed, never
// approved as a goal — the view labels it so.
export function dailyPaceText(dailyPace) {
  if (!dailyPace || dailyPace.tasks === 0) {
    return null;
  }
  const range =
    dailyPace.perDayLow === dailyPace.perDayHigh || dailyPace.perDayLow === 0
      ? String(Math.max(dailyPace.perDayHigh, 1))
      : `${dailyPace.perDayLow}–${dailyPace.perDayHigh}`;
  const todayTarget = Math.max(dailyPace.todayTarget || 0, 1);
  return {
    key: "projects.paceLine",
    values: { label: dailyPace.deadlineLabel, tasks: dailyPace.tasks, days: dailyPace.workDays, range },
    todayTarget,
    closedToday: dailyPace.closedToday,
    todayDots: Array.from({ length: Math.max(todayTarget, Math.min(dailyPace.closedToday, 8)) }, (unused, index) => index < dailyPace.closedToday)
  };
}

// Deadline labels on the axis alternate above and below when two of them
// would overlap; `minimumGap` is a fraction of the axis.
export function axisMilestones(timeline, { minimumGap = 0.2 } = {}) {
  if (!timeline || !Array.isArray(timeline.deadlines)) {
    return [];
  }
  let lastAt = -1;
  let lastRow = 1;
  return timeline.deadlines.map((deadline) => {
    const next = timeline.next && timeline.next.id === deadline.id && timeline.next.date === deadline.date;
    let row = 0;
    if (lastAt >= 0 && deadline.at - lastAt < minimumGap) {
      row = lastRow === 0 ? 1 : 0;
    }
    lastAt = deadline.at;
    lastRow = row;
    return { ...deadline, state: deadline.passed ? "done" : next ? "next" : "later", row };
  });
}

// The small burn-down line: open tasks per week, as SVG points in a box of
// the given size (the newest point on the right).
export function burnDownPoints(history, { width, height }) {
  const points = history || [];
  if (points.length < 2) {
    return "";
  }
  const highest = Math.max(...points.map((point) => point.open), 1);
  const step = width / (points.length - 1);
  return points
    .map((point, index) => {
      const horizontal = Math.round(index * step * 10) / 10;
      const vertical = Math.round((height - (point.open / highest) * (height - 2) - 1) * 10) / 10;
      return `${horizontal},${vertical}`;
    })
    .join(" ");
}

// What the header says about the data: fresh, offline with the cached
// copy, no token, or an error with the call that failed.
export function sourceState(snapshot) {
  const clickup = snapshot && snapshot.sources ? snapshot.sources.clickup : null;
  if (!clickup || clickup.ok) {
    return { kind: "ok", refreshedAt: clickup ? clickup.refreshedAt : null };
  }
  if (clickup.error === "no-token" || clickup.error === "unauthorized") {
    return { kind: clickup.error === "no-token" ? "noToken" : "badToken", refreshedAt: clickup.refreshedAt };
  }
  if (clickup.error === "no-list") {
    return { kind: "noList", refreshedAt: null };
  }
  if (clickup.error === "network") {
    return { kind: "offline", refreshedAt: clickup.refreshedAt };
  }
  return { kind: "error", refreshedAt: clickup.refreshedAt, message: clickup.message || "", call: clickup.call || "" };
}
