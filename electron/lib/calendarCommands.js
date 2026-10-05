// `clauding calendar add|list|remove`: how an agent puts something in a
// project's calendar (electron/projectCalendars.js) without anyone clicking.
// Two halves, both pure enough for the dry tests:
//   parseCalendarArguments — what bin/clauding turns the words into;
//   createCalendarCommands — what the running app answers (one line for add
//     and remove, one line per entry for list).
//
//   clauding calendar add "<title>" [--date YYYY-MM-DD] [--time 14:00-16:00]
//       [--daily | --weekly <mon..sun> | --biweekly <mon..sun> | --monthly]
//       [--until YYYY-MM-DD] [--project <name or id>]
//   clauding calendar list [--project <name or id>] [--from YYYY-MM-DD --to YYYY-MM-DD]
//   clauding calendar remove <id>
//
// Without --project the entry goes to the project of the terminal it was
// run in (the project whose task the session is linked to, or whose
// repository the terminal works in), else the project on screen, else the
// only project there is.
import { addDays, cleanWeekday, expandEntries, isDay, localDay } from "./calendarRecurrence.js";

export const CALENDAR_USAGE =
  'clauding calendar add "<title>" [--date YYYY-MM-DD] [--time 14:00-16:00] [--daily|--weekly <day>|--biweekly <day>|--monthly] [--until YYYY-MM-DD] [--project <name>]' +
  " | clauding calendar list [--project <name>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] | clauding calendar remove <id>";

const DAY_WORDS = { today: 0, tomorrow: 1 };
// How far `list --from` alone looks ahead, and `list --to` alone looks back.
const DEFAULT_LIST_DAYS = 30;

// A specific problem says only that (one line); a request that is not a
// calendar command at all gets the whole usage.
function usageError(detail) {
  return new Error(detail || `Use: ${CALENDAR_USAGE}`);
}

// "today" / "tomorrow" / YYYY-MM-DD → YYYY-MM-DD, against `today`.
function dayArgument(flag, value, today) {
  const word = String(value || "").toLowerCase();
  if (word in DAY_WORDS) {
    return addDays(today, DAY_WORDS[word]);
  }
  if (!isDay(value)) {
    throw usageError(`${flag} wants a date like 2026-10-06, not "${value || ""}".`);
  }
  return value;
}

// The words after `clauding calendar`, as the request the app receives.
export function parseCalendarArguments(words, { today = localDay(new Date()) } = {}) {
  const [action, ...rest] = Array.isArray(words) ? words : [];
  if (action === "remove") {
    if (rest.length !== 1 || rest[0].startsWith("--")) {
      throw usageError("remove takes one entry id.");
    }
    return { action: "remove", id: rest[0] };
  }
  if (action !== "add" && action !== "list") {
    throw usageError();
  }
  const request = { action };
  const positional = [];
  for (let position = 0; position < rest.length; position += 1) {
    const word = rest[position];
    const next = () => {
      position += 1;
      if (position >= rest.length) {
        throw usageError(`${word} needs a value.`);
      }
      return rest[position];
    };
    const setRepeat = (repeat, weekday = null) => {
      if (request.repeat) {
        throw usageError("give one repeat only.");
      }
      request.repeat = repeat;
      request.weekday = weekday;
    };
    if (!word.startsWith("--")) {
      positional.push(word);
    } else if (word === "--project") {
      request.project = next();
    } else if (action === "list" && (word === "--from" || word === "--to")) {
      request[word.slice(2)] = dayArgument(word, next(), today);
    } else if (action === "add" && word === "--date") {
      request.date = dayArgument(word, next(), today);
    } else if (action === "add" && word === "--until") {
      request.until = dayArgument(word, next(), today);
    } else if (action === "add" && word === "--time") {
      request.time = next();
    } else if (action === "add" && word === "--daily") {
      setRepeat("daily");
    } else if (action === "add" && word === "--monthly") {
      setRepeat("monthly");
    } else if (action === "add" && (word === "--weekly" || word === "--biweekly")) {
      const value = next();
      const weekday = cleanWeekday(value);
      if (!weekday) {
        throw usageError(`${word} wants a day of the week (mon … sun), not "${value}".`);
      }
      setRepeat(word.slice(2), weekday);
    } else {
      throw usageError(`${word} is not an option of calendar ${action}.`);
    }
  }
  if (action === "list") {
    if (positional.length > 0) {
      throw usageError("list takes no title.");
    }
    return request;
  }
  if (positional.length !== 1 || !positional[0].trim()) {
    throw usageError('add takes one title (in quotes when it has spaces).');
  }
  return { ...request, title: positional[0], repeat: request.repeat || "none" };
}

// ---- the app's side ---------------------------------------------------------

function englishDay(day, { withWeekday = false } = {}) {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const options = { month: "short", day: "numeric", timeZone: "UTC" };
  if (withWeekday) {
    options.weekday = "short";
  }
  return new Intl.DateTimeFormat("en-US", options).format(new Date(Date.UTC(year, month - 1, dayOfMonth)));
}

function capitalized(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "weekly on Tue, 14:00-16:00, until Dec 23" — what the confirmation and
// the list say about an entry.
export function describeEntry(entry) {
  const parts = [];
  const weekday = entry.weekday ? capitalized(entry.weekday) : "";
  if (entry.repeat === "none") {
    parts.push(englishDay(entry.date, { withWeekday: true }));
  } else if (entry.repeat === "daily") {
    parts.push(`daily from ${englishDay(entry.date)}`);
  } else if (entry.repeat === "weekly") {
    parts.push(`weekly on ${weekday}`);
  } else if (entry.repeat === "biweekly") {
    parts.push(`every 2 weeks on ${weekday} from ${englishDay(entry.date)}`);
  } else {
    parts.push(`monthly on day ${Number(entry.date.slice(8))} from ${englishDay(entry.date)}`);
  }
  if (entry.time) {
    parts.push(entry.time);
  }
  if (entry.until) {
    parts.push(`until ${englishDay(entry.until)}`);
  }
  return parts.join(", ");
}

function possessive(name) {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

// `projects`: the boards ({ id, name, showCalendar }); `store`: the calendar
// store; `defaultProjectFor(request)`: the board id the caller's terminal
// (or the screen) points at, or null; `today()`: the local day.
export function createCalendarCommands({ store, listProjects, defaultProjectFor = () => null, today = () => localDay(new Date()) }) {
  function projectNamed(wanted) {
    const projects = listProjects();
    const text = String(wanted).trim().toLowerCase();
    const exact =
      projects.find((board) => board.id === wanted) ||
      projects.find((board) => board.name.toLowerCase() === text);
    if (exact) {
      return exact;
    }
    const partial = projects.filter((board) => board.name.toLowerCase().includes(text));
    if (partial.length === 1) {
      return partial[0];
    }
    const names = projects.map((board) => board.name).join(", ") || "none";
    throw new Error(
      partial.length > 1 ? `"${wanted}" matches several projects: ${partial.map((board) => board.name).join(", ")}.` : `there is no project "${wanted}" (projects: ${names}).`
    );
  }

  function chooseProject(request) {
    if (request.project) {
      return projectNamed(request.project);
    }
    const projects = listProjects();
    const defaultId = defaultProjectFor(request);
    const found = defaultId ? projects.find((board) => board.id === defaultId) : null;
    if (found) {
      return found;
    }
    if (projects.length === 1) {
      return projects[0];
    }
    if (projects.length === 0) {
      throw new Error("there are no projects in Clauding yet.");
    }
    throw new Error(`say which project with --project (one of: ${projects.map((board) => board.name).join(", ")}).`);
  }

  function offNote(board) {
    return board.showCalendar ? "" : ` The calendar is off for ${board.name}; turn on "Show calendar" in its Settings to see it.`;
  }

  function add(request) {
    const board = chooseProject(request);
    const entry = store().addEntry(board.id, {
      title: request.title,
      date: request.date || today(),
      time: request.time || null,
      repeat: request.repeat || "none",
      weekday: request.weekday || null,
      until: request.until || null
    });
    return `Added "${entry.title}" to ${possessive(board.name)} calendar (${describeEntry(entry)}; id ${entry.id}).${offNote(board)}`;
  }

  function list(request) {
    const board = chooseProject(request);
    const { entries } = store().get(board.id);
    if (!request.from && !request.to) {
      if (entries.length === 0) {
        return `No entries in ${possessive(board.name)} calendar.`;
      }
      return [...entries]
        .sort((first, second) => first.date.localeCompare(second.date) || first.title.localeCompare(second.title))
        .map((entry) => `${entry.id}  ${entry.title} — ${describeEntry(entry)}`)
        .join("\n");
    }
    const from = request.from || addDays(request.to, -DEFAULT_LIST_DAYS);
    const to = request.to || addDays(from, DEFAULT_LIST_DAYS);
    if (to < from) {
      throw new Error(`--to (${to}) is before --from (${from}).`);
    }
    const occurrences = expandEntries(entries, from, to);
    if (occurrences.length === 0) {
      return `Nothing in ${possessive(board.name)} calendar from ${from} to ${to}.`;
    }
    return occurrences
      .map(({ date, entry }) => `${date}${entry.time ? ` ${entry.time}` : ""}  ${entry.title}  (${entry.id}${entry.repeat === "none" ? "" : `, ${entry.repeat}`})`)
      .join("\n");
  }

  function remove(request) {
    const id = String(request.id || "").trim();
    if (!id) {
      throw usageError("remove takes one entry id.");
    }
    const { boardId, entry } = store().removeEntry(id);
    const board = listProjects().find((candidate) => candidate.id === boardId);
    return `Removed "${entry.title}" from ${board ? `${possessive(board.name)} calendar` : "the calendar"}.`;
  }

  return {
    handle(request) {
      if (request.action === "add") {
        return add(request);
      }
      if (request.action === "list") {
        return list(request);
      }
      if (request.action === "remove") {
        return remove(request);
      }
      throw usageError();
    }
  };
}
