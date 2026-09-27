// Projects view: one project, put together from everything the other
// modules read — ClickUp's two lists, the user's checkouts, GitHub, the
// Claude Code sessions — into the single object the window draws. Nothing
// here reads a file or the network; the caller passes it all in, so the
// dry tests can build a whole Groove from fixtures.
//
// The ClickUp model (Groove, from the Feature Builder's own notes):
//   build list    "Initial Build Web" — one task per piece of work
//   planning list the planning tasks, each with a Spec URL field pointing
//                 at the spec page
//   a build task "depends on" its planning task
// A planning task no build task depends on yet is a spec still on its way:
// it gets a card of its own (kind "spec").
import { BUCKETS, SPEC_STAGES, SPEC_STAGE_ORDER, bucketForStatus } from "./statusBuckets.js";
import { linkSessionsToTasks, SESSION_ROLES } from "./taskLinker.js";
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

function lastActivityOf(card) {
  const times = [card.updatedAt || 0, ...card.sessions.map((session) => session.lastModified || 0)];
  return Math.max(...times);
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
  clickup = { ok: true, error: null, refreshedAt: null },
  now = Date.now()
}) {
  const statusOverrides = board.statusOverrides || {};
  const userId = board.clickupUserId || null;
  const upNext = (board.upNext || []).map((taskId) => String(taskId));

  const topBuild = countableTasks(buildTasks).map((task) => ({
    ...task,
    bucket: bucketForStatus(task.status, task.statusType, statusOverrides)
  }));
  const topPlanning = countableTasks(planningTasks);
  const planningById = new Map(topPlanning.map((task) => [task.id, task]));
  const subtaskCounts = new Map();
  for (const task of buildTasks) {
    if (task.parentId) {
      subtaskCounts.set(task.parentId, (subtaskCounts.get(task.parentId) || 0) + 1);
    }
  }

  const sessionLinks = linkSessionsToTasks({
    sessions,
    taskIds: [...topBuild.map((task) => task.id), ...topPlanning.map((task) => task.id)],
    sessionAgents,
    agents,
    agentRoles: board.agentRoles || {},
    manualLinks: board.manualLinks || {},
    transcriptTextBySession
  });
  const branchesByTask = mergeByTask(repositoryResults, "branchesByTask");
  const pullsByTask = mergeByTask(pullRequestResults, "byTask");

  const usedPlanning = new Set();
  const cards = [];

  for (const task of topBuild) {
    const planningTask = task.dependsOn.map((dependencyId) => planningById.get(dependencyId)).find(Boolean) || null;
    if (planningTask) {
      usedPlanning.add(planningTask.id);
    }
    const ownSessions = sessionLinks.get(task.id) || [];
    const planningSessions = planningTask ? sessionLinks.get(planningTask.id) || [] : [];
    const specSessions = [
      ...planningSessions,
      ...ownSessions.filter((session) => session.role === SESSION_ROLES.spec)
    ];
    const builderSessions = ownSessions.filter((session) => session.role !== SESSION_ROLES.spec);
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
    const card = {
      id: task.id,
      kind: "build",
      name: task.name,
      url: task.url,
      status: task.status,
      statusColor: task.statusColor,
      bucket: task.bucket,
      assignees: task.assignees,
      assignedToUser,
      dueDate: task.dueDate,
      updatedAt: task.updatedAt,
      subtaskCount: subtaskCounts.get(task.id) || 0,
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
      name: planningTask.name,
      url: planningTask.url,
      status: planningTask.status,
      statusColor: planningTask.statusColor,
      bucket: null,
      assignees: planningTask.assignees,
      assignedToUser,
      dueDate: planningTask.dueDate,
      updatedAt: planningTask.updatedAt,
      subtaskCount: 0,
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
  const isOpenCard = (card) => (card.kind === "build" ? card.bucket !== BUCKETS.done : card.spec.index < card.spec.steps.length - 1);
  const inFocus = (card) =>
    isOpenCard(card) &&
    (card.upNext ||
      (card.assignedToUser && (card.bucket !== BUCKETS.open || card.sessions.length > 0)) ||
      card.needs !== null ||
      card.sessions.some((session) => (session.lastModified || 0) >= recentSince));
  const sortForFocus = (first, second) => {
    if (Boolean(first.needs) !== Boolean(second.needs)) {
      return first.needs ? -1 : 1;
    }
    return second.lastActivity - first.lastActivity;
  };
  const focus = cards.filter(inFocus).sort(sortForFocus);
  const notStarted = cards.filter(
    (card) => card.kind === "build" && card.bucket === BUCKETS.open && card.sessions.length === 0 && card.branches.length === 0 && !inFocus(card)
  );
  const upNextCards = upNext.map((taskId) => cards.find((card) => card.id === taskId)).filter(Boolean);

  // ---- spec pipeline: every planning task by its stage ----
  const specCards = cards.filter((card) => card.planning);
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
  const timeline = deadlineTimeline(board.deadlines || [], {
    now,
    projectStart: board.startDate || Math.min(...topBuild.map((task) => task.createdAt || now), now)
  });
  const buildForStats = topBuild;
  const stats = {
    buckets: bucketCounts(buildForStats),
    total: buildForStats.length,
    people: peopleBreakdown(buildForStats, userId),
    pace: pace(buildForStats, { now, lastDeadline: timeline.end }),
    specsToWrite: specPipeline
      .filter((stage) => [SPEC_STAGES.noSpec, SPEC_STAGES.session, SPEC_STAGES.draft].includes(stage.stage))
      .reduce((sum, stage) => sum + stage.count, 0),
    specsInReview: specPipeline.find((stage) => stage.stage === SPEC_STAGES.review).count,
    redPullRequests: Object.values(pullsByTask).flat().filter((pull) => pull.state === "open" && pull.ci === "failing").length
  };

  return {
    id: board.id,
    name: board.name,
    color: board.color || null,
    sources: {
      buildList: board.clickup && board.clickup.buildListName ? board.clickup.buildListName : null,
      planningList: board.clickup && board.clickup.planningListName ? board.clickup.planningListName : null,
      repositories: repositoryResults.map((result) => ({ name: result.repository, available: result.available, error: result.error })),
      pullRequests: pullRequestResults.map((result) => ({ available: result.available, reason: result.reason })),
      clickup
    },
    timeline,
    dailyPace: dailyPace(buildForStats, { now, deadline: timeline.next }),
    stats,
    cards,
    filters: {
      focus: focus.map((card) => card.id),
      upNext: upNextCards.map((card) => card.id),
      specs: specCards.filter((card) => card.spec.index < card.spec.steps.length - 1).map((card) => card.id),
      build: cards.filter((card) => card.kind === "build").map((card) => card.id),
      everything: cards.map((card) => card.id),
      hiddenNotStarted: notStarted.length
    },
    specPipeline,
    // For the project list on the left (variant B): status bar, next deadline, % closed.
    summary: {
      leftToClose: stats.pace.leftToClose,
      closedFraction: stats.pace.closedFraction,
      buckets: stats.buckets,
      nextDeadline: timeline.next ? { label: timeline.next.label, daysLeft: timeline.next.daysLeft } : null
    }
  };
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
