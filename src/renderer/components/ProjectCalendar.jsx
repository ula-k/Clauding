import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { localDay } from "../../../electron/lib/calendarRecurrence.js";
import { ITEMS_PER_MONTH_DAY, clickupCalendarItems, firstOfMonth, itemsByDay, monthDays, shiftAnchor, timeSuffix, weekDays } from "../calendarView.js";

// A project's own calendar, under the deadline axis (variant A of the
// mockup). Shown only when the project's Settings say "Show calendar"; it
// needs no ClickUp. Month or week (remembered per project in
// project-calendars.json); the week has no hour grid — each day is a list.
// A click on a day adds an entry on that day, a click on an entry edits it;
// ClickUp milestones and phases (when the project has them) open their task.
// Nothing is fetched: entries come from this view or from
// `clauding calendar add`.

const REPEAT_CHOICES = ["none", "daily", "weekly", "biweekly", "monthly"];
const SESSIONS_IN_LINK_PICKER = 15;
const UNTIL_SUGGESTIONS = 3;

function dateFromDay(day) {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return new Date(year, month - 1, dayOfMonth);
}

export default function ProjectCalendar({ boardId, snapshot, now, language, sessions, onOpenTask, onSelectSession }) {
  const { translate } = useTranslation();
  const today = localDay(now || Date.now());
  const [calendar, setCalendar] = useState(null);
  const [view, setView] = useState("month");
  const [anchor, setAnchor] = useState(today);
  const [sheet, setSheet] = useState(null);

  useEffect(() => {
    let canceled = false;
    setCalendar(null);
    setSheet(null);
    setAnchor(localDay(Date.now()));
    window.clauding.getCalendar(boardId).then((answer) => {
      if (!canceled) {
        setCalendar(answer);
        setView(answer.view || "month");
      }
    });
    // An agent's `clauding calendar add`, or another window, lands here.
    const unsubscribe = window.clauding.onCalendarChanged((state) => {
      if (!canceled && state && state.projects) {
        setCalendar(state.projects[boardId] || { view: "month", entries: [] });
      }
    });
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [boardId]);

  const chooseView = useCallback(
    (nextView) => {
      setView(nextView);
      window.clauding.setCalendarView(boardId, nextView).catch(() => {});
    },
    [boardId]
  );

  const clickupItems = useMemo(() => clickupCalendarItems(snapshot && snapshot.timeline), [snapshot]);
  const days = view === "week" ? weekDays(anchor) : monthDays(anchor);
  const byDay = itemsByDay(days, calendar ? calendar.entries : [], clickupItems);
  const hasClickup = clickupItems.length > 0;

  const monthName = new Intl.DateTimeFormat(language || "en", { month: "long", year: "numeric" });
  const shortDay = new Intl.DateTimeFormat(language || "en", { month: "short", day: "numeric" });
  const weekdayShort = new Intl.DateTimeFormat(language || "en", { weekday: "short" });
  const rangeLabel =
    view === "week"
      ? `${shortDay.format(dateFromDay(days[0].day))} – ${
          days[0].day.slice(0, 7) === days[6].day.slice(0, 7) ? Number(days[6].day.slice(8)) : shortDay.format(dateFromDay(days[6].day))
        }`
      : monthName.format(dateFromDay(firstOfMonth(anchor)));
  const showsToday = days.some((cell) => cell.day === today && cell.inMonth);

  function openItem(event, cellItem) {
    event.stopPropagation();
    if (cellItem.kind === "phase" || cellItem.kind === "milestone") {
      if (cellItem.item.taskId) {
        onOpenTask(cellItem.item.taskId, cellItem.item.label);
      }
      return;
    }
    setSheet({ entry: cellItem.entry, occurrence: cellItem.date });
  }

  function itemButton(cellItem, withTime) {
    const className = { phase: "calendar-item is-phase", milestone: "calendar-item is-milestone", repeat: "calendar-item is-repeat", entry: "calendar-item is-mine" }[cellItem.kind];
    const label = cellItem.kind === "phase" || cellItem.kind === "milestone" ? cellItem.item.label : cellItem.entry.title;
    const time = cellItem.entry && cellItem.entry.time ? timeSuffix(cellItem.entry.time, language) : "";
    return (
      <button
        type="button"
        key={cellItem.key}
        className={className}
        title={time ? `${label} · ${time}` : label}
        onClick={(event) => openItem(event, cellItem)}
        data-calendar-item={cellItem.kind}
      >
        {cellItem.continued ? "…" : label}
        {withTime && time && <span className="calendar-time">{time}</span>}
      </button>
    );
  }

  return (
    <section className="project-card project-calendar" data-calendar={view}>
      <div className="calendar-head">
        <b>{translate("calendar.title")}</b>
        <span className="calendar-nav">
          <button type="button" className="calendar-arrow" onClick={() => setAnchor(shiftAnchor(anchor, view, -1))} title={translate("calendar.previous")} data-calendar-previous>
            ‹
          </button>
          <button
            type="button"
            className="calendar-range"
            onClick={() => setAnchor(today)}
            title={showsToday ? undefined : translate("calendar.backToToday")}
            data-calendar-range
          >
            {rangeLabel}
          </button>
          <button type="button" className="calendar-arrow" onClick={() => setAnchor(shiftAnchor(anchor, view, 1))} title={translate("calendar.next")} data-calendar-next>
            ›
          </button>
        </span>
        <button type="button" className="text-link" onClick={() => setSheet({ entry: null, date: showsToday ? today : days.find((cell) => cell.inMonth).day })} data-calendar-add>
          + {translate("calendar.add")}
        </button>
        <span className="project-header-spacer" />
        <span className="calendar-toggle" role="group">
          {["month", "week"].map((choice) => (
            <button type="button" key={choice} className={view === choice ? "is-on" : ""} onClick={() => chooseView(choice)} data-calendar-view={choice}>
              {translate(`calendar.${choice}`)}
            </button>
          ))}
        </span>
      </div>
      <div className={view === "week" ? "calendar-grid is-week" : "calendar-grid is-month"}>
        {view === "month" &&
          days.slice(0, 7).map((cell) => (
            <div key={`weekday-${cell.day}`} className="calendar-weekday">
              {weekdayShort.format(dateFromDay(cell.day)).toUpperCase()}
            </div>
          ))}
        {days.map((cell) => {
          const items = byDay.get(cell.day) || [];
          const weekend = [0, 6].includes(dateFromDay(cell.day).getDay());
          const shown = view === "month" ? items.slice(0, ITEMS_PER_MONTH_DAY) : items;
          const hidden = items.length - shown.length;
          const classes = ["calendar-day"];
          if (!cell.inMonth || (view === "week" && weekend)) {
            classes.push("is-out");
          }
          if (cell.day === today) {
            classes.push("is-today");
          }
          const dayNumber = Number(cell.day.slice(8));
          return (
            <div
              key={cell.day}
              className={classes.join(" ")}
              role="button"
              tabIndex={0}
              onClick={() => setSheet({ entry: null, date: cell.day })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.target === event.currentTarget) {
                  setSheet({ entry: null, date: cell.day });
                }
              }}
              title={translate("calendar.addOnDay")}
              data-calendar-day={cell.day}
            >
              <div className="calendar-day-number">
                {view === "week" ? `${weekdayShort.format(dateFromDay(cell.day)).toUpperCase()} ${dayNumber}` : dayNumber}
                {cell.day === today ? ` · ${translate("calendar.todaySuffix")}` : ""}
              </div>
              {shown.map((cellItem) => itemButton(cellItem, view === "week"))}
              {hidden > 0 && (
                <button
                  type="button"
                  className="calendar-more"
                  onClick={(event) => {
                    event.stopPropagation();
                    setAnchor(cell.day);
                    chooseView("week");
                  }}
                  data-calendar-more
                >
                  {translate("calendar.more", { count: hidden })}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="calendar-legend project-dim" data-calendar-legend>
        <span className="calendar-item is-mine">{translate("calendar.legendMine")}</span>
        <span className="calendar-item is-repeat">{translate("calendar.legendRepeat")}</span>
        {hasClickup && <span className="calendar-item is-milestone">{translate("calendar.legendMilestone")}</span>}
        {hasClickup && <span className="calendar-item is-phase">{translate("calendar.legendPhase")}</span>}
      </div>
      {sheet && (
        <CalendarEntrySheet
          boardId={boardId}
          entry={sheet.entry}
          date={sheet.date}
          occurrence={sheet.occurrence}
          snapshot={snapshot}
          sessions={sessions}
          clickupItems={clickupItems}
          today={today}
          language={language}
          onOpenTask={onOpenTask}
          onSelectSession={onSelectSession}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  );
}

// "+ Add" / a click on a day (entry: null), or a click on an entry: title,
// date, an optional time, how it repeats, an optional last day, and an
// optional link to a task or a session. Delete asks first; for a repeating
// entry it asks whether only the clicked day goes, or all of them.
function CalendarEntrySheet({ boardId, entry, date, occurrence, snapshot, sessions, clickupItems, today, language, onOpenTask, onSelectSession, onClose }) {
  const { translate } = useTranslation();
  const sheetRef = useRef(null);
  const [startTime, endTime] = entry && entry.time ? entry.time.split("-") : ["", ""];
  const [draft, setDraft] = useState({
    title: entry ? entry.title : "",
    date: entry ? entry.date : date,
    startTime: startTime || "",
    endTime: endTime || "",
    repeat: entry ? entry.repeat : "none",
    until: entry && entry.until ? entry.until : "",
    link: entry && entry.link ? entry.link : null
  });
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState(null);
  const repeating = Boolean(entry && entry.repeat !== "none");

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function change(patch) {
    setDraft((previous) => ({ ...previous, ...patch }));
  }

  const shortDay = new Intl.DateTimeFormat(language || "en", { month: "short", day: "numeric" });
  // The ClickUp dates still ahead, offered as the last day of a repeat
  // ("Dec 23 — Initial Features Web ends").
  const untilSuggestions = clickupItems
    .map((item) => ({ day: item.kind === "phase" ? item.endDay : item.day, label: item.label }))
    .filter((suggestion) => suggestion.day >= today)
    .sort((first, second) => first.day.localeCompare(second.day))
    .slice(0, UNTIL_SUGGESTIONS);
  const taskChoices = snapshot && snapshot.mode !== "git" ? (snapshot.cards || []).map((card) => ({ id: card.id, label: card.name })) : [];
  const sessionChoices = [...(sessions || [])]
    .sort((first, second) => (second.lastActivity || 0) - (first.lastActivity || 0))
    .slice(0, SESSIONS_IN_LINK_PICKER)
    .map((session) => ({ id: session.sessionId, label: session.title || session.sessionId }));
  const linkValue = draft.link ? `${draft.link.kind}:${draft.link.id}` : "";
  const linkKnown = !draft.link || [...taskChoices, ...sessionChoices].some((choice) => `${draft.link.kind}:${choice.id}` === linkValue);

  function pickLink(value) {
    if (!value) {
      change({ link: null });
      return;
    }
    const [kind, ...rest] = value.split(":");
    const id = rest.join(":");
    const choice = (kind === "task" ? taskChoices : sessionChoices).find((candidate) => candidate.id === id);
    change({ link: { kind, id, label: choice ? choice.label : id } });
  }

  function openLink() {
    if (!draft.link) {
      return;
    }
    if (draft.link.kind === "task") {
      onOpenTask(draft.link.id, draft.link.label);
    } else {
      onSelectSession(draft.link.id);
    }
    onClose();
  }

  async function save() {
    const time = draft.startTime ? (draft.endTime ? `${draft.startTime}-${draft.endTime}` : draft.startTime) : null;
    const fields = {
      title: draft.title,
      date: draft.date,
      time,
      repeat: draft.repeat,
      // A changed date picks the weekday of a weekly entry again.
      weekday: null,
      until: draft.repeat !== "none" && draft.until ? draft.until : null,
      link: draft.link
    };
    try {
      if (entry) {
        await window.clauding.updateCalendarEntry(boardId, entry.id, fields);
      } else {
        await window.clauding.addCalendarEntry(boardId, fields);
      }
      onClose();
    } catch (error) {
      setFailure(String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  }

  async function remove(onlyThisDay) {
    if (onlyThisDay) {
      await window.clauding.skipCalendarOccurrence(boardId, entry.id, occurrence);
    } else {
      await window.clauding.removeCalendarEntry(boardId, entry.id);
    }
    onClose();
  }

  const usable = draft.title.trim() !== "" && Boolean(draft.date);
  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (sheetRef.current && !sheetRef.current.contains(event.target)) {
          onClose();
        }
      }}
    >
      <div className="sheet calendar-sheet" ref={sheetRef} data-calendar-sheet={entry ? entry.id : "new"}>
        <div className="sheet-title">{translate(entry ? "calendar.editTitle" : "calendar.addTitle")}</div>
        <div className="calendar-field">
          <label className="calendar-label" htmlFor="calendar-title">
            {translate("calendar.fieldTitle")}
          </label>
          <input
            id="calendar-title"
            className="agent-form-input"
            value={draft.title}
            placeholder={translate("calendar.titlePlaceholder")}
            autoFocus
            onChange={(event) => change({ title: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && usable) {
                save();
              }
            }}
            data-calendar-title
          />
        </div>
        <div className="calendar-row">
          <div className="calendar-field">
            <label className="calendar-label" htmlFor="calendar-date">
              {translate(draft.repeat === "none" ? "calendar.fieldDate" : "calendar.fieldStarts")}
            </label>
            <input id="calendar-date" type="date" className="agent-form-input" value={draft.date} onChange={(event) => change({ date: event.target.value })} data-calendar-date />
          </div>
          <div className="calendar-field">
            <span className="calendar-label">{translate("calendar.fieldTime")}</span>
            <span className="calendar-times">
              <input type="time" className="agent-form-input" value={draft.startTime} onChange={(event) => change({ startTime: event.target.value })} aria-label={translate("calendar.fieldTime")} data-calendar-start />
              <span className="project-dim">{translate("calendar.timeTo")}</span>
              <input type="time" className="agent-form-input" value={draft.endTime} disabled={!draft.startTime} onChange={(event) => change({ endTime: event.target.value })} aria-label={translate("calendar.timeTo")} data-calendar-end />
            </span>
          </div>
        </div>
        <div className="calendar-field">
          <span className="calendar-label">{translate("calendar.fieldRepeats")}</span>
          <span className="calendar-chips">
            {REPEAT_CHOICES.map((choice) => (
              <button type="button" key={choice} className={draft.repeat === choice ? "filter-chip is-active" : "filter-chip"} onClick={() => change({ repeat: choice })} data-calendar-repeat={choice}>
                {translate(`calendar.repeat.${choice}`)}
              </button>
            ))}
          </span>
        </div>
        {draft.repeat !== "none" && (
          <div className="calendar-field">
            <label className="calendar-label" htmlFor="calendar-until">
              {translate("calendar.fieldUntil")}
            </label>
            <span className="calendar-until">
              <input id="calendar-until" type="date" className="agent-form-input" value={draft.until} min={draft.date} onChange={(event) => change({ until: event.target.value })} data-calendar-until />
              {untilSuggestions.map((suggestion) => (
                <button type="button" key={`${suggestion.day}-${suggestion.label}`} className="filter-chip" onClick={() => change({ until: suggestion.day })} data-calendar-until-suggestion>
                  {translate("calendar.untilSuggestion", { date: shortDay.format(dateFromDay(suggestion.day)), label: suggestion.label })}
                </button>
              ))}
            </span>
          </div>
        )}
        <div className="calendar-field">
          <label className="calendar-label" htmlFor="calendar-link">
            {translate("calendar.fieldLink")}
          </label>
          <span className="calendar-link-row">
            <select id="calendar-link" className="agent-form-input" value={linkValue} onChange={(event) => pickLink(event.target.value)} data-calendar-link>
              <option value="">{translate("calendar.linkNone")}</option>
              {!linkKnown && <option value={linkValue}>{draft.link.label || draft.link.id}</option>}
              {taskChoices.length > 0 && (
                <optgroup label={translate("calendar.linkTasks")}>
                  {taskChoices.map((choice) => (
                    <option key={choice.id} value={`task:${choice.id}`}>
                      {choice.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {sessionChoices.length > 0 && (
                <optgroup label={translate("calendar.linkSessions")}>
                  {sessionChoices.map((choice) => (
                    <option key={choice.id} value={`session:${choice.id}`}>
                      {choice.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {entry && draft.link && (
              <button type="button" className="text-link" onClick={openLink} data-calendar-open-link>
                {translate("calendar.openLink")}
              </button>
            )}
          </span>
        </div>
        {failure && <p className="sheet-hint is-problem">{failure}</p>}
        {confirming ? (
          <div className="settings-confirm calendar-confirm" data-calendar-confirm>
            <span>
              {repeating
                ? translate("calendar.deleteRepeatConfirm", { title: entry.title, date: shortDay.format(dateFromDay(occurrence)) })
                : translate("calendar.deleteConfirm", { title: entry.title })}
            </span>
            {repeating && (
              <button type="button" className="button is-danger is-small" onClick={() => remove(true)} data-calendar-delete-one>
                {translate("calendar.deleteOne")}
              </button>
            )}
            <button type="button" className="button is-danger is-small" onClick={() => remove(false)} data-calendar-delete-all>
              {translate(repeating ? "calendar.deleteAll" : "calendar.delete")}
            </button>
            <button type="button" className="button is-ghost is-small" onClick={() => setConfirming(false)}>
              {translate("projects.cancel")}
            </button>
          </div>
        ) : (
          <div className="sheet-actions">
            {entry && (
              <button type="button" className="button is-secondary calendar-delete" onClick={() => setConfirming(true)} data-calendar-delete>
                {translate("calendar.delete")}
              </button>
            )}
            <button type="button" className="button is-ghost" onClick={onClose}>
              {translate("projects.cancel")}
            </button>
            <button type="button" className="button is-primary" disabled={!usable} onClick={save} data-calendar-save>
              {translate(entry ? "calendar.save" : "calendar.addButton")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
