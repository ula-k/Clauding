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

// Who has what, among tasks that are not closed. The user first, then the
// others by how much they hold, then "Nobody".
export function peopleBreakdown(tasks, userId) {
  const people = new Map();
  const nobody = { id: null, name: "Nobody", initials: "–", color: null, isUser: false, isNobody: true, byBucket: {}, total: 0 };
  for (const task of tasks) {
    if (task.bucket === BUCKETS.done) {
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
export function deadlineTimeline(deadlines, { now, projectStart = null }) {
  const sorted = (deadlines || [])
    .filter((deadline) => deadline && Number.isFinite(deadline.date))
    .sort((first, second) => first.date - second.date);
  if (sorted.length === 0) {
    return { deadlines: [], start: null, end: null, elapsedFraction: null, next: null };
  }
  const start = Math.min(projectStart || sorted[0].date, sorted[0].date);
  const end = sorted[sorted.length - 1].date;
  const span = Math.max(end - start, DAY_MILLISECONDS);
  const placed = sorted.map((deadline) => ({
    ...deadline,
    at: Math.min(1, Math.max(0, (deadline.date - start) / span)),
    passed: deadline.date < startOfDay(now),
    daysLeft: calendarDaysBetween(now, deadline.date)
  }));
  const next = placed.find((deadline) => !deadline.passed) || null;
  return {
    deadlines: placed,
    start,
    end,
    elapsedFraction: Math.min(1, Math.max(0, (now - start) / span)),
    daysLeft: calendarDaysBetween(now, end),
    next
  };
}

// "Left to close", how fast tasks closed over the last two weeks, and how
// fast they must close to make the last deadline.
export function pace(tasks, { now, lastDeadline = null }) {
  const open = tasks.filter((task) => task.bucket !== BUCKETS.done);
  const windowStart = now - PACE_WINDOW_DAYS * DAY_MILLISECONDS;
  const closedRecently = tasks.filter((task) => {
    const closedAt = closedAtOf(task);
    return task.bucket === BUCKETS.done && closedAt && closedAt >= windowStart && closedAt <= now;
  }).length;
  const actualPerWeek = closedRecently / (PACE_WINDOW_DAYS / 7);
  let neededPerWeek = null;
  if (lastDeadline && lastDeadline > now) {
    neededPerWeek = open.length / Math.max((lastDeadline - now) / WEEK_MILLISECONDS, 1 / 7);
  }
  return {
    leftToClose: open.length,
    total: tasks.length,
    closedFraction: tasks.length === 0 ? 0 : (tasks.length - open.length) / tasks.length,
    actualPerWeek: Math.round(actualPerWeek * 10) / 10,
    neededPerWeek: neededPerWeek === null ? null : Math.round(neededPerWeek * 10) / 10,
    history: burnDownHistory(tasks, { now, lastDeadline })
  };
}

// Open tasks at the end of each of the past weeks, oldest first, rebuilt
// from creation and close dates — enough for the small burn-down line.
export function burnDownHistory(tasks, { now, weeks = 8 }) {
  const points = [];
  for (let week = weeks; week >= 0; week -= 1) {
    const at = now - week * WEEK_MILLISECONDS;
    const openThen = tasks.filter((task) => {
      const created = task.createdAt || 0;
      const closedAt = closedAtOf(task);
      return created <= at && (!closedAt || closedAt > at);
    }).length;
    points.push({ at, open: openThen });
  }
  return points;
}

// "To make Feature freeze: 17 tasks in 13 work days → about 1–2 a day",
// and how many closed today. Tasks due on or before the deadline count
// towards it; when no task carries a due date, everything still open does.
export function dailyPace(tasks, { now, deadline }) {
  if (!deadline) {
    return null;
  }
  const open = tasks.filter((task) => task.bucket !== BUCKETS.done);
  const dated = open.filter((task) => task.dueDate);
  const towards = dated.length > 0 ? dated.filter((task) => task.dueDate <= deadline.date) : open;
  const workDays = Math.max(workDaysBetween(now, deadline.date), 1);
  const perDay = towards.length / workDays;
  const todayStart = startOfDay(now);
  const closedToday = tasks.filter((task) => {
    const closedAt = closedAtOf(task);
    return task.bucket === BUCKETS.done && closedAt && closedAt >= todayStart;
  }).length;
  return {
    deadlineLabel: deadline.label,
    tasks: towards.length,
    workDays,
    perDay: Math.round(perDay * 10) / 10,
    perDayLow: Math.floor(perDay),
    perDayHigh: Math.ceil(perDay),
    todayTarget: Math.ceil(perDay),
    closedToday
  };
}
