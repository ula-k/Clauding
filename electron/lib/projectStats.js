// Projects view: the numbers on top of a project — where the tasks are, who
// has what, how fast things close, and the deadlines timeline with its
// "about N a day" line. Pure: every function takes "now" from its caller.
import { BUCKETS, BUCKET_ORDER } from "./statusBuckets.js";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const WEEK_MILLISECONDS = 7 * DAY_MILLISECONDS;
const PACE_WINDOW_DAYS = 14;

// Only top-level tasks count: a subtask belongs to its parent's card.
export function countableTasks(tasks) {
  return (tasks || []).filter((task) => !task.parentId);
}

export function bucketCounts(tasks) {
  const counts = Object.fromEntries([...BUCKET_ORDER, BUCKETS.other].map((bucket) => [bucket, 0]));
  for (const task of tasks) {
    counts[task.bucket] = (counts[task.bucket] || 0) + 1;
  }
  return counts;
}

// Who has what, among tasks that are not closed (from the user's side). The user first, then the
// others by how much they hold, then "Nobody".
export function peopleBreakdown(tasks, userId) {
  const people = new Map();
  const nobody = { id: null, name: "Nobody", initials: "–", color: null, isUser: false, isNobody: true, byBucket: {}, total: 0 };
  for (const task of tasks) {
    if (isClosedTask(task)) {
      continue;
    }
    const holders = task.assignees && task.assignees.length > 0 ? task.assignees : [null];
    for (const assignee of holders) {
      let person = nobody;
      if (assignee) {
        if (!people.has(assignee.id)) {
          people.set(assignee.id, {
            ...assignee,
            isUser: userId !== null && userId !== undefined && String(assignee.id) === String(userId),
            isNobody: false,
            byBucket: {},
            total: 0
          });
        }
        person = people.get(assignee.id);
      }
      person.byBucket[task.bucket] = (person.byBucket[task.bucket] || 0) + 1;
      person.total += 1;
    }
  }
  const list = [...people.values()].sort((first, second) => {
    if (first.isUser !== second.isUser) {
      return first.isUser ? -1 : 1;
    }
    return second.total - first.total;
  });
  if (nobody.total > 0) {
    list.push(nobody);
  }
  return list;
}

function closedAtOf(task) {
  return task.closedAt || task.doneAt || null;
}

// Saturdays and Sundays do not count.
export function workDaysBetween(fromTime, toTime) {
  if (toTime <= fromTime) {
    return 0;
  }
  let count = 0;
  const cursor = new Date(fromTime);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() <= toTime) {
    const weekday = cursor.getDay();
    if (weekday !== 0 && weekday !== 6) {
      count += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

export function startOfDay(time) {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

// Whole days from one day to another, counted midnight to midnight
// (rounded, so a daylight-saving hour never adds or loses a day).
export function calendarDaysBetween(fromTime, toTime) {
  return Math.round((startOfDay(toTime) - startOfDay(fromTime)) / DAY_MILLISECONDS);
}

// Deadlines sorted, with the elapsed fraction of the whole span for the
// "Today" line. The span starts at the earliest of: the first deadline, the
// project's own start date, the first task created.
//
// `hiddenIds` (board.deadlineHidden) are left off the axis — they are still
// listed in `items`, so the settings can show them again — and
// `keyDeadlineId` (board.keyDeadlineId) is the one the user pinned: it is
// "Next" whatever else is nearer (see chooseNextTarget).
export function deadlineTimeline(deadlines, { now, projectStart = null, hiddenIds = [], keyDeadlineId = null }) {
  const hidden = new Set((hiddenIds || []).map(String));
  const dated = (deadlines || []).filter((deadline) => deadline && Number.isFinite(deadline.date));
  const items = dated
    .map((deadline) => ({
      id: deadline.id,
      label: deadline.label,
      start: Number.isFinite(deadline.start) ? deadline.start : null,
      date: deadline.date,
      source: deadline.source || "manual",
      hidden: hidden.has(String(deadline.id)),
      key: Boolean(keyDeadlineId) && String(deadline.id) === String(keyDeadlineId)
    }))
    .sort((first, second) => (first.start || first.date) - (second.start || second.date));
  const sorted = dated.filter((deadline) => !hidden.has(String(deadline.id))).sort((first, second) => first.date - second.date);
  const hiddenCount = dated.length - sorted.length;
  if (sorted.length === 0) {
    return { deadlines: [], start: null, end: null, elapsedFraction: null, next: null, items, hiddenCount };
  }
  // A phase (deadline.start set) is drawn from its start to its end; the
  // axis starts at the earliest of everything.
  const earliestStart = Math.min(...sorted.map((deadline) => (Number.isFinite(deadline.start) ? deadline.start : deadline.date)));
  const start = Math.min(projectStart || earliestStart, earliestStart);
  const end = Math.max(...sorted.map((deadline) => deadline.date));
  const span = Math.max(end - start, DAY_MILLISECONDS);
  const place = (time) => Math.min(1, Math.max(0, (time - start) / span));
  const placed = sorted.map((deadline) => ({
    ...deadline,
    at: place(deadline.date),
    startAt: Number.isFinite(deadline.start) ? place(deadline.start) : null,
    running: Number.isFinite(deadline.start) && deadline.start <= now && deadline.date >= startOfDay(now),
    passed: deadline.date < startOfDay(now),
    daysLeft: calendarDaysBetween(now, deadline.date)
  }));
  return {
    deadlines: placed,
    start,
    end,
    elapsedFraction: Math.min(1, Math.max(0, (now - start) / span)),
    daysLeft: calendarDaysBetween(now, end),
    next: chooseNextTarget(placed, { now, keyDeadlineId }),
    items,
    hiddenCount
  };
}

// What "Next" counts to, in this order:
//   1. the deadline the user pinned as the key one (while it is ahead),
//   2. the end of the phase Today is in — the date that matters while a
//      phase runs; with two running, the one that ends first,
//   3. the nearest date still ahead.
// `reason` says which, so the axis can mark a phase's end as its own thing.
export function chooseNextTarget(placed, { now, keyDeadlineId = null } = {}) {
  const ahead = (placed || []).filter((deadline) => !deadline.passed);
  const pinned = keyDeadlineId ? ahead.find((deadline) => String(deadline.id) === String(keyDeadlineId)) : null;
  if (pinned) {
    return { ...pinned, reason: "pinned", isPhaseEnd: Number.isFinite(pinned.start) };
  }
  const running = ahead
    .filter((deadline) => Number.isFinite(deadline.start) && deadline.start <= now)
    .sort((first, second) => first.date - second.date);
  if (running.length > 0) {
    return { ...running[0], reason: "phaseEnd", isPhaseEnd: true };
  }
  const nearest = [...ahead].sort((first, second) => first.date - second.date)[0] || null;
  return nearest ? { ...nearest, reason: "nearest", isPhaseEnd: Number.isFinite(nearest.start) } : null;
}

// A task with a place from the user's side (lib/perspective.js) is in her
// queue when that place is "myQueue"; one without (older callers, tests)
// is in it until ClickUp closes it.
function inQueue(task) {
  return task.perspective ? task.perspective === "myQueue" : task.bucket !== BUCKETS.done;
}

function isClosedTask(task) {
  return task.perspective ? task.perspective === "closed" : task.bucket === BUCKETS.done;
}

// The task's path through the three places; without one, it entered the
// queue when created and left it when ClickUp closed it.
function pathOf(task) {
  if (Array.isArray(task.path) && task.path.length > 0) {
    return task.path;
  }
  const path = [{ at: task.createdAt || 0, perspective: "myQueue" }];
  const closedAt = closedAtOf(task);
  if (!inQueue(task)) {
    path.push({ at: closedAt || task.updatedAt || task.createdAt || 0, perspective: task.perspective || "closed" });
  }
  return path;
}

function queueAt(path, time) {
  let current = null;
  for (const step of path) {
    if (step.at <= time) {
      current = step.perspective;
    }
  }
  return current === "myQueue";
}

// Every moment a task left the queue (handed off: to waiting or closed).
function handOffs(task) {
  const path = pathOf(task);
  const moments = [];
  for (let position = 1; position < path.length; position += 1) {
    if (path[position - 1].perspective === "myQueue" && path[position].perspective !== "myQueue") {
      moments.push(path[position].at);
    }
  }
  return moments;
}

// What is in the user's queue, what waits on others, what is closed; how
// many tasks she handed off over the last two weeks (a task that came back
// and left again counts twice — it was handed off twice), and how fast the
// queue must shrink to make the last deadline.
// `deadline` is the next deadline (the one the line under the axis uses);
// `lastDeadline` is its older name.
export function pace(tasks, { now, deadline = null, lastDeadline = null }) {
  const target = deadline || lastDeadline;
  const queue = tasks.filter(inQueue);
  const closed = tasks.filter(isClosedTask);
  const windowStart = now - PACE_WINDOW_DAYS * DAY_MILLISECONDS;
  const handedOffRecently = tasks.flatMap(handOffs).filter((at) => at >= windowStart && at <= now).length;
  const actualPerWeek = handedOffRecently / (PACE_WINDOW_DAYS / 7);
  let neededPerWeek = null;
  if (target && target > now) {
    neededPerWeek = queue.length / Math.max((target - now) / WEEK_MILLISECONDS, 1 / 7);
  }
  return {
    leftToClose: queue.length,
    inQueue: queue.length,
    waiting: tasks.length - queue.length - closed.length,
    closed: closed.length,
    total: tasks.length,
    closedFraction: tasks.length === 0 ? 0 : closed.length / tasks.length,
    actualPerWeek: Math.round(actualPerWeek * 10) / 10,
    neededPerWeek: neededPerWeek === null ? null : Math.round(neededPerWeek * 10) / 10,
    history: burnDownHistory(tasks, { now })
  };
}

// The size of the user's queue at the end of each of the past weeks,
// oldest first — the "My queue" line. Waiting-on-others is not on it.
export function burnDownHistory(tasks, { now, weeks = 8 }) {
  const paths = tasks.map(pathOf);
  const points = [];
  for (let week = weeks; week >= 0; week -= 1) {
    const at = now - week * WEEK_MILLISECONDS;
    points.push({ at, open: paths.filter((path) => queueAt(path, at)).length });
  }
  return points;
}

// "To make Feature freeze: 17 tasks in 13 work days → about 1–2 a day":
// the queue divided by the work days to the next deadline, and how many
// tasks were handed off today.
export function dailyPace(tasks, { now, deadline }) {
  if (!deadline) {
    return null;
  }
  const queue = tasks.filter(inQueue);
  const workDays = Math.max(workDaysBetween(now, deadline.date), 1);
  const perDay = queue.length / workDays;
  const todayStart = startOfDay(now);
  const handedOffToday = tasks.flatMap(handOffs).filter((at) => at >= todayStart && at <= now).length;
  return {
    deadlineLabel: deadline.label,
    tasks: queue.length,
    workDays,
    perDay: Math.round(perDay * 10) / 10,
    perDayLow: Math.floor(perDay),
    perDayHigh: Math.ceil(perDay),
    todayTarget: Math.ceil(perDay),
    // Under one a day, the same rate said per work week (five work days).
    perWeek: Math.round(perDay * 5 * 10) / 10,
    handedOffToday,
    closedToday: handedOffToday
  };
}
