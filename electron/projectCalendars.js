// Each project's own calendar, saved to <userData>/project-calendars.json.
// It is optional (a project shows it once Settings → "Show calendar" is on,
// board.showCalendar in project-boards.json) and needs no ClickUp: the
// entries are typed in the view or added by an agent with
// `clauding calendar add`. Nothing is fetched from anywhere.
//
// File shape (version 1):
//   {
//     "version": 1,
//     "projects": {
//       "<board id>": {
//         "view": "month" | "week",          // remembered per project
//         "entries": [
//           { "id": "3f2a9c1b", "title": "QA staging",
//             "date": "2026-10-06",           // the first day (YYYY-MM-DD)
//             "time": "14:00-16:00" | "14:00" | null,
//             "repeat": "none" | "daily" | "weekly" | "biweekly" | "monthly",
//             "weekday": "tue" | null,        // weekly / biweekly only
//             "until": "2026-12-23" | null,   // last day, inclusive
//             "link": { "kind": "task" | "session", "id": "…", "label": "…" } | null,
//             "skipDates": ["2026-10-13"],    // single occurrences deleted
//             "createdAt": 1791234567890 }
//         ]
//       }
//     }
//   }
//
// Anything unexpected is dropped when read; a file that does not parse is set
// aside as project-calendars.json.bak and the store starts empty. A change on
// disk (another window, a hand edit) is read again by reloadFromDisk().
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { REPEATS, cleanWeekday, firstOnOrAfter, isDay, weekdayName } from "./lib/calendarRecurrence.js";

export const CALENDAR_VIEWS = ["month", "week"];
const MAXIMUM_TITLE_LENGTH = 120;
const MAXIMUM_ENTRIES = 2000;
const MAXIMUM_SKIPPED = 500;

function cleanText(value, maximumLength) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

// "14:00-16:00", "9:30", "14:00–16:00" → "14:00-16:00", "09:30"; else null.
export function cleanTime(value) {
  const text = String(value === undefined || value === null ? "" : value).trim().replace(/\s/g, "").replace(/[–—]/g, "-");
  const match = /^(\d{1,2}):(\d{2})(?:-(\d{1,2}):(\d{2}))?$/.exec(text);
  if (!match) {
    return null;
  }
  const [, startHour, startMinute, endHour, endMinute] = match;
  const clock = (hour, minute) => (Number(hour) <= 23 && Number(minute) <= 59 ? `${hour.padStart(2, "0")}:${minute}` : null);
  const start = clock(startHour, startMinute);
  if (!start) {
    return null;
  }
  if (endHour === undefined) {
    return start;
  }
  const end = clock(endHour, endMinute);
  return end && end > start ? `${start}-${end}` : null;
}

function cleanLink(raw) {
  if (!raw || typeof raw !== "object" || !["task", "session"].includes(raw.kind)) {
    return null;
  }
  const id = cleanText(raw.id, 120);
  return id ? { kind: raw.kind, id, label: cleanText(raw.label, 200) || null } : null;
}

function newEntryId() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

// One entry as the file keeps it. `strict` (a new entry or an edit) throws
// a sentence the command line and the sheet can show; reading the file
// only drops what cannot be used.
export function cleanCalendarEntry(raw, { strict = false, now = Date.now() } = {}) {
  function refuse(sentence) {
    if (strict) {
      throw new Error(sentence);
    }
    return null;
  }
  if (!raw || typeof raw !== "object") {
    return refuse("an entry needs a title and a date.");
  }
  const title = cleanText(raw.title, MAXIMUM_TITLE_LENGTH);
  if (!title) {
    return refuse("an entry needs a title.");
  }
  if (!isDay(raw.date)) {
    return refuse(`"${raw.date || ""}" is not a date (use YYYY-MM-DD).`);
  }
  const hasTime = raw.time !== undefined && raw.time !== null && String(raw.time).trim() !== "";
  const time = hasTime ? cleanTime(raw.time) : null;
  if (hasTime && !time) {
    return refuse(`"${raw.time}" is not a time (use 14:00 or 14:00-16:00).`);
  }
  if (raw.repeat && !REPEATS.includes(raw.repeat)) {
    // Read from the file, an unknown repeat becomes a single day.
    refuse(`"${raw.repeat}" is not a repeat (${REPEATS.join(", ")}).`);
  }
  const repeat = REPEATS.includes(raw.repeat) ? raw.repeat : "none";
  let date = raw.date;
  let weekday = null;
  if (repeat === "weekly" || repeat === "biweekly") {
    const asked = raw.weekday ? cleanWeekday(raw.weekday) : null;
    if (raw.weekday && !asked) {
      return refuse(`"${raw.weekday}" is not a day of the week (mon … sun).`);
    }
    weekday = asked || weekdayName(date);
    // The date is the first occurrence, so "every second week" has a clear start.
    date = firstOnOrAfter(date, weekday);
  }
  const hasUntil = raw.until !== undefined && raw.until !== null && raw.until !== "";
  let until = null;
  if (hasUntil && repeat !== "none") {
    if (!isDay(raw.until)) {
      return refuse(`"${raw.until}" is not a date (use YYYY-MM-DD).`);
    }
    if (raw.until < date) {
      return refuse(`the last day (${raw.until}) is before the first one (${date}).`);
    }
    until = raw.until;
  }
  const skipDates = [...new Set((Array.isArray(raw.skipDates) ? raw.skipDates : []).filter(isDay))].sort().slice(-MAXIMUM_SKIPPED);
  const createdAt = Number(raw.createdAt);
  return {
    id: cleanText(raw.id, 64) || newEntryId(),
    title,
    date,
    time,
    repeat,
    weekday,
    until,
    link: cleanLink(raw.link),
    skipDates: repeat === "none" ? [] : skipDates,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now
  };
}

function cleanProject(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const seen = new Set();
  const entries = [];
  for (const candidate of Array.isArray(source.entries) ? source.entries : []) {
    const entry = cleanCalendarEntry(candidate);
    if (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  return { view: CALENDAR_VIEWS.includes(source.view) ? source.view : "month", entries: entries.slice(0, MAXIMUM_ENTRIES) };
}

export function cleanCalendarState(raw) {
  const projects = {};
  const source = raw && typeof raw === "object" && raw.projects && typeof raw.projects === "object" ? raw.projects : {};
  for (const [boardId, project] of Object.entries(source)) {
    const key = cleanText(boardId, 64);
    if (key) {
      projects[key] = cleanProject(project);
    }
  }
  return { version: 1, projects };
}

function readCalendarFile(storagePath) {
  let text;
  try {
    text = fs.readFileSync(storagePath, "utf8");
  } catch (error) {
    return { state: cleanCalendarState(null), readable: true };
  }
  try {
    return { state: cleanCalendarState(JSON.parse(text)), readable: true };
  } catch (error) {
    return { state: null, readable: false };
  }
}

export function createProjectCalendarStore({ storagePath, onChange = () => {}, log = null }) {
  const first = readCalendarFile(storagePath);
  if (!first.readable) {
    try {
      fs.copyFileSync(storagePath, `${storagePath}.bak`);
    } catch (error) {
      // Nothing to keep; start empty either way.
    }
  }
  let state = first.state || cleanCalendarState(null);

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  // Written at once (the file is small), so a `clauding calendar add` is on
  // disk before its line is printed.
  function save() {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    const temporaryPath = `${storagePath}.writing`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryPath, storagePath);
    onChange(snapshot());
  }

  function projectOf(boardId) {
    const key = cleanText(boardId, 64);
    if (!key) {
      throw new Error("no project was named.");
    }
    if (!state.projects[key]) {
      state.projects[key] = { view: "month", entries: [] };
    }
    return state.projects[key];
  }

  function findEntry(boardId, entryId) {
    const project = projectOf(boardId);
    const index = project.entries.findIndex((entry) => entry.id === entryId);
    if (index === -1) {
      throw new Error(`there is no calendar entry ${entryId}.`);
    }
    return { project, index };
  }

  return {
    getState: snapshot,
    get(boardId) {
      const project = state.projects[boardId] || { view: "month", entries: [] };
      return JSON.parse(JSON.stringify(project));
    },
    addEntry(boardId, draft) {
      const project = projectOf(boardId);
      const entry = cleanCalendarEntry({ ...draft, id: null, createdAt: null }, { strict: true });
      while (project.entries.some((existing) => existing.id === entry.id)) {
        entry.id = newEntryId();
      }
      project.entries.push(entry);
      save();
      return { ...entry };
    },
    updateEntry(boardId, entryId, patch) {
      const { project, index } = findEntry(boardId, entryId);
      const current = project.entries[index];
      const entry = cleanCalendarEntry({ ...current, ...patch, id: current.id, createdAt: current.createdAt }, { strict: true });
      project.entries[index] = entry;
      save();
      return { ...entry };
    },
    // Deletes by id in whichever project holds it (ids are short and the
    // command line names only the id): { boardId, entry }.
    removeEntry(entryId, boardId = null) {
      for (const [key, project] of Object.entries(state.projects)) {
        if (boardId && key !== boardId) {
          continue;
        }
        const index = project.entries.findIndex((entry) => entry.id === entryId);
        if (index !== -1) {
          const [entry] = project.entries.splice(index, 1);
          save();
          return { boardId: key, entry };
        }
      }
      throw new Error(`there is no calendar entry ${entryId}.`);
    },
    // "Delete this occurrence" of a repeating entry.
    skipOccurrence(boardId, entryId, day) {
      if (!isDay(day)) {
        throw new Error(`"${day}" is not a date.`);
      }
      const { project, index } = findEntry(boardId, entryId);
      const entry = project.entries[index];
      entry.skipDates = [...new Set([...(entry.skipDates || []), day])].sort();
      save();
      return { ...entry };
    },
    setView(boardId, view) {
      if (!CALENDAR_VIEWS.includes(view)) {
        throw new Error(`"${view}" is not a calendar view.`);
      }
      const project = projectOf(boardId);
      if (project.view !== view) {
        project.view = view;
        save();
      }
      return view;
    },
    reloadFromDisk() {
      const loaded = readCalendarFile(storagePath);
      if (!loaded.readable || JSON.stringify(loaded.state) === JSON.stringify(state)) {
        return false;
      }
      state = loaded.state;
      if (log) {
        log(`[calendar] re-read ${storagePath} after a change on disk`);
      }
      onChange(snapshot());
      return true;
    }
  };
}
