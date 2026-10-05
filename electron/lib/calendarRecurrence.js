// A project's calendar entries (electron/projectCalendars.js) and the days
// they fall on. Pure: no clock, no file, no window — the month and week
// views and `clauding calendar list --from --to` ask the same questions here.
//
// A day is always the text "YYYY-MM-DD" — a day on the wall calendar, with
// no time zone — so a repeat never drifts by an hour around a daylight-saving
// change. The arithmetic below is done on UTC midnights for that reason.
//
// Repeats:
//   none      the entry's own day only
//   daily     every day from the entry's day
//   weekly    every week on `weekday` (the first one on or after the date)
//   biweekly  every second week, counted from that first one
//   monthly   the same day of every month; the 29th–31st land on the last
//             day of a shorter month (the 31st is Feb 28, Apr 30, …)
// `until` is the last day an occurrence may fall on (inclusive), and
// `skipDates` are single occurrences that were deleted.

export const REPEATS = ["none", "daily", "weekly", "biweekly", "monthly"];
// Index = what Date#getUTCDay answers (Sunday first).
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
// A range longer than this is cut, so a typo cannot expand forever.
const MAXIMUM_RANGE_DAYS = 3 * 366;

function pad(value) {
  return String(value).padStart(2, "0");
}

export function isDay(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dayToTime(day) {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, dayOfMonth);
}

function timeToDay(time) {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// The local wall-calendar day of a moment (a Date or milliseconds) — "today",
// or the day a ClickUp due date falls on.
export function localDay(moment) {
  const date = new Date(moment);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(day, count) {
  return timeToDay(dayToTime(day) + count * DAY_MILLISECONDS);
}

export function daysBetween(fromDay, toDay) {
  return Math.round((dayToTime(toDay) - dayToTime(fromDay)) / DAY_MILLISECONDS);
}

// 0 = Sunday … 6 = Saturday.
export function weekdayIndex(day) {
  return new Date(dayToTime(day)).getUTCDay();
}

export function weekdayName(day) {
  return WEEKDAYS[weekdayIndex(day)];
}

// "tue", "Tuesday", "TU" → "tue"; anything else → null.
export function cleanWeekday(value) {
  const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (text.length < 2) {
    return null;
  }
  return WEEKDAYS.find((name) => name.startsWith(text.slice(0, Math.min(3, text.length)))) || null;
}

export function firstOnOrAfter(day, weekday) {
  const wanted = WEEKDAYS.indexOf(weekday);
  if (wanted === -1) {
    return day;
  }
  return addDays(day, (wanted - weekdayIndex(day) + 7) % 7);
}

export function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// The Monday that starts the week a day is in.
export function weekStart(day) {
  return addDays(day, -((weekdayIndex(day) + 6) % 7));
}

// The day a weekly or biweekly entry first happens on.
export function firstOccurrence(entry) {
  if ((entry.repeat === "weekly" || entry.repeat === "biweekly") && entry.weekday) {
    return firstOnOrAfter(entry.date, entry.weekday);
  }
  return entry.date;
}

function monthlyDays(anchorDay, fromDay, toDay) {
  const [anchorYear, anchorMonth, anchorDate] = anchorDay.split("-").map(Number);
  const [fromYear, fromMonth] = fromDay.split("-").map(Number);
  let year = fromYear;
  let month = fromMonth;
  if (year < anchorYear || (year === anchorYear && month < anchorMonth)) {
    year = anchorYear;
    month = anchorMonth;
  }
  const found = [];
  for (;;) {
    const dayOfMonth = Math.min(anchorDate, daysInMonth(year, month - 1));
    const day = `${year}-${pad(month)}-${pad(dayOfMonth)}`;
    if (day > toDay) {
      return found;
    }
    if (day >= fromDay) {
      found.push(day);
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

// Every day one entry falls on between two days (both inclusive).
export function occurrencesBetween(entry, fromDay, toDay) {
  if (!entry || !isDay(entry.date) || !isDay(fromDay) || !isDay(toDay) || fromDay > toDay) {
    return [];
  }
  const lastAsked = daysBetween(fromDay, toDay) > MAXIMUM_RANGE_DAYS ? addDays(fromDay, MAXIMUM_RANGE_DAYS) : toDay;
  const start = firstOccurrence(entry);
  const end = isDay(entry.until) && entry.until < lastAsked ? entry.until : lastAsked;
  if (start > end) {
    return [];
  }
  const skipped = new Set(Array.isArray(entry.skipDates) ? entry.skipDates : []);
  let days = [];
  const repeat = REPEATS.includes(entry.repeat) ? entry.repeat : "none";
  if (repeat === "none") {
    days = start >= fromDay ? [start] : [];
  } else if (repeat === "monthly") {
    days = monthlyDays(start, fromDay > start ? fromDay : start, end);
  } else {
    const step = repeat === "daily" ? 1 : repeat === "weekly" ? 7 : 14;
    const behind = daysBetween(start, fromDay);
    let day = behind > 0 ? addDays(start, Math.ceil(behind / step) * step) : start;
    while (day <= end) {
      days.push(day);
      day = addDays(day, step);
    }
  }
  return days.filter((day) => !skipped.has(day));
}

// The start of a "14:00-16:00" time, for sorting a day's list.
function timeKey(entry) {
  return entry && typeof entry.time === "string" ? entry.time.slice(0, 5) : "";
}

// Every occurrence of every entry in a range: [{ date, entry }], by day,
// then the ones without a time, then by time, then by title.
export function expandEntries(entries, fromDay, toDay) {
  const found = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const date of occurrencesBetween(entry, fromDay, toDay)) {
      found.push({ date, entry });
    }
  }
  return found.sort(
    (first, second) =>
      first.date.localeCompare(second.date) ||
      timeKey(first.entry).localeCompare(timeKey(second.entry)) ||
      String(first.entry.title).localeCompare(String(second.entry.title))
  );
}
