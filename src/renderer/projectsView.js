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
      inQueue: summary ? (summary.inQueue !== undefined ? summary.inQueue : summary.leftToClose) : null,
      waiting: summary ? summary.waiting || 0 : null,
      closed: summary ? summary.closed || 0 : null,
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
// A project without ClickUp has no specs, so it has no Specs chip either.
export function filterChips(snapshot) {
  const filters = (snapshot && snapshot.filters) || {};
  const gitOnly = Boolean(snapshot && snapshot.mode === "git");
  return FILTERS.filter((filterId) => !(gitOnly && filterId === "specs")).map((filterId) => ({ id: filterId, count: (filters[filterId] || []).length }));
}

// The cards one chip shows: the focus list keeps its own order (needs me
// first, then latest activity), Up next keeps the pinned order, the rest
// are sorted the focus way. My focus, Build and Everything return the
// not-started ones separately so they can be folded away.
export function cardsForFilter(snapshot, filterId) {
  if (!snapshot) {
    return { cards: [], notStarted: [] };
  }
  const byId = new Map(snapshot.cards.map((card) => [card.id, card]));
  const ids = (snapshot.filters && snapshot.filters[filterId]) || [];
  const cards = ids.map((cardId) => byId.get(cardId)).filter(Boolean);
  if (filterId === "upNext") {
    return { cards, notStarted: [] };
  }
  const sorted = filterId === "focus" ? cards : sortNeedsFirst(cards);
  if (filterId === "focus" || filterId === "build" || filterId === "everything") {
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
    // After the hand-off step (staging) the work is other people's.
    const others = Number.isInteger(stage.handOffIndex) && index > stage.handOffIndex;
    return { step, state, others, handOff: Number.isInteger(stage.handOffIndex) && index === stage.handOffIndex };
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
  // A card of a project without ClickUp is a branch: no task to link to and
  // no spec to ask for — its chips start at the sessions.
  const gitOnly = card.source === "git";
  if (!gitOnly) {
    links.push({ kind: "clickup", taskId: card.id, label: `CU-${card.id}`, url: card.url });
  }
  if (!gitOnly && card.kind === "build") {
    if (card.specUrl) {
      links.push({ kind: "spec", url: card.specUrl, label: card.planning ? card.planning.name : card.name });
    } else if (card.planning) {
      links.push({ kind: "planning", taskId: card.planning.id, label: card.planning.name, url: card.planning.url });
    } else if (card.spec && card.spec.known === false) {
      links.push({ kind: "missing", reason: "noSpecLinked" });
    }
  } else if (!gitOnly && card.specUrl) {
    links.push({ kind: "spec", url: card.specUrl, label: card.name });
  } else if (!gitOnly) {
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
  if (!gitOnly && (card.builderSessions || []).length === 0 && buildStarted && !buildDone && card.bucket !== "inStaging") {
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
  const handedOff = dailyPace.handedOffToday !== undefined ? dailyPace.handedOffToday : dailyPace.closedToday || 0;
  // Less than one a day reads better per week ("about 3 a week").
  const weekly = Number.isFinite(dailyPace.perDay) && dailyPace.perDay < 1;
  const perWeek = Number.isFinite(dailyPace.perWeek) ? dailyPace.perWeek : Math.round(dailyPace.perDay * 50) / 10;
  const weekRange = String(Math.max(Math.round(perWeek), 1));
  return {
    key: weekly ? "projects.paceLineWeekly" : "projects.paceLine",
    values: { label: dailyPace.deadlineLabel, tasks: dailyPace.tasks, days: dailyPace.workDays, range: weekly ? weekRange : range },
    weekly,
    todayKey: weekly ? "projects.handedOffTodayWeekly" : "projects.handedOffToday",
    todayTargetText: weekly ? weekRange : String(todayTarget),
    todayTarget,
    handedOffToday: handedOff,
    closedToday: handedOff,
    todayDots: Array.from({ length: Math.max(todayTarget, Math.min(handedOff, 8)) }, (unused, index) => index < handedOff)
  };
}

// Deadline labels on the axis alternate above and below when two of them
// would overlap; `minimumGap` is a fraction of the axis.
export function axisMilestones(timeline, { minimumGap = 0.2 } = {}) {
  if (!timeline || !Array.isArray(timeline.deadlines)) {
    return [];
  }
  // Single dates only (phases are drawn as bars, see phaseLanes); several
  // on the same day become one marker that names them all.
  const merged = [];
  for (const deadline of timeline.deadlines.filter((entry) => !Number.isFinite(entry.start))) {
    const sameDay = merged.find((entry) => new Date(entry.date).toDateString() === new Date(deadline.date).toDateString());
    if (sameDay) {
      sameDay.label = `${sameDay.label} · ${deadline.label}`;
      sameDay.together = (sameDay.together || 1) + 1;
      continue;
    }
    merged.push({ ...deadline });
  }
  let lastAt = -1;
  let lastRow = 1;
  return merged.map((deadline) => {
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

// Phases (start → end) as bars in lanes under the axis: a phase goes in the
// first lane where it does not overlap what is already there — its bar, its
// "…" button and, when its name does not fit inside the bar, the name drawn
// next to it. So two phases with the same dates get two lanes, and a name
// outside its bar never runs into the next bar. `axisWidth` (pixels) and
// `labelOf(phase)` are what the placement is measured with; without them
// only the bars count.
const PHASE_MORE_PIXELS = 24;
const PHASE_GAP_PIXELS = 6;
export function phaseLanes(timeline, { axisWidth = 0, labelOf = null } = {}) {
  const phases = ((timeline && timeline.deadlines) || []).filter((deadline) => Number.isFinite(deadline.start));
  const lanes = [];
  const pixel = axisWidth > 0 ? 1 / axisWidth : 0;
  for (const phase of [...phases].sort((first, second) => first.start - second.start)) {
    const insideText = labelOf ? labelOf(phase) : "";
    const outsideText = labelOf ? labelOf(phase, true) : "";
    const placement = labelOf ? phaseLabelPlacement(phase, axisWidth, insideText) : "inside";
    const outsidePixels = placement === "inside" ? 0 : String(outsideText).length * PHASE_LABEL_CHARACTER_PIXELS + 8;
    const from = placement === "left" ? phase.startAt - outsidePixels * pixel : phase.startAt;
    // The "…" sits inside the right end of a bar wide enough for it (and
    // its name), else just after the bar.
    const barPixels = (phase.at - phase.startAt) * axisWidth;
    const moreInside = placement === "inside" && barPixels >= 60;
    const to = phase.at + ((moreInside ? 0 : PHASE_MORE_PIXELS) + (placement === "right" ? outsidePixels : 0)) * pixel;
    let lane = lanes.find((candidate) => candidate.occupiedTo + PHASE_GAP_PIXELS * pixel <= from && candidate.lastDate < phase.start);
    if (!lane) {
      lane = { phases: [], occupiedTo: -1, lastDate: -Infinity };
      lanes.push(lane);
    }
    lane.phases.push({ ...phase, placement, moreInside, state: phase.passed ? "done" : phase.running ? "running" : "later" });
    lane.occupiedTo = Math.max(lane.occupiedTo, to);
    lane.lastDate = Math.max(lane.lastDate, phase.date);
  }
  return lanes.map((lane) => lane.phases);
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
  return {
    kind: "error",
    refreshedAt: clickup.refreshedAt,
    message: clickup.message || "",
    call: clickup.call || "",
    error: clickupErrorLabel(clickup.error, clickup.status)
  };
}

// A ClickUp failure, as a sentence of the locale files.
export function clickupErrorLabel(kind, status) {
  const keys = {
    "not-found": "projects.clickupError.notFound",
    "rate-limited": "projects.clickupError.rateLimited",
    network: "projects.clickupError.network",
    unauthorized: "projects.clickupError.unauthorized",
    "no-token": "projects.clickupError.noToken"
  };
  return { key: keys[kind] || "projects.clickupError.http", values: { status: status || "?" } };
}

// ---- search ---------------------------------------------------------------------

function normalizeForSearch(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function matchesQuery(query, ...texts) {
  const wanted = normalizeForSearch(query);
  if (!wanted) {
    return true;
  }
  return texts.some((text) => normalizeForSearch(text).includes(wanted));
}

// "Search projects and tasks" on the left: every project whose name
// matches, and every project with tasks that match (at most a few of them
// listed under it, from the cached ClickUp answer). An empty query keeps
// the whole list.
export const SEARCH_TASKS_PER_PROJECT = 5;

export function searchProjects(summaries, query) {
  const list = summaries || [];
  if (!normalizeForSearch(query)) {
    return list.map((summary) => ({ ...summary, matchingTasks: [], hiddenMatches: 0 }));
  }
  const found = [];
  for (const summary of list) {
    const nameMatches = matchesQuery(query, summary.name);
    const tasks = (summary.tasks || []).filter((task) =>
      matchesQuery(query, task.name, task.id, `CU-${task.id}`, task.customId)
    );
    if (nameMatches || tasks.length > 0) {
      found.push({
        ...summary,
        matchingTasks: tasks.slice(0, SEARCH_TASKS_PER_PROJECT),
        hiddenMatches: Math.max(tasks.length - SEARCH_TASKS_PER_PROJECT, 0)
      });
    }
  }
  return found;
}

// The search box above the task cards: a card matches by its name, its
// task id (with or without "CU-"), its ClickUp status, its assignees, its
// spec's name and its branch names.
export function searchCards(cards, query) {
  if (!normalizeForSearch(query)) {
    return cards || [];
  }
  return (cards || []).filter((card) =>
    matchesQuery(
      query,
      card.name,
      card.id,
      `CU-${card.id}`,
      card.customId,
      card.status,
      card.planning ? card.planning.name : "",
      ...(card.assignees || []).map((person) => person.name),
      ...(card.branches || []).map((branch) => branch.name)
    )
  );
}

// ---- a click on a number ----------------------------------------------------------

// The numbers on top are filters too: a bucket, a person, the spec counters
// and red CI each narrow the cards to the ones they count. The answer names
// the filter for the chip that says it is on ({ key, values }).
export function cardsForStat(snapshot, stat) {
  if (!snapshot || !stat) {
    return [];
  }
  const cards = snapshot.cards || [];
  const build = cards.filter((card) => card.kind === "build");
  if (stat.kind === "bucket") {
    return build.filter((card) => (card.bucket || "other") === stat.bucket);
  }
  if (stat.kind === "person") {
    return build.filter(
      (card) =>
        card.bucket !== "done" &&
        (stat.personId === null
          ? (card.assignees || []).length === 0
          : (card.assignees || []).some((person) => String(person.id) === String(stat.personId)))
    );
  }
  if (stat.kind === "perspective") {
    return build.filter((card) => card.perspective === stat.perspective);
  }
  if (stat.kind === "specsToWrite") {
    return cards.filter((card) => card.planning && ["noSpec", "session", "draft"].includes(card.spec.steps[card.spec.index]));
  }
  if (stat.kind === "specsInReview") {
    return cards.filter((card) => card.planning && card.spec.steps[card.spec.index] === "review");
  }
  if (stat.kind === "redCi") {
    return cards.filter((card) => (card.pullRequests || []).some((pull) => pull.state === "open" && pull.ci === "failing"));
  }
  return [];
}

export function statFilterLabel(stat) {
  if (!stat) {
    return null;
  }
  if (stat.kind === "bucket") {
    return { key: "projects.statFilter.bucket", values: { name: `projects.bucket.${stat.bucket}` }, translateName: true };
  }
  if (stat.kind === "person") {
    return { key: "projects.statFilter.person", values: { name: stat.name || "" }, translateName: false };
  }
  if (stat.kind === "perspective") {
    return { key: "projects.statFilter.bucket", values: { name: `projects.perspective.${stat.perspective}` }, translateName: true };
  }
  return { key: `projects.statFilter.${stat.kind}`, values: {}, translateName: false };
}

// ---- deadlines --------------------------------------------------------------------

// Why the deadline axis is empty, honestly: the project has no deadline of
// its own, and ClickUp has no dates to offer either — or it has some (due
// dates, milestones) that a deadline could follow.
export function emptyDeadlineReason(snapshot) {
  const sources = (snapshot && snapshot.dateSources) || { dueDates: 0, milestones: 0, deadlinesSet: 0 };
  if (sources.deadlinesSet > 0) {
    return { key: "projects.deadlinesWithoutDates", values: { count: sources.deadlinesSet } };
  }
  if (snapshot && snapshot.mode === "git") {
    return { key: "projects.noDatesGitOnly", values: {} };
  }
  if (sources.dueDates === 0 && sources.milestones === 0) {
    return { key: "projects.noDatesInClickup", values: {} };
  }
  return { key: "projects.datesInClickup", values: { dueDates: sources.dueDates, milestones: sources.milestones } };
}

// ---- the settings sheet -----------------------------------------------------------

// A day typed into a date field ("2026-10-15") → the time the store keeps
// (local noon, so no time zone moves it to another day), and back.
export function dateInputToTime(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0).getTime();
}

export function timeToDateInput(time) {
  if (!Number.isFinite(time)) {
    return "";
  }
  const day = new Date(time);
  const pad = (number) => String(number).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

// Up next, reordered: the task moves one place up (-1) or down (+1).
export function moveInList(list, itemId, step) {
  const items = [...(list || [])];
  const index = items.indexOf(itemId);
  const target = index + step;
  if (index === -1 || target < 0 || target >= items.length) {
    return items;
  }
  [items[index], items[target]] = [items[target], items[index]];
  return items;
}

// The first message of a session started for a task: the link comes first,
// so it is inside the short first prompt the session list keeps, and the
// task is linked to the session by the ordinary "mention" rule as well.
export function taskKickoffMessage(card) {
  if (card.source === "git") {
    const where = (card.branches || []).map((branch) => `${branch.repository}: ${branch.name}`).join(", ");
    return `Branch ${card.branchName || card.name}${where ? ` (${where})` : ""}${card.url ? `\n${card.url}` : ""}\n\nTask: ${card.name}`;
  }
  const link = card.url || `https://app.clickup.com/t/${card.id}`;
  return `${link}\n\n${card.kind === "spec" ? "Spec task" : "Task"}: ${card.name}`;
}

// Where a phase bar's name goes: inside the bar when it fits, otherwise
// outside it — after the bar, or before it when the bar ends near the right
// edge — so a name is never cut off without a word. `axisWidth` is in
// pixels; the text width is estimated from its length.
export const PHASE_LABEL_CHARACTER_PIXELS = 6.2;
export function phaseLabelPlacement(phase, axisWidth, text) {
  const barPixels = Math.max(0, (phase.at - phase.startAt) * (axisWidth || 0));
  const textPixels = String(text || "").length * PHASE_LABEL_CHARACTER_PIXELS + 14;
  if (!axisWidth || barPixels >= textPixels) {
    return "inside";
  }
  return phase.at <= 0.62 ? "right" : "left";
}

// The marker "Next" gets on the axis line when it is the end of a phase
// (the running one, or a pinned phase): { at, label, date, reason } or null.
// A single date that is "Next" is already a diamond of its own.
export function keyAxisMarker(timeline) {
  const next = timeline && timeline.next;
  if (!next || !next.isPhaseEnd) {
    return null;
  }
  return { id: next.id, at: next.at, label: next.label, date: next.date, reason: next.reason };
}
