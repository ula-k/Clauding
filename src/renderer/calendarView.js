// The project calendar's own logic (components/ProjectCalendar.jsx), kept
// out of the component so it can be tested without a window: which days a
// month or a week shows, what each day lists, and the short time on an
// entry. Days are "YYYY-MM-DD" (see electron/lib/calendarRecurrence.js).
import { addDays, expandEntries, localDay, weekStart } from "../../electron/lib/calendarRecurrence.js";

// A month cell lists this many items; the rest is "+N more".
export const ITEMS_PER_MONTH_DAY = 3;

export function firstOfMonth(day) {
  return `${day.slice(0, 7)}-01`;
}

// Mondays first, whole weeks: the month's own days plus the ones around it
// (inMonth: false, drawn faded).
export function monthDays(anchorDay) {
  const first = firstOfMonth(anchorDay);
  const month = first.slice(0, 7);
  const days = [];
  let day = weekStart(first);
  do {
    for (let column = 0; column < 7; column += 1) {
      days.push({ day, inMonth: day.slice(0, 7) === month });
      day = addDays(day, 1);
    }
  } while (day.slice(0, 7) === month);
  return days;
}

export function weekDays(anchorDay) {
  const monday = weekStart(anchorDay);
  return Array.from({ length: 7 }, (unused, column) => ({ day: addDays(monday, column), inMonth: true }));
}

// ‹ and ›: a month or a week back or ahead.
export function shiftAnchor(anchorDay, view, step) {
  if (view === "week") {
    return addDays(anchorDay, 7 * step);
  }
  const [year, month] = anchorDay.split("-").map(Number);
  const index = year * 12 + (month - 1) + step;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

// The ClickUp dates the project already has (the deadline axis's items that
// came from ClickUp): a milestone on its day, a phase as a band over its
// days. Typed deadlines and hidden ones stay on the axis only.
export function clickupCalendarItems(timeline) {
  const items = [];
  for (const deadline of (timeline && timeline.deadlines) || []) {
    if (deadline.source !== "clickup" || !Number.isFinite(deadline.date)) {
      continue;
    }
    const endDay = localDay(deadline.date);
    const base = { id: deadline.id, label: deadline.label, taskId: deadline.taskId || null };
    if (Number.isFinite(deadline.start)) {
      const startDay = localDay(deadline.start);
      items.push({ ...base, kind: "phase", startDay: startDay < endDay ? startDay : endDay, endDay });
    } else {
      items.push({ ...base, kind: "milestone", day: endDay });
    }
  }
  return items;
}

// What every shown day lists, in this order: ClickUp phases (named on the
// first day of the view they appear on, "…" after that), ClickUp
// milestones, then the user's own entries (by time). Map day → items.
export function itemsByDay(days, entries, clickupItems) {
  const shown = days.map((cell) => cell.day);
  const byDay = new Map(shown.map((day) => [day, []]));
  if (shown.length === 0) {
    return byDay;
  }
  const firstShown = shown[0];
  for (const item of clickupItems || []) {
    if (item.kind !== "phase") {
      continue;
    }
    for (const day of shown) {
      if (day >= item.startDay && day <= item.endDay) {
        byDay.get(day).push({ kind: "phase", key: `phase-${item.id}-${day}`, item, continued: day !== item.startDay && day !== firstShown });
      }
    }
  }
  for (const item of clickupItems || []) {
    if (item.kind === "milestone" && byDay.has(item.day)) {
      byDay.get(item.day).push({ kind: "milestone", key: `milestone-${item.id}`, item });
    }
  }
  for (const { date, entry } of expandEntries(entries, firstShown, shown[shown.length - 1])) {
    if (byDay.has(date)) {
      byDay.get(date).push({ kind: entry.repeat && entry.repeat !== "none" ? "repeat" : "entry", key: `entry-${entry.id}-${date}`, entry, date });
    }
  }
  return byDay;
}

// The small time after an entry: "2–4 PM", "9:30 AM", "2 PM – 12:30 AM" in
// English; "14:00–16:00" in the other languages.
export function timeSuffix(time, language) {
  if (!time) {
    return "";
  }
  const [start, end] = String(time).split("-");
  if (!String(language || "en").startsWith("en")) {
    return end ? `${start}–${end}` : start;
  }
  const parts = (clock) => {
    const [hour, minute] = clock.split(":").map(Number);
    const meridiem = hour < 12 ? "AM" : "PM";
    const shownHour = hour % 12 === 0 ? 12 : hour % 12;
    return { text: minute === 0 ? String(shownHour) : `${shownHour}:${String(minute).padStart(2, "0")}`, meridiem };
  };
  const from = parts(start);
  if (!end) {
    return `${from.text} ${from.meridiem}`;
  }
  const to = parts(end);
  return from.meridiem === to.meridiem ? `${from.text}–${to.text} ${to.meridiem}` : `${from.text} ${from.meridiem} – ${to.text} ${to.meridiem}`;
}
