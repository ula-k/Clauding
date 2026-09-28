// Projects view: one project, put together from everything the other
// modules read — ClickUp's two lists, the user's checkouts, GitHub, the
// Claude Code sessions — into the single object the window draws. Nothing
// here reads a file or the network; the caller passes it all in, so the
// dry tests can build a whole project from fixtures.
//
// The ClickUp model the view expects:
//   build list    one task per piece of work
//   planning list the planning tasks, each with a spec-link custom field
//                 (board.specUrlFieldName, "Spec URL" by default) pointing
//                 at the spec page
//   a build task "depends on" its planning task
// A planning task no build task depends on yet is a spec still on its way:
// it gets a card of its own (kind "spec").
import { BUCKETS, SPEC_STAGES, SPEC_STAGE_ORDER, bucketForStatus } from "./statusBuckets.js";
import { linkSessionsToTasks, SESSION_ROLES } from "./taskLinker.js";
import { specUrlFrom } from "./clickupClient.js";
import {
  PERSPECTIVES,
  developerStatusFieldOf,
  fallbackPath,
  perspectiveForStatus,
  perspectivePath,
  taskPerspective
} from "./perspective.js";
import { buildStage, specStage, whatNeedsUser } from "./pipelineStage.js";
import {
  bucketCounts,
  countableTasks,
  dailyPace,
  deadlineTimeline,
  pace,
  peopleBreakdown
} from "./projectStats.js";

const RECENT_SESSION_DAYS = 7;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

function mergeByTask(results, key) {
  const merged = {};
  for (const result of results || []) {
    for (const [taskId, entries] of Object.entries((result && result[key]) || {})) {
      (merged[taskId] ||= []).push(...entries);
    }
  }
  return merged;
}

function isAssignedTo(task, userId) {
  if (userId === null || userId === undefined) {
    return false;
  }
  return (task.assignees || []).some((assignee) => String(assignee.id) === String(userId));
}

// The latest change on the card: the task, its sessions, and its subtasks
// and their sessions.
function lastActivityOf(card) {
  const times = [card.updatedAt || 0, ...card.sessions.map((session) => session.lastModified || 0)];
  for (const subtask of card.subtasks || []) {
    times.push(subtask.updatedAt || 0, ...subtask.sessions.map((session) => session.lastModified || 0));
  }
  return Math.max(...times);
}

// "12 subtasks · 7 in my queue · 3 waiting · 2 closed" on a card.
export function subtaskSummaryOf(subtasks) {
  const summary = { total: (subtasks || []).length, myQueue: 0, waiting: 0, closed: 0 };
  for (const subtask of subtasks || []) {
    if (subtask.perspective in summary) {
      summary[subtask.perspective] += 1;
    }
  }
  return summary;
}

function planningSummary(planningTask) {
  if (!planningTask) {
    return null;
  }
  return {
    id: planningTask.id,
    name: planningTask.name,
    url: planningTask.url,
    status: planningTask.status,
    statusColor: planningTask.statusColor,
    specUrl: planningTask.specUrl
  };
}

export function buildProjectSnapshot({
  board,
  buildTasks = [],
  planningTasks = [],
  sessions = [],
  sessionAgents = {},
  agents = [],
  repositoryResults = [],
  pullRequestResults = [],
  transcriptTextBySession = {},
  statusHistory = {},
  statusMoves = [],
  deadlineItems = [],
  deadlineInfo = { source: null, undated: 0 },
  truncated = null,
  clickup = { ok: true, error: null, refreshedAt: null },
  // "git" for a project without ClickUp: the build tasks are its feature
  // branches (lib/gitTasks.js), there is no spec pipeline, and a session on
  // a branch belongs to that branch's card (`branchTasks`).
  mode = "clickup",
  branchTasks = {},
  now = Date.now()
}) {
  const gitMode = mode === "git";
  const statusOverrides = board.statusOverrides || {};
  const userId = board.clickupUserId || null;
  const upNext = (board.upNext || []).map((taskId) => String(taskId));

  // The spec link is read from the custom field the project names
  // (board.specUrlFieldName); a task mapped without its fields keeps the
  // link it came with.
  const withSpecUrl = (task) =>
    Array.isArray(task.customFields) ? { ...task, specUrl: specUrlFrom(task.customFields, board.specUrlFieldName) } : task;
  // Where each build task stands from the user's side (lib/perspective.js),
  // and its path through her queue over time: ClickUp's time in status when
  // there is one, else the status changes this app saw.
  const perspectiveOverrides = board.perspectiveOverrides || {};
  const bucketOf = (statusName, statusType) => bucketForStatus(statusName, statusType, statusOverrides);
  const buildFields = [...new Map(buildTasks.flatMap((task) => task.customFields || []).map((field) => [field.name, { name: field.name, type: field.type }])).values()];
  const developerFieldName = developerStatusFieldOf(board, buildFields);
  const observed = (statusMoves || []).map((move) => ({
    taskId: move.taskId,
    at: move.at,
    from: perspectiveForStatus(move.fromStatus, move.fromType, bucketOf(move.fromStatus, move.fromType), perspectiveOverrides),
    to: perspectiveForStatus(move.toStatus, move.toType, bucketOf(move.toStatus, move.toType), perspectiveOverrides)
  }));
  // Every task and every subtask is a unit of work (board.countSubtasks,
  // on unless the project turned it off): the numbers, the queue, the pace
  // and who has what count them all. The cards stay one per top-level
  // task, each listing its subtasks. Tasks ClickUp closed are read too
  // unless the project turned that off (board.includeClosed); a cache read
  // before the switch was flipped is filtered here the same way.
  const countSubtasks = board.countSubtasks !== false;
  const includeClosed = board.includeClosed !== false;
  const keepTask = (task) => includeClosed || task.statusType !== "closed";
  const placeTask = (task) => {
    const bucket = bucketOf(task.status, task.statusType);
    const placed = taskPerspective(
      { ...task, bucket },
      { overrides: perspectiveOverrides, developerFieldName, developerStatusMap: board.developerStatusMap || {} }
    );
    const history = statusHistory ? statusHistory[task.id] : null;
    let path = history && history.length > 0 ? perspectivePath(history, { bucketOf, overrides: perspectiveOverrides }) : fallbackPath(task, placed.perspective, observed);
    // The developer field can place a task elsewhere than its status: the
    // path ends where the task is now.
    if (path.length > 0 && path[path.length - 1].perspective !== placed.perspective) {
      path = [...path, { at: Math.max(task.updatedAt || now, path[path.length - 1].at), perspective: placed.perspective }];
    }
    return {
      ...withSpecUrl(task),
      bucket,
      perspective: placed.perspective,
      developerStatus: placed.developerStatus,
      path
    };
  };
  const placedBuild = buildTasks.filter(keepTask).map(placeTask);
  const placedIds = new Set(placedBuild.map((task) => task.id));
  // A subtask whose parent was not read (it lives in another list, or it
  // was left out as closed) is a card of its own rather than lost.
  const isTopLevel = (task) => !task.parentId || !placedIds.has(task.parentId);
  const topBuild = placedBuild.filter(isTopLevel);
  const nameById = new Map(placedBuild.map((task) => [task.id, task.name]));
  const childrenOf = new Map();
  for (const task of placedBuild) {
    if (!isTopLevel(task)) {
      if (!childrenOf.has(task.parentId)) {
        childrenOf.set(task.parentId, []);
      }
      childrenOf.get(task.parentId).push(task);
    }
  }
  // All of a task's subtasks, every level, depth first (a subtask right
  // above its own subtasks), each with how deep it sits.
  const descendantsOf = (taskId, depth = 1, seen = new Set([taskId])) =>
    (childrenOf.get(taskId) || []).flatMap((child) => {
      if (seen.has(child.id)) {
        return [];
      }
      seen.add(child.id);
      return [{ task: child, depth }, ...descendantsOf(child.id, depth + 1, seen)];
    });
  const units = countSubtasks ? placedBuild : topBuild;
  const topPlanning = countableTasks(planningTasks.filter(keepTask)).map(withSpecUrl);
  const planningById = new Map(topPlanning.map((task) => [task.id, task]));

  const sessionLinks = linkSessionsToTasks({
    sessions,
    taskIds: [...placedBuild.map((task) => task.id), ...topPlanning.map((task) => task.id)],
    sessionAgents,
    agents,
    agentRoles: board.agentRoles || {},
    manualLinks: board.manualLinks || {},
    transcriptTextBySession,
    branchTasks
  });
  const branchesByTask = mergeByTask(repositoryResults, "branchesByTask");
  const pullsByTask = mergeByTask(pullRequestResults, "byTask");

  // One subtask as its card lists it: its status, where it stands for the
  // user, its own branches, pull requests and sessions.
  const subtaskEntry = (subtask, depth) => {
    const sessionsOfSubtask = sessionLinks.get(subtask.id) || [];
    const branches = branchesByTask[subtask.id] || [];
    const pullRequests = pullsByTask[subtask.id] || [];
    const assignedToUser = isAssignedTo(subtask, userId);
    let needs = whatNeedsUser({ bucket: subtask.bucket, spec: null, sessions: sessionsOfSubtask, branches, pullRequests, assignedToUser });
    if (needs && needs.kind === "qa" && subtask.perspective !== PERSPECTIVES.myQueue) {
      needs = null;
    }
    return {
      id: subtask.id,
      customId: subtask.customId || null,
      name: subtask.name,
      url: subtask.url,
      status: subtask.status,
      statusColor: subtask.statusColor,
      bucket: subtask.bucket,
      perspective: subtask.perspective,
      developerStatus: subtask.developerStatus,
      assignees: subtask.assignees || [],
      assignedToUser,
      depth,
      parentId: subtask.parentId,
      parentTitle: nameById.get(subtask.parentId) || null,
      dueDate: subtask.dueDate,
      updatedAt: subtask.updatedAt,
      sessions: sessionsOfSubtask,
      branches,
      pullRequests,
      needs
    };
  };

  const usedPlanning = new Set();
  const cards = [];

  for (const task of topBuild) {
    const planningTask = task.dependsOn.map((dependencyId) => planningById.get(dependencyId)).find(Boolean) || null;
    if (planningTask) {
      usedPlanning.add(planningTask.id);
    }
    const ownSessions = sessionLinks.get(task.id) || [];
    const planningSessions = planningTask ? sessionLinks.get(planningTask.id) || [] : [];
    // Without ClickUp there are no specs to write: every session on a
    // branch is work on it.
    const specSessions = gitMode
      ? []
      : [...planningSessions, ...ownSessions.filter((session) => session.role === SESSION_ROLES.spec)];
    const builderSessions = gitMode ? ownSessions : ownSessions.filter((session) => session.role !== SESSION_ROLES.spec);
    const branches = branchesByTask[task.id] || [];
    const pullRequests = pullsByTask[task.id] || [];
    const spec = specStage({ planningTask, specSessions, statusOverrides: board.specStatusOverrides || {} });
    const build = buildStage({
      bucket: task.bucket,
      builderSessions,
      branches,
      pullRequests,
      specApproved: spec.index === spec.steps.length - 1
    });
    const allSessions = dedupeSessions([...specSessions, ...builderSessions]);
    const assignedToUser = isAssignedTo(task, userId);
    const subtasks = descendantsOf(task.id).map(({ task: subtask, depth }) => subtaskEntry(subtask, depth));
    const card = {
      id: task.id,
      kind: "build",
      source: gitMode ? "git" : "clickup",
      branchName: task.branchName || null,
      customId: task.customId || null,
      description: excerptOf(task.description),
      fields: fieldsOf(task.customFields),
      name: task.name,
      url: task.url,
      status: task.status,
      statusColor: task.statusColor,
      bucket: task.bucket,
      perspective: task.perspective,
      developerStatus: task.developerStatus,
      developerStatusField: task.developerStatus ? developerFieldName : null,
      assignees: task.assignees,
      assignedToUser,
      dueDate: task.dueDate,
      updatedAt: task.updatedAt,
      subtaskCount: subtasks.length,
      subtasks,
      subtaskSummary: subtaskSummaryOf(subtasks),
      planning: planningSummary(planningTask),
      specUrl: planningTask ? planningTask.specUrl : task.specUrl,
      spec,
      build,
      sessions: allSessions,
      specSessions,
      builderSessions,
      branches,
      pullRequests,
      upNext: upNext.includes(task.id)
    };
    card.needs = whatNeedsUser({ bucket: task.bucket, spec, sessions: allSessions, branches, pullRequests, assignedToUser });
    // Waiting on others means nothing is on the user now: no "QA on
    // staging" for her.
    if (card.needs && card.needs.kind === "qa" && task.perspective !== PERSPECTIVES.myQueue) {
      card.needs = null;
    }
    // Nothing on the task itself: what one of its subtasks waits on, when
    // subtasks count.
    if (!card.needs && countSubtasks) {
      const waitingSubtask = subtasks.find((subtask) => subtask.needs);
      if (waitingSubtask) {
        card.needs = { ...waitingSubtask.needs, subtaskId: waitingSubtask.id, subtaskName: waitingSubtask.name };
      }
    }
    card.lastActivity = lastActivityOf(card);
    cards.push(card);
  }

  // Specs still on their way: planning tasks no build task points at yet.
  for (const planningTask of topPlanning) {
    if (usedPlanning.has(planningTask.id)) {
      continue;
    }
    const specSessions = sessionLinks.get(planningTask.id) || [];
    const spec = specStage({ planningTask, specSessions, statusOverrides: board.specStatusOverrides || {} });
    const assignedToUser = isAssignedTo(planningTask, userId);
    const card = {
      id: planningTask.id,
      kind: "spec",
      customId: planningTask.customId || null,
      description: excerptOf(planningTask.description),
      fields: fieldsOf(planningTask.customFields),
      name: planningTask.name,
      url: planningTask.url,
      status: planningTask.status,
      statusColor: planningTask.statusColor,
      bucket: null,
      perspective: null,
      developerStatus: null,
      developerStatusField: null,
      assignees: planningTask.assignees,
      assignedToUser,
      dueDate: planningTask.dueDate,
      updatedAt: planningTask.updatedAt,
      subtaskCount: 0,
      subtasks: [],
      subtaskSummary: subtaskSummaryOf([]),
      planning: planningSummary(planningTask),
      specUrl: planningTask.specUrl,
      spec,
      build: { steps: [], index: -1, state: "now" },
      sessions: specSessions,
      specSessions,
      builderSessions: [],
      branches: [],
      pullRequests: [],
      upNext: upNext.includes(planningTask.id)
    };
    card.needs = whatNeedsUser({ bucket: null, spec, sessions: specSessions, assignedToUser });
    card.lastActivity = lastActivityOf(card);
    cards.push(card);
  }

  // ---- filters ----
  const recentSince = now - RECENT_SESSION_DAYS * DAY_MILLISECONDS;
  // With subtasks counted, a card is open while any of its subtasks is,
  // and in the user's queue when any of them is.
  const countedSubtasks = (card) => (countSubtasks ? card.subtasks || [] : []);
  const isOpenCard = (card) =>
    card.kind === "build"
      ? card.perspective !== PERSPECTIVES.closed || countedSubtasks(card).some((subtask) => subtask.perspective !== PERSPECTIVES.closed)
      : card.spec.index < card.spec.steps.length - 1;
  const hasQueueWork = (card) =>
    card.kind === "build" &&
    (card.perspective === PERSPECTIVES.myQueue || countedSubtasks(card).some((subtask) => subtask.perspective === PERSPECTIVES.myQueue));
  const everySession = (card) => [...card.sessions, ...countedSubtasks(card).flatMap((subtask) => subtask.sessions)];
  // My focus is the user's queue — build tasks on her plate — needing her
  // first; plus, by the project's rules (board.focusRules), anything else
  // waiting on her (a spec to approve, a session with a question), what is
  // pinned to Up next and what a session worked on this week.
  const rules = { myQueue: true, needsMe: true, recentSession: true, upNext: true, everythingOpen: false, ...(board.focusRules || {}) };
  const inFocus = (card) =>
    isOpenCard(card) &&
    (rules.everythingOpen ||
      (rules.myQueue && hasQueueWork(card)) ||
      (rules.upNext && card.upNext) ||
      (rules.needsMe && card.needs !== null) ||
      (rules.recentSession && everySession(card).some((session) => (session.lastModified || 0) >= recentSince)));
  const sortForFocus = (first, second) => {
    if (Boolean(first.needs) !== Boolean(second.needs)) {
      return first.needs ? -1 : 1;
    }
    return second.lastActivity - first.lastActivity;
  };
  const focus = cards.filter(inFocus).sort(sortForFocus);
  // Untouched: open, no session, no branch — and none of its subtasks
  // moved or worked on either (a task still "open" whose subtasks are
  // closed has clearly been worked on).
  const untouched = (entry) => entry.bucket === BUCKETS.open && entry.sessions.length === 0 && entry.branches.length === 0;
  const notStarted = cards.filter(
    (card) => card.kind === "build" && untouched(card) && (card.subtasks || []).every(untouched) && !card.upNext && !card.needs
  );
  const upNextCards = upNext.map((taskId) => cards.find((card) => card.id === taskId)).filter(Boolean);

  // ---- spec pipeline: every planning task by its stage ----
  const specCards = gitMode ? [] : cards.filter((card) => card.planning);
  const specPipeline = SPEC_STAGE_ORDER.map((stage) => {
    const items = specCards
      .filter((card) => card.spec.known !== false && card.spec.steps[card.spec.index] === stage)
      .map((card) => ({
        id: card.planning.id,
        cardId: card.id,
        name: card.planning.name,
        url: card.planning.url,
        specUrl: card.planning.specUrl,
        status: card.planning.status,
        sessions: card.specSessions,
        buildStatus: card.kind === "build" ? card.status : null,
        needs: card.needs && card.needs.kind === "spec-review" ? card.needs : null
      }));
    return { stage, count: items.length, items };
  });

  // ---- numbers on top ----
  // A deadline that follows a ClickUp task takes that task's due date now
  // (it moves when the task moves); one whose task has no date is left off
  // the axis until it gets one.
  const everyTask = [...buildTasks, ...planningTasks];
  const taskById = new Map(everyTask.map((task) => [task.id, task]));
  const deadlines = (board.deadlines || [])
    .map((deadline) => {
      if (deadline.source !== "task") {
        return deadline;
      }
      const task = taskById.get(deadline.taskId);
      return { ...deadline, date: task && task.dueDate ? task.dueDate : deadline.date, taskMissing: !task };
    })
    .filter((deadline) => Number.isFinite(deadline.date));
  // Phases and dates read from ClickUp (the project's deadline source), and
  // the ones typed in the app unless the project says to leave them out.
  const source = board.deadlineSource || { mode: "auto", includeManual: true };
  const typed = source.mode === "manual" || source.includeManual !== false ? deadlines : [];
  const fromClickup = source.mode === "manual" ? [] : deadlineItems || [];
  const timeline = deadlineTimeline([...typed, ...fromClickup], {
    now,
    hiddenIds: board.deadlineHidden || [],
    keyDeadlineId: board.keyDeadlineId || null,
    projectStart: board.startDate || Math.min(...topBuild.map((task) => task.createdAt || now), now)
  });
  const buildForStats = units;
  const stats = {
    buckets: bucketCounts(buildForStats),
    total: buildForStats.length,
    // How the total splits: the cards' own tasks and their subtasks.
    topLevel: topBuild.length,
    subtasks: buildForStats.length - topBuild.length,
    subtasksRead: placedBuild.length - topBuild.length,
    people: peopleBreakdown(buildForStats, userId),
    // The same deadline as the line under the axis: the next one.
    pace: pace(buildForStats, { now, deadline: timeline.next ? timeline.next.date : null }),
    specsToWrite: specPipeline
      .filter((stage) => [SPEC_STAGES.noSpec, SPEC_STAGES.session, SPEC_STAGES.draft].includes(stage.stage))
      .reduce((sum, stage) => sum + stage.count, 0),
    specsInReview: specPipeline.find((stage) => stage.stage === SPEC_STAGES.review).count,
    // From the user's side: on her plate, waiting on others, closed.
    inQueue: buildForStats.filter((task) => task.perspective === PERSPECTIVES.myQueue).length,
    waiting: buildForStats.filter((task) => task.perspective === PERSPECTIVES.waiting).length,
    closed: buildForStats.filter((task) => task.perspective === PERSPECTIVES.closed).length,
    closedInClickup: buildForStats.filter((task) => task.bucket === BUCKETS.done).length,
    redPullRequests: Object.values(pullsByTask).flat().filter((pull) => pull.state === "open" && pull.ci === "failing").length
  };

  return {
    id: board.id,
    name: board.name,
    color: board.color || null,
    mode: gitMode ? "git" : "clickup",
    // What the numbers count (Settings → General).
    counting: { subtasks: countSubtasks, closed: includeClosed },
    sources: {
      buildList: board.clickup && board.clickup.buildListName ? board.clickup.buildListName : null,
      planningList: board.clickup && board.clickup.planningListName ? board.clickup.planningListName : null,
      repositories: (board.repositories && board.repositories.length > 0
        ? board.repositories.map((repository, index) => ({ name: repository.name, localPath: repository.localPath || null, result: repositoryResults[index] || null }))
        : repositoryResults.map((result) => ({ name: result.repository, localPath: null, result }))
      ).map(({ name, localPath, result }) => ({
        name,
        localPath,
        available: result ? result.available !== false : null,
        error: result ? result.error || null : null
      })),
      // Lists longer than the pages read: counts are "at least".
      truncated: { buildTasks: Boolean(truncated && truncated.buildTasks), planningTasks: Boolean(truncated && truncated.planningTasks) },
      pullRequests: pullRequestResults.map((result) => ({ available: result.available, reason: result.reason || null })),
      clickup
    },
    timeline,
    // Where dates could come from, for an honest empty axis: how many of the
    // project's tasks carry a due date, and how many are milestones.
    dateSources: {
      dueDates: [...topBuild, ...topPlanning].filter((task) => task.dueDate).length,
      milestones: [...topBuild, ...topPlanning].filter((task) => task.isMilestone).length,
      deadlinesSet: (board.deadlines || []).length,
      fromSource: (deadlineItems || []).length,
      undatedInSource: deadlineInfo && deadlineInfo.undated ? deadlineInfo.undated : 0,
      source: deadlineInfo ? deadlineInfo.source : null
    },
    dailyPace: dailyPace(buildForStats, { now, deadline: timeline.next }),
    stats,
    cards,
    filters: {
      focus: focus.map((card) => card.id),
      upNext: upNextCards.map((card) => card.id),
      // Every spec in the pipeline, all five stages: the chip's count is
      // the pipeline's total, the same the stage counters add up to.
      specs: specCards.map((card) => card.id),
      build: cards.filter((card) => card.kind === "build").map((card) => card.id),
      everything: cards.map((card) => card.id),
      hiddenNotStarted: notStarted.length
    },
    specPipeline,
    // For the project list on the left (variant B): status bar, next deadline, % closed.
    developerStatusField: developerFieldName,
    summary: {
      leftToClose: stats.pace.leftToClose,
      inQueue: stats.inQueue,
      waiting: stats.waiting,
      closed: stats.closed,
      closedFraction: stats.pace.closedFraction,
      buckets: stats.buckets,
      nextDeadline: timeline.next ? { label: timeline.next.label, daysLeft: timeline.next.daysLeft } : null
    }
  };
}

const DESCRIPTION_EXCERPT_LENGTH = 600;

// The first part of a task's description, for the expanded card; the whole
// text is read on demand (the panel's task view).
function excerptOf(description) {
  const text = String(description || "").trim();
  if (text.length <= DESCRIPTION_EXCERPT_LENGTH) {
    return text;
  }
  return `${text.slice(0, DESCRIPTION_EXCERPT_LENGTH).replace(/\s+\S*$/, "")}…`;
}

// Custom fields as name + readable text; values that are not plain text or
// numbers (people, attachments, drop-down ids) are left to ClickUp itself.
function fieldsOf(customFields) {
  const fields = [];
  for (const field of customFields || []) {
    const value = field.value;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) {
        fields.push({ name: field.name, value: text.slice(0, 300) });
      }
    }
  }
  return fields.slice(0, 12);
}

function dedupeSessions(list) {
  const seen = new Set();
  return list.filter((session) => {
    if (seen.has(session.sessionId)) {
      return false;
    }
    seen.add(session.sessionId);
    return true;
  });
}
