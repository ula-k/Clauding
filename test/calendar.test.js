// A project's own calendar: the days a repeating entry falls on, the store
// in project-calendars.json, `clauding calendar add|list|remove` (the
// words, the app's answers, and bin/clauding through a real socket), and
// what the month and week views list. Dry: throw-away folders, no window.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expandEntries, occurrencesBetween } from "../electron/lib/calendarRecurrence.js";
import { cleanCalendarEntry, cleanTime, createProjectCalendarStore } from "../electron/projectCalendars.js";
import { createCalendarCommands, parseCalendarArguments } from "../electron/lib/calendarCommands.js";
import { createCommandRequestHandler } from "../electron/lib/commandRequests.js";
import { startCommandSocket } from "../electron/commandSocket.js";
import { cleanBoard } from "../electron/projectBoards.js";
import { clickupCalendarItems, itemsByDay, monthDays, shiftAnchor, timeSuffix, weekDays } from "../src/renderer/calendarView.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-calendar-"));
}

// ---- recurrence --------------------------------------------------------------

test("weekly lands on its weekday, from the first one on or after the date", () => {
  // 2026-10-05 is a Monday; Tuesdays follow.
  const entry = { date: "2026-10-05", repeat: "weekly", weekday: "tue" };
  assert.deepEqual(occurrencesBetween(entry, "2026-10-01", "2026-10-31"), ["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"]);
  assert.deepEqual(occurrencesBetween(entry, "2026-10-14", "2026-10-21"), ["2026-10-20"]);
});

test("biweekly counts from its anchor, not from the range asked for", () => {
  const entry = { date: "2026-10-06", repeat: "biweekly", weekday: "tue" };
  assert.deepEqual(occurrencesBetween(entry, "2026-10-01", "2026-11-30"), ["2026-10-06", "2026-10-20", "2026-11-03", "2026-11-17"]);
  // A range starting on an "off" week still lands on the anchor's rhythm.
  assert.deepEqual(occurrencesBetween(entry, "2026-10-12", "2026-10-25"), ["2026-10-20"]);
});

test("monthly on the 31st is the last day of a shorter month", () => {
  const entry = { date: "2026-01-31", repeat: "monthly" };
  assert.deepEqual(occurrencesBetween(entry, "2026-01-01", "2026-05-31"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  assert.deepEqual(occurrencesBetween({ date: "2027-12-31", repeat: "monthly" }, "2028-02-01", "2028-02-29"), ["2028-02-29"]);
});

test("until is inclusive, and skipped days are left out", () => {
  const entry = { date: "2026-10-06", repeat: "weekly", weekday: "tue", until: "2026-10-20", skipDates: ["2026-10-13"] };
  assert.deepEqual(occurrencesBetween(entry, "2026-10-01", "2026-12-31"), ["2026-10-06", "2026-10-20"]);
});

test("daily runs across a month boundary, and a single day is only itself", () => {
  assert.deepEqual(occurrencesBetween({ date: "2026-10-30", repeat: "daily", until: "2026-11-02" }, "2026-10-01", "2026-11-30"), [
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
    "2026-11-02"
  ]);
  assert.deepEqual(occurrencesBetween({ date: "2026-10-30", repeat: "none" }, "2026-10-01", "2026-10-31"), ["2026-10-30"]);
  assert.deepEqual(occurrencesBetween({ date: "2026-10-30", repeat: "none" }, "2026-11-01", "2026-11-30"), []);
});

test("expandEntries sorts by day, then untimed first, then time", () => {
  const found = expandEntries(
    [
      { id: "late", title: "Late", date: "2026-10-06", time: "16:00", repeat: "none" },
      { id: "early", title: "Early", date: "2026-10-06", time: "09:00", repeat: "none" },
      { id: "plain", title: "Plain", date: "2026-10-06", time: null, repeat: "none" },
      { id: "first", title: "First", date: "2026-10-05", repeat: "none" }
    ],
    "2026-10-01",
    "2026-10-31"
  );
  assert.deepEqual(found.map((item) => item.entry.id), ["first", "plain", "early", "late"]);
});

// ---- the store ---------------------------------------------------------------

test("entries are cleaned like the other stores: bad times refused, a weekly date moved to its weekday", () => {
  assert.equal(cleanTime("9:30"), "09:30");
  assert.equal(cleanTime("14:00–16:00"), "14:00-16:00");
  assert.equal(cleanTime("16:00-14:00"), null);
  assert.equal(cleanTime("25:00"), null);
  assert.throws(() => cleanCalendarEntry({ title: "x", date: "2026-02-30" }, { strict: true }), /not a date/);
  assert.throws(() => cleanCalendarEntry({ title: "x", date: "2026-10-06", time: "noon" }, { strict: true }), /not a time/);
  assert.throws(() => cleanCalendarEntry({ title: "x", date: "2026-10-06", repeat: "daily", until: "2026-10-01" }, { strict: true }), /before the first one/);
  const weekly = cleanCalendarEntry({ title: " QA  staging ", date: "2026-10-05", repeat: "weekly", weekday: "Tuesday" });
  assert.equal(weekly.title, "QA staging");
  assert.equal(weekly.date, "2026-10-06");
  assert.equal(weekly.weekday, "tue");
  assert.equal(cleanCalendarEntry({ title: "x", date: "2026-10-06", until: "2026-12-01" }).until, null, "a single day has no last day");
  assert.equal(cleanCalendarEntry({ title: "", date: "2026-10-06" }), null);
});

test("the store saves at once, skips one occurrence, remembers the view, and re-reads a changed file", () => {
  const folder = scratchFolder();
  const storagePath = path.join(folder, "project-calendars.json");
  const changes = [];
  const store = createProjectCalendarStore({ storagePath, onChange: (state) => changes.push(state) });
  const entry = store.addEntry("board-1", { title: "QA staging", date: "2026-10-06", repeat: "weekly", time: "14:00-16:00" });
  assert.match(entry.id, /^[0-9a-f]{8}$/);
  const onDisk = JSON.parse(fs.readFileSync(storagePath, "utf8"));
  assert.equal(onDisk.projects["board-1"].entries[0].title, "QA staging");
  store.skipOccurrence("board-1", entry.id, "2026-10-13");
  store.setView("board-1", "week");
  assert.deepEqual(store.get("board-1").entries[0].skipDates, ["2026-10-13"]);
  assert.equal(store.get("board-1").view, "week");
  assert.equal(store.reloadFromDisk(), false, "its own save is not news");
  onDisk.projects["board-1"].entries.push({ id: "byhand01", title: "Typed by hand", date: "2026-10-09" });
  onDisk.projects["board-1"].entries.push({ title: "no date" });
  fs.writeFileSync(storagePath, JSON.stringify(onDisk));
  assert.equal(store.reloadFromDisk(), true);
  assert.deepEqual(store.get("board-1").entries.map((candidate) => candidate.id), [entry.id, "byhand01"]);
  const removed = store.removeEntry("byhand01");
  assert.equal(removed.boardId, "board-1");
  assert.ok(changes.length >= 4);
  fs.writeFileSync(storagePath, "{ not json");
  const fresh = createProjectCalendarStore({ storagePath });
  assert.deepEqual(fresh.getState().projects, {});
  assert.ok(fs.existsSync(`${storagePath}.bak`), "a broken file is set aside");
});

test("the calendar is off unless a project turns it on", () => {
  assert.equal(cleanBoard({ name: "Languages" }).showCalendar, false);
  assert.equal(cleanBoard({ name: "Languages", showCalendar: true }).showCalendar, true);
  assert.equal(cleanBoard({ name: "Languages", showCalendar: "yes" }).showCalendar, false);
});

// ---- clauding calendar --------------------------------------------------------

test("the words of `clauding calendar` become a request", () => {
  assert.deepEqual(
    parseCalendarArguments(["add", "QA staging", "--weekly", "tue", "--time", "14:00-16:00", "--until", "2026-12-23", "--project", "groove"]),
    { action: "add", title: "QA staging", repeat: "weekly", weekday: "tue", time: "14:00-16:00", until: "2026-12-23", project: "groove" }
  );
  assert.deepEqual(parseCalendarArguments(["add", "Dentist", "--date", "tomorrow"], { today: "2026-10-31" }), {
    action: "add",
    title: "Dentist",
    date: "2026-11-01",
    repeat: "none"
  });
  assert.deepEqual(parseCalendarArguments(["list", "--from", "2026-10-01", "--to", "2026-10-31"]), { action: "list", from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(parseCalendarArguments(["remove", "3f2a9c1b"]), { action: "remove", id: "3f2a9c1b" });
  assert.throws(() => parseCalendarArguments(["add", "x", "--weekly", "someday"]), /day of the week/);
  assert.throws(() => parseCalendarArguments(["add", "x", "--daily", "--monthly"]), /one repeat only/);
  assert.throws(() => parseCalendarArguments(["add", "x", "--date", "10/06"]), /wants a date/);
  assert.throws(() => parseCalendarArguments(["add"]), /one title/);
  assert.throws(() => parseCalendarArguments(["list", "--time", "14:00"]), /not an option/);
  assert.throws(() => parseCalendarArguments(["export"]), /Use: clauding calendar add/);
});

function fakeCalendarApp({ boards, onScreen = null }) {
  const folder = scratchFolder();
  const store = createProjectCalendarStore({ storagePath: path.join(folder, "project-calendars.json") });
  const commands = createCalendarCommands({
    store: () => store,
    listProjects: () => boards,
    defaultProjectFor: () => onScreen,
    today: () => "2026-10-05"
  });
  const handler = createCommandRequestHandler({
    terminals: { get: () => null, mostRecentlyFocused: () => null },
    panelTabs: {},
    describeTarget: () => ({}),
    calendar: commands
  });
  return { store, handler };
}

test("calendar add answers one line, goes to the project on screen, and says when the calendar is off", async () => {
  const boards = [
    { id: "groove", name: "Groove", showCalendar: true },
    { id: "languages", name: "Languages", showCalendar: false }
  ];
  const { store, handler } = fakeCalendarApp({ boards, onScreen: "groove" });
  const added = await handler.handleCommandRequest({
    command: "calendar",
    action: "add",
    title: "QA staging",
    repeat: "weekly",
    weekday: "tue",
    time: "14:00-16:00",
    until: "2026-12-23"
  });
  const [entry] = store.get("groove").entries;
  assert.equal(added, `Added "QA staging" to Groove's calendar (weekly on Tue, 14:00-16:00, until Dec 23; id ${entry.id}).`);
  assert.equal(entry.date, "2026-10-06", "today was Monday; the first Tuesday is the start");
  const languages = await handler.handleCommandRequest({ command: "calendar", action: "add", title: "Chinese lesson", project: "lang", date: "2026-10-07" });
  assert.match(languages, /^Added "Chinese lesson" to Languages' calendar \(Wed, Oct 7; id [0-9a-f]{8}\)\. The calendar is off for Languages/);
  const listed = await handler.handleCommandRequest({ command: "calendar", action: "list", project: "groove", from: "2026-10-01", to: "2026-10-20" });
  assert.deepEqual(listed.split("\n"), [`2026-10-06 14:00-16:00  QA staging  (${entry.id}, weekly)`, `2026-10-13 14:00-16:00  QA staging  (${entry.id}, weekly)`, `2026-10-20 14:00-16:00  QA staging  (${entry.id}, weekly)`]);
  assert.equal(await handler.handleCommandRequest({ command: "calendar", action: "remove", id: entry.id }), `Removed "QA staging" from Groove's calendar.`);
  await assert.rejects(handler.handleCommandRequest({ command: "calendar", action: "remove", id: entry.id }), /no calendar entry/);
  await assert.rejects(handler.handleCommandRequest({ command: "calendar", action: "add", title: "x", project: "nope" }), /no project "nope"/);
});

test("without a project on screen, calendar add asks which one unless there is only one", async () => {
  const two = fakeCalendarApp({ boards: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }] });
  await assert.rejects(two.handler.handleCommandRequest({ command: "calendar", action: "add", title: "x" }), /say which project with --project \(one of: Alpha, Beta\)/);
  const one = fakeCalendarApp({ boards: [{ id: "a", name: "Alpha", showCalendar: true }] });
  assert.match(await one.handler.handleCommandRequest({ command: "calendar", action: "add", title: "x" }), /to Alpha's calendar \(Mon, Oct 5;/);
  assert.equal(await one.handler.handleCommandRequest({ command: "calendar", action: "list" }), `${one.store.get("a").entries[0].id}  x — Mon, Oct 5`);
});

test("bin/clauding sends calendar requests and refuses bad words before reaching the app", async () => {
  const folder = scratchFolder();
  const socketPath = path.join(folder, "clauding.sock");
  const received = [];
  const stop = startCommandSocket({
    socketPath,
    async handleRequest(request) {
      received.push(request);
      if (request.action === "remove") {
        throw new Error("there is no calendar entry zz.");
      }
      return "Added.";
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const run = (words) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(projectRoot, "bin", "clauding"), ...words],
        { cwd: folder, env: { ...process.env, CLAUDING_SOCKET: socketPath, CLAUDING_TERMINAL_ID: "" } },
        (error, standardOutput, standardError) => resolve({ code: error ? error.code : 0, standardOutput, standardError })
      );
    });
  try {
    const added = await run(["calendar", "add", "QA staging", "--biweekly", "fri", "--project", "Groove"]);
    assert.equal(added.code, 0);
    assert.equal(added.standardOutput, "Added.\n");
    const removed = await run(["calendar", "remove", "zz"]);
    assert.equal(removed.code, 1);
    assert.equal(removed.standardError, "clauding: could not remove the calendar entry — there is no calendar entry zz.\n");
    const wrong = await run(["calendar", "add", "x", "--weekly"]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.standardError, /^clauding: could not add to the calendar — --weekly needs a value\./);
  } finally {
    stop();
  }
  assert.equal(received.length, 2, "the bad one never reached the app");
  assert.deepEqual(
    { command: received[0].command, action: received[0].action, title: received[0].title, repeat: received[0].repeat, weekday: received[0].weekday, project: received[0].project },
    { command: "calendar", action: "add", title: "QA staging", repeat: "biweekly", weekday: "fri", project: "Groove" }
  );
});

// ---- what the views list -------------------------------------------------------

test("a month is whole weeks from Monday; a week is Monday to Sunday", () => {
  const october = monthDays("2026-10-15");
  assert.equal(october.length, 35);
  assert.equal(october[0].day, "2026-09-28");
  assert.equal(october[0].inMonth, false);
  assert.equal(october[3].day, "2026-10-01");
  assert.equal(october[34].day, "2026-11-01");
  assert.deepEqual(weekDays("2026-10-08").map((cell) => cell.day), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
  assert.equal(shiftAnchor("2026-12-15", "month", 1), "2027-01-01");
  assert.equal(shiftAnchor("2026-01-15", "month", -1), "2025-12-01");
  assert.equal(shiftAnchor("2026-10-05", "week", -1), "2026-09-28");
});

test("each day lists the ClickUp phase (named once), milestones, then entries; ClickUp only when it is there", () => {
  const local = (day) => new Date(`${day}T12:00:00`).getTime();
  const timeline = {
    deadlines: [
      { id: "phase", label: "Initial Features Web", source: "clickup", taskId: "abc", start: local("2026-10-01"), date: local("2026-12-23") },
      { id: "demo", label: "Demo prep", source: "clickup", taskId: "def", start: null, date: local("2026-10-09") },
      { id: "typed", label: "Typed deadline", source: "manual", start: null, date: local("2026-10-09") }
    ]
  };
  const items = clickupCalendarItems(timeline);
  assert.deepEqual(items.map((item) => item.kind), ["phase", "milestone"], "a typed deadline stays on the axis");
  const week = weekDays("2026-10-05");
  const byDay = itemsByDay(week, [{ id: "qa", title: "QA staging", date: "2026-10-06", repeat: "weekly", weekday: "tue", time: "14:00-16:00" }], items);
  assert.deepEqual(byDay.get("2026-10-05").map((item) => [item.kind, Boolean(item.continued)]), [["phase", false]]);
  assert.deepEqual(byDay.get("2026-10-06").map((item) => [item.kind, Boolean(item.continued)]), [["phase", true], ["repeat", false]]);
  assert.deepEqual(byDay.get("2026-10-09").map((item) => item.kind), ["phase", "milestone"]);
  const noClickup = itemsByDay(week, [], clickupCalendarItems({ deadlines: [timeline.deadlines[2]] }));
  assert.ok([...noClickup.values()].every((list) => list.length === 0));
  assert.equal(timeSuffix("14:00-16:00", "en"), "2–4 PM");
  assert.equal(timeSuffix("11:30-13:00", "en"), "11:30 AM – 1 PM");
  assert.equal(timeSuffix("14:00-16:00", "pl"), "14:00–16:00");
});
