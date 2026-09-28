import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { relativeTime } from "../time.js";
import {
  BUCKET_COLORS,
  BUCKET_ORDER,
  axisMilestones,
  bucketSegments,
  burnDownPoints,
  cardLinks,
  cardsForFilter,
  cardsForStat,
  emptyDeadlineReason,
  moveInList,
  searchCards,
  statFilterLabel,
  subtaskMatchesQuery,
  subtaskMatchesStat,
  subtaskSummaryParts,
  dailyPaceText,
  defaultSpecStage,
  filterChips,
  needsLabel,
  keyAxisMarker,
  phaseLanes,
  pipelineDots,
  sessionStateLabel,
  sessionTone,
  sourceState
} from "../projectsView.js";
import ProjectSettingsSheet, { DeadlineRow, blankDeadline, usableDeadlines } from "./ProjectSettingsSheet.jsx";
import PopupMenu, { MenuItem, MenuLabel, MenuSeparator, MenuSubmenu } from "./PopupMenu.jsx";
import { DotsIcon, SearchIcon } from "./Icons.jsx";

// The middle column while a project is selected in the Projects tab. It
// replaces the terminal only on screen: MiddleColumn keeps the terminal
// stack mounted underneath, so nothing running is closed or re-drawn.
//
// Top to bottom: the header (name, where the data comes from, Refresh),
// the deadline axis with the computed "per day" line, the numbers, the
// filter chips, and the task cards — or, under "Specs pipeline", the stage
// counters with the list of one stage. ClickUp, git and GitHub are only
// read: what a click can change is what this view shows, the side panel
// (the app's own ClickUp task view), which session is on screen, and this
// project's own settings in project-boards.json (Up next, links made by
// hand, deadlines — through the settings sheet, the deadline sheet or a
// card's "…" menu). "Start a session for this task" opens a terminal.

const AUTO_REFRESH_MILLISECONDS = 5 * 60 * 1000;
const ROLE_EMOJI = { spec: "✍️", builder: "🔨", other: "💬" };
const BURN_DOWN_WIDTH = 150;
const BURN_DOWN_HEIGHT = 36;
// How many of the newest sessions "Link a session…" offers.
const SESSIONS_IN_LINK_MENU = 15;
// About how wide one label under the deadline axis is.
const AXIS_LABEL_PIXELS = 330;
// …and one date alone ("Apr 12").
const AXIS_DATE_PIXELS = 90;

function cleanErrorMessage(error) {
  return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function useShortDate(language) {
  return useMemo(() => {
    const formatter = new Intl.DateTimeFormat(language || "en", { month: "short", day: "numeric" });
    return (time) => (time ? formatter.format(new Date(time)) : "");
  }, [language]);
}

function ClickupMark() {
  return <span className="clickup-mark" aria-hidden="true" />;
}

export default function ProjectView({
  boardId,
  boardName,
  now,
  onOpenTask,
  onOpenExternal,
  onSelectSession,
  onLoaded,
  panelOpen,
  onTogglePanel,
  windowTools,
  sessions,
  agents,
  settingsRequest,
  onSettingsRequestHandled,
  searchRequest,
  onSearchRequestHandled,
  onStartSession,
  onRemoved
}) {
  const { translate, language } = useTranslation();
  const [snapshot, setSnapshot] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("focus");
  const [expandedCardId, setExpandedCardId] = useState(null);
  const [specStage, setSpecStage] = useState(null);
  const [showNotStarted, setShowNotStarted] = useState(false);
  const [statFilter, setStatFilter] = useState(null);
  const [query, setQuery] = useState("");
  const [settingsSection, setSettingsSection] = useState(null);
  const [deadlineEditing, setDeadlineEditing] = useState(null);
  const boardRef = useRef(boardId);
  const chipsRef = useRef(null);
  const onLoadedRef = useRef(onLoaded);
  boardRef.current = boardId;
  onLoadedRef.current = onLoaded;

  const load = useCallback(
    async (options = {}) => {
      const askedFor = boardId;
      if (options.refresh) {
        setRefreshing(true);
      }
      try {
        const answer = await window.clauding.getBoardSnapshot(askedFor, options);
        if (boardRef.current === askedFor) {
          setSnapshot(answer);
          setLoadError(null);
          if (onLoadedRef.current) {
            onLoadedRef.current();
          }
        }
      } catch (error) {
        if (boardRef.current === askedFor) {
          setLoadError(cleanErrorMessage(error));
        }
      } finally {
        if (boardRef.current === askedFor) {
          setRefreshing(false);
        }
      }
    },
    [boardId]
  );

  // A new project starts from nothing: the skeleton, the default filter.
  useEffect(() => {
    setSnapshot(null);
    setLoadError(null);
    setFilter("focus");
    setExpandedCardId(null);
    setSpecStage(null);
    setShowNotStarted(false);
    setStatFilter(null);
    setQuery("");
    setSettingsSection(null);
    setDeadlineEditing(null);
    load();
    // Every five minutes while the view is open; the main process only
    // asks ClickUp again when its cache is older than that.
    const timer = setInterval(() => load(), AUTO_REFRESH_MILLISECONDS);
    return () => clearInterval(timer);
  }, [boardId, load]);

  // Projects → Project Settings… in the menu bar.
  useEffect(() => {
    if (settingsRequest) {
      setSettingsSection("general");
      onSettingsRequestHandled();
    }
  }, [settingsRequest, onSettingsRequestHandled]);

  // A task found by the search on the left: its name in the search box
  // here, on Everything, so the card is on screen.
  useEffect(() => {
    if (searchRequest && searchRequest.boardId === boardId) {
      setQuery(searchRequest.query || "");
      setFilter("everything");
      setStatFilter(null);
      setShowNotStarted(true);
      setExpandedCardId(searchRequest.taskId || null);
      onSearchRequestHandled();
    }
  }, [searchRequest, boardId, onSearchRequestHandled]);

  // This project's own settings, changed from the view (pin, links,
  // deadlines): read the board, change it, save it, draw again.
  const changeBoard = useCallback(
    async (mutate) => {
      const state = await window.clauding.getBoards();
      const board = (state.boards || []).find((candidate) => candidate.id === boardId);
      if (!board) {
        return;
      }
      await window.clauding.updateBoard(boardId, mutate(board));
      await load();
    },
    [boardId, load]
  );

  const cardActions = useMemo(
    () => ({
      pin: (card) => changeBoard((board) => ({ upNext: [...(board.upNext || []).filter((taskId) => taskId !== card.id), card.id] })),
      unpin: (card) => changeBoard((board) => ({ upNext: (board.upNext || []).filter((taskId) => taskId !== card.id) })),
      move: (card, step) => changeBoard((board) => ({ upNext: moveInList(board.upNext || [], card.id, step) })),
      link: (card, sessionId) =>
        changeBoard((board) => {
          const links = { ...(board.manualLinks || {}) };
          const link = links[card.id] || { sessionIds: [], unlinkedSessionIds: [] };
          links[card.id] = {
            sessionIds: [...new Set([...link.sessionIds, sessionId])],
            unlinkedSessionIds: link.unlinkedSessionIds.filter((candidate) => candidate !== sessionId)
          };
          return { manualLinks: links };
        }),
      unlink: (card, sessionId) =>
        changeBoard((board) => {
          const links = { ...(board.manualLinks || {}) };
          const link = links[card.id] || { sessionIds: [], unlinkedSessionIds: [] };
          links[card.id] = {
            sessionIds: link.sessionIds.filter((candidate) => candidate !== sessionId),
            unlinkedSessionIds: [...new Set([...link.unlinkedSessionIds, sessionId])]
          };
          return { manualLinks: links };
        }),
      start: (card, repository, agent) => onStartSession && onStartSession({ boardId, card, repository, agent })
    }),
    [changeBoard, onStartSession, boardId]
  );

  function chooseStat(stat) {
    setStatFilter(stat);
    setExpandedCardId(null);
    if (chipsRef.current) {
      chipsRef.current.scrollIntoView({ block: "start" });
    }
  }

  function chooseFilter(filterId) {
    setFilter(filterId);
    setStatFilter(null);
    setExpandedCardId(null);
    // Picking a list is asking to read it: the chips go to the top of the
    // view (they stay there, sticky) with the list right under them.
    if (chipsRef.current) {
      chipsRef.current.scrollIntoView({ block: "start" });
    }
  }

  const state = sourceState(snapshot);
  const pullRequestsAvailable = !snapshot || snapshot.sources.pullRequests.every((source) => source.available !== false);
  const name = snapshot ? snapshot.name : boardName;

  return (
    <div className="project-view" data-project-view={boardId}>
      <header className="project-header">
        <span className="project-ring is-large" style={{ borderColor: snapshot && snapshot.color ? `var(${snapshot.color})` : "var(--project-color-0)" }} />
        <h1 className="project-title">{name}</h1>
        {snapshot && <SourceChips snapshot={snapshot} pullRequestsAvailable={pullRequestsAvailable} />}
        <span className="project-header-spacer" />
        <span className={state.kind === "offline" ? "project-freshness is-offline" : "project-freshness"} data-project-freshness={state.kind}>
          {refreshing
            ? translate("projects.refreshing")
            : state.kind === "offline"
              ? translate("projects.offlineAsOf", { time: state.refreshedAt ? relativeTime(state.refreshedAt, translate, now) : "—" })
              : state.refreshedAt
                ? now - state.refreshedAt < 60000
                  ? translate("projects.refreshedJustNow")
                  : translate("projects.refreshedAgo", { time: relativeTime(state.refreshedAt, translate, now) })
                : ""}
        </span>
        <button
          type="button"
          className="text-link"
          disabled={refreshing}
          onClick={() => load({ refresh: true, fetchGit: true })}
          title={translate("projects.refreshHint")}
          data-project-refresh
        >
          {translate("projects.refresh")}
        </button>
        <button type="button" className="text-link" onClick={() => setSettingsSection("general")} data-project-settings-open>
          {translate("projects.settings")}
        </button>
        {onTogglePanel && (
          <button type="button" className="text-link" onClick={onTogglePanel} data-project-panel-toggle>
            {panelOpen ? translate("panel.hide") : translate("panel.show")}
          </button>
        )}
        {windowTools}
      </header>
      <div className="project-body">
        {loadError && (
          <div className="project-banner is-error" data-project-state="load-error">
            <b>{translate("projects.loadFailed")}</b>
            <span>{loadError}</span>
          </div>
        )}
        {!snapshot && !loadError && <ProjectSkeleton />}
        {snapshot && <SourceBanner state={state} />}
        {snapshot && (
          <>
            <DeadlineCard
              snapshot={snapshot}
              now={now}
              language={language}
              onEdit={(deadlineId) => setDeadlineEditing(deadlineId || "new")}
              onEditAll={() => setSettingsSection("deadlines")}
              onOpenTask={onOpenTask}
              onHideDeadline={(deadlineId) =>
                changeBoard((board) => ({
                  deadlineHidden: [...new Set([...(board.deadlineHidden || []), deadlineId])],
                  keyDeadlineId: board.keyDeadlineId === deadlineId ? null : board.keyDeadlineId || null
                }))
              }
              onPinDeadline={(deadlineId) => changeBoard(() => ({ keyDeadlineId: deadlineId }))}
            />
            {snapshot.cards.length > 0 && <StatsCards snapshot={snapshot} activeStat={statFilter} onStat={chooseStat} />}
            {snapshot.cards.length === 0 && state.kind === "ok" && (
              <div className="project-banner" data-project-state="empty">
                {translate("projects.noTasks")}
              </div>
            )}
            {snapshot.cards.length > 0 && (
              <>
                <div className="project-filters" ref={chipsRef} data-project-filters>
                  {filterChips(snapshot).map((chip) => (
                    <button
                      type="button"
                      key={chip.id}
                      className={chip.id === filter ? "filter-chip is-active" : "filter-chip"}
                      onClick={() => chooseFilter(chip.id)}
                      data-filter={chip.id}
                    >
                      {translate(`projects.filter.${chip.id}`)}
                      <span className="filter-chip-count">{chip.count}</span>
                    </button>
                  ))}
                  <span className="project-header-spacer" />
                  <span className="search-box task-search">
                    <SearchIcon />
                    <input
                      type="search"
                      value={query}
                      placeholder={translate("projects.searchTasks")}
                      onChange={(event) => setQuery(event.target.value)}
                      spellCheck={false}
                      data-task-search
                    />
                  </span>
                </div>
                {statFilter && (
                  <div className="stat-filter-row" data-stat-filter={statFilter.kind}>
                    <span className="filter-chip is-active">
                      {(() => {
                        const label = statFilterLabel(statFilter);
                        return translate(label.key, label.translateName ? { name: translate(label.values.name) } : label.values);
                      })()}
                      <span className="filter-chip-count">{searchCards(cardsForStat(snapshot, statFilter), query).length}</span>
                      <button type="button" className="stat-filter-clear" onClick={() => setStatFilter(null)} title={translate("projects.clearFilter")} data-stat-filter-clear>
                        ✕
                      </button>
                    </span>
                  </div>
                )}
                {!statFilter && filter !== "specs" && filter !== "upNext" && <div className="project-sorted">{translate("projects.sortedNeedsFirst")}</div>}
                {statFilter ? (
                  <CardList
                    snapshot={snapshot}
                    filter="stat"
                    statCards={searchCards(cardsForStat(snapshot, statFilter), query)}
                    stat={statFilter}
                    now={now}
                    language={language}
                    expandedCardId={expandedCardId}
                    onToggle={(cardId) => setExpandedCardId(expandedCardId === cardId ? null : cardId)}
                    showNotStarted
                    onShowNotStarted={() => {}}
                    pullRequestsAvailable={pullRequestsAvailable}
                    onOpenTask={onOpenTask}
                    onOpenExternal={onOpenExternal}
                    onSelectSession={onSelectSession}
                    sessions={sessions}
                    agents={agents}
                    repositories={snapshot.sources.repositories}
                    actions={cardActions}
                    query={query}
                  />
                ) : filter === "specs" ? (
                  <SpecPipeline
                    snapshot={snapshot}
                    stage={specStage || defaultSpecStage(snapshot.specPipeline)}
                    onStage={setSpecStage}
                    query={query}
                    now={now}
                    onOpenTask={onOpenTask}
                    onSelectSession={onSelectSession}
                  />
                ) : (
                  <CardList
                    snapshot={snapshot}
                    filter={filter}
                    now={now}
                    language={language}
                    expandedCardId={expandedCardId}
                    onToggle={(cardId) => setExpandedCardId(expandedCardId === cardId ? null : cardId)}
                    showNotStarted={showNotStarted}
                    onShowNotStarted={() => setShowNotStarted(true)}
                    pullRequestsAvailable={pullRequestsAvailable}
                    onOpenTask={onOpenTask}
                    onOpenExternal={onOpenExternal}
                    onSelectSession={onSelectSession}
                    sessions={sessions}
                    agents={agents}
                    repositories={snapshot.sources.repositories}
                    actions={cardActions}
                    query={query}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
      {settingsSection && (
        <ProjectSettingsSheet
          boardId={boardId}
          snapshot={snapshot}
          sessions={sessions}
          agents={agents}
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
          onSaved={() => {
            setSettingsSection(null);
            load({ refresh: true });
          }}
          onRemoved={(removedId) => {
            setSettingsSection(null);
            if (onRemoved) {
              onRemoved(removedId);
            }
          }}
        />
      )}
      {deadlineEditing && (
        <DeadlineSheet
          boardId={boardId}
          deadlineId={deadlineEditing === "new" ? null : deadlineEditing}
          snapshot={snapshot}
          onClose={() => setDeadlineEditing(null)}
          onSaved={() => {
            setDeadlineEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// One deadline, from a click on the axis (or "+ Add a deadline"): the same
// row the settings sheet has, saved on its own.
function DeadlineSheet({ boardId, deadlineId, snapshot, onClose, onSaved }) {
  const { translate } = useTranslation();
  const [board, setBoard] = useState(null);
  const [deadline, setDeadline] = useState(null);
  const [datedTasks, setDatedTasks] = useState([]);
  const sheetRef = useRef(null);
  const cardsById = useMemo(() => new Map(((snapshot && snapshot.cards) || []).map((card) => [card.id, card])), [snapshot]);

  useEffect(() => {
    let canceled = false;
    window.clauding.getBoards().then((state) => {
      if (canceled) {
        return;
      }
      const found = (state.boards || []).find((candidate) => candidate.id === boardId) || null;
      setBoard(found);
      const existing = found && deadlineId ? (found.deadlines || []).find((candidate) => candidate.id === deadlineId) : null;
      setDeadline(existing ? { ...existing } : blankDeadline());
    });
    window.clauding
      .getBoardSettingsData(boardId)
      .then((answer) => {
        if (!canceled) {
          setDatedTasks(answer.datedTasks || []);
        }
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [boardId, deadlineId]);

  async function save(remove = false) {
    const others = (board.deadlines || []).filter((candidate) => candidate.id !== deadline.id);
    const deadlines = remove ? others : usableDeadlines([...others, deadline]);
    await window.clauding.updateBoard(boardId, { deadlines });
    onSaved();
  }

  const usable = deadline && usableDeadlines([deadline]).length === 1;
  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (sheetRef.current && !sheetRef.current.contains(event.target)) {
          onClose();
        }
      }}
    >
      <div className="sheet is-wide deadline-sheet" ref={sheetRef} data-deadline-sheet={deadlineId || "new"}>
        <div className="sheet-title">{translate(deadlineId ? "projects.editDeadline" : "projects.addDeadline")}</div>
        <p className="sheet-hint">{translate("projectSettings.deadlinesHint")}</p>
        {deadline && (
          <DeadlineRow
            deadline={deadline}
            datedTasks={datedTasks}
            cardsById={cardsById}
            onChange={(patch) => setDeadline({ ...deadline, ...patch })}
            onRemove={() => (deadlineId ? save(true) : onClose())}
          />
        )}
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" onClick={onClose}>
            {translate("projects.cancel")}
          </button>
          <button type="button" className="button is-primary" disabled={!board || !usable} onClick={() => save(false)} data-deadline-save>
            {translate("projectSettings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function SourceChips({ snapshot, pullRequestsAvailable }) {
  const { translate } = useTranslation();
  const repositories = snapshot.sources.repositories || [];
  return (
    <span className="project-sources">
      {snapshot.sources.buildList && (
        <span className="source-chip" title={translate("projects.buildListHint")}>
          <ClickupMark />
          {snapshot.sources.buildList}
        </span>
      )}
      {snapshot.sources.planningList && (
        <span className="source-chip" title={translate("projects.planningListHint")}>
          <ClickupMark />
          {snapshot.sources.planningList}
        </span>
      )}
      {snapshot.mode === "git" && (
        <span className="source-chip is-muted" title={translate("projects.gitOnlyHint")} data-source-git-only>
          {translate("projects.gitOnly")}
        </span>
      )}
      {repositories.length > 0 && (
        <span className="source-chip" title={translate("projects.repositoriesHint")}>
          {repositories.map((repository, index) => (
            <span key={repository.name} className={repository.available === false ? "is-unavailable" : ""}>
              {index > 0 ? " · " : ""}
              {repository.name}
            </span>
          ))}
        </span>
      )}
      {!pullRequestsAvailable && <span className="source-chip is-muted">{translate("projects.ghUnavailable")}</span>}
    </span>
  );
}

function SourceBanner({ state }) {
  const { translate } = useTranslation();
  if (state.kind === "noToken" || state.kind === "badToken") {
    return (
      <div className="project-banner is-warning" data-project-state={state.kind}>
        <b>{translate(state.kind === "noToken" ? "projects.noTokenTitle" : "projects.badTokenTitle")}</b>
        <span>{translate("projects.tokenHowTo")}</span>
        <code className="project-banner-code">security add-generic-password -a clickup-api -s clickup-api-token -w &lt;token&gt;</code>
        <span>{translate("projects.tokenEnvironment")}</span>
        <span className="project-banner-note">{translate("projects.tokenReadOnly")}</span>
      </div>
    );
  }
  if (state.kind === "noList") {
    return (
      <div className="project-banner is-warning" data-project-state="no-list">
        <b>{translate("projects.noListTitle")}</b>
        <span>{translate("projects.noListText")}</span>
      </div>
    );
  }
  if (state.kind === "offline") {
    return (
      <div className="project-banner is-quiet" data-project-state="offline">
        {translate("projects.offlineText")}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="project-banner is-error" data-project-state="error">
        <b>{translate("projects.errorTitle")}</b>
        <span>{state.error ? translate(state.error.key, state.error.values) : state.message}</span>
        {state.call && <code className="project-banner-code">{state.call}</code>}
      </div>
    );
  }
  return null;
}

function ProjectSkeleton() {
  return (
    <div className="project-skeleton" data-project-state="loading">
      <div className="skeleton-block is-short" />
      <div className="skeleton-row">
        <div className="skeleton-block is-tall" />
        <div className="skeleton-block is-tall is-narrow" />
      </div>
      <div className="skeleton-block is-chips" />
      <div className="skeleton-block" />
      <div className="skeleton-block" />
    </div>
  );
}

// ---- deadlines (variant A) ---------------------------------------------------

function DeadlineCard({ snapshot, now, language, onEdit, onEditAll, onOpenTask, onHideDeadline, onPinDeadline }) {
  const { translate } = useTranslation();
  const shortDate = useShortDate(language);
  const timeline = snapshot.timeline;
  const axisRef = useRef(null);
  const [axisWidth, setAxisWidth] = useState(0);
  // The small "…" of a phase bar: { phase, anchor } while its menu is open.
  const [phaseMenu, setPhaseMenu] = useState(null);
  useEffect(() => {
    const axis = axisRef.current;
    if (!axis || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(() => setAxisWidth(axis.getBoundingClientRect().width));
    observer.observe(axis);
    return () => observer.disconnect();
  });
  if (!timeline || timeline.deadlines.length === 0) {
    // No numbers are made up: the axis says why it is empty (no deadline
    // here, and whether ClickUp has any dates a deadline could follow) —
    // or that every one of them was hidden.
    const reason =
      timeline && timeline.hiddenCount > 0
        ? { key: "projects.deadlinesAllHidden", values: { count: timeline.hiddenCount } }
        : emptyDeadlineReason(snapshot);
    return (
      <section className="project-card deadlines is-empty" data-deadlines="none">
        <b>{translate("projects.deadlines")}</b>
        <span className="project-dim" data-deadlines-empty-reason>
          {translate(reason.key, reason.values)}
        </span>
        <span className="project-header-spacer" />
        <button type="button" className="text-link" onClick={() => onEdit(null)} data-add-deadline-axis>
          + {translate("projects.addDeadline")}
        </button>
      </section>
    );
  }
  // Labels alternate above and below when two would touch: how close is
  // "touching" depends on how wide the axis is on screen right now.
  // Many single dates do not fit as labels on the axis: the axis keeps the
  // diamonds and their dates, and the names go in a row under it.
  const compactMarkers = axisMilestones(timeline).length > 3;
  const labelPixels = compactMarkers ? AXIS_DATE_PIXELS : AXIS_LABEL_PIXELS;
  const minimumGap = axisWidth > 0 ? Math.min(0.6, Math.max(0.04, labelPixels / axisWidth)) : 0.2;
  const milestones = axisMilestones(timeline, { minimumGap });
  const phaseText = (phase, outside = false) =>
    outside ? `${phase.label} → ${shortDate(phase.date)}` : `${phase.label} · ${shortDate(phase.start)} → ${shortDate(phase.date)}`;
  const lanes = phaseLanes(timeline, { axisWidth, labelOf: phaseText });
  const sources = snapshot.dateSources || {};
  const sourceNote =
    sources.source && sources.source.name
      ? translate("projects.deadlineSourceNote", { name: sources.source.name, count: sources.fromSource || 0, undated: sources.undatedInSource || 0 })
      : null;
  const pace = dailyPaceText(snapshot.dailyPace);
  const next = timeline.next;
  const keyMarker = keyAxisMarker(timeline);
  const hiddenNote = timeline.hiddenCount > 0 ? translate("projects.deadlinesHidden", { count: timeline.hiddenCount }) : null;
  return (
    <section className="project-card deadlines" data-deadlines={timeline.deadlines.length}>
      <div className="deadlines-head">
        <b>{translate("projects.deadlines")}</b>
        <span className="project-dim">
          {shortDate(timeline.start)} → {shortDate(timeline.end)}
          {timeline.daysLeft > 0 ? ` · ${translate("projects.daysLeft", { count: timeline.daysLeft })}` : ""}
        </span>
        <button type="button" className="text-link deadlines-edit" onClick={onEditAll} data-edit-deadlines>
          {translate("projects.editDeadlines")}
        </button>
        <button type="button" className="text-link deadlines-edit" onClick={() => onEdit(null)} data-add-deadline-axis>
          + {translate("projects.addDeadline")}
        </button>
        <span className="project-header-spacer" />
        {next && (
          <span className="pill is-gold">
            {next.reason === "pinned" ? "📌 " : ""}
            {next.isPhaseEnd
              ? next.daysLeft <= 0
                ? translate("projects.nextEndsToday", { label: next.label })
                : translate("projects.nextEndsIn", { label: next.label, count: next.daysLeft })
              : next.daysLeft <= 0
                ? translate("projects.nextToday", { label: next.label })
                : translate("projects.nextIn", { label: next.label, count: next.daysLeft })}
          </span>
        )}
      </div>
      <div className="deadline-axis" ref={axisRef}>
        <div className="deadline-track" />
        <div className="deadline-elapsed" style={{ width: `${timeline.elapsedFraction * 100}%` }} />
        <div className="deadline-today" style={{ left: `${timeline.elapsedFraction * 100}%` }}>
          <span>{translate("projects.today")}</span>
        </div>
        {keyMarker && (
          <div
            className={`deadline-milestone deadline-key is-lower${keyMarker.at > 0.8 ? " is-end" : ""}`}
            style={{ left: `${keyMarker.at * 100}%` }}
            title={translate("projects.phaseEnds", { label: keyMarker.label, date: shortDate(keyMarker.date) })}
            data-deadline-key={keyMarker.id}
          >
            <span className="deadline-diamond" />
            <span className="deadline-label">
              {keyMarker.reason === "pinned" ? "📌 " : ""}
              {translate("projects.phaseEndsShort", { label: keyMarker.label })} · <b>{shortDate(keyMarker.date)}</b>
            </span>
          </div>
        )}
        {milestones.map((milestone) => (
          <button
            type="button"
            key={milestone.id || milestone.label}
            className={`deadline-milestone is-${milestone.state}${next && next.reason === "pinned" && next.id === milestone.id ? " is-key" : ""}${milestone.row ? " is-lower" : ""}${milestone.at < 0.08 ? " is-start" : ""}${milestone.at > 0.92 ? " is-end" : ""}`}
            style={{ left: `${milestone.at * 100}%` }}
            title={`${milestone.label} · ${shortDate(milestone.date)} — ${translate("projects.editDeadline")}`}
            onClick={() => (milestone.source === "clickup" ? onOpenTask(milestone.taskId, milestone.label) : onEdit(milestone.id))}
            data-deadline-milestone={milestone.id}
          >
            <span className="deadline-diamond" />
            {compactMarkers ? (
              <span className="deadline-label">
                <b>{shortDate(milestone.date)}</b>
              </span>
            ) : (
              <span className="deadline-label">
                {milestone.source === "task" || milestone.source === "clickup" ? "⧉ " : ""}
                {milestone.label} · <b>{shortDate(milestone.date)}</b>
              </span>
            )}
          </button>
        ))}
      </div>
      {compactMarkers && (
        <div className="deadline-legend" data-deadline-legend>
          {milestones.map((milestone) => (
            <button
              type="button"
              key={milestone.id || milestone.label}
              className={`deadline-legend-item is-${milestone.state}`}
              onClick={() => (milestone.source === "clickup" ? onOpenTask(milestone.taskId, milestone.label) : onEdit(milestone.id))}
            >
              <span className="deadline-legend-diamond" />
              <b>{shortDate(milestone.date)}</b> {milestone.label}
            </button>
          ))}
        </div>
      )}
      {lanes.length > 0 && (
        <div className="phase-lanes" data-phase-lanes={lanes.length}>
          {lanes.map((lane, laneIndex) => (
            <div key={laneIndex} className="phase-lane">
              {lane.map((phase) => {
                const insideText = phaseText(phase);
                const placement = phase.placement;
                const isKey = next && next.id === phase.id && next.isPhaseEnd;
                return (
                  <span key={phase.id} className="phase-bar-group">
                    <button
                      type="button"
                      className={`phase-bar is-${phase.state}${isKey ? " is-key" : ""}`}
                      style={{ left: `${phase.startAt * 100}%`, width: `${Math.max((phase.at - phase.startAt) * 100, 0.8)}%` }}
                      title={`${phase.label} · ${shortDate(phase.start)} → ${shortDate(phase.date)}`}
                      onClick={() => (phase.source === "clickup" ? onOpenTask(phase.taskId, phase.label) : onEdit(phase.id))}
                      data-phase={phase.id}
                    >
                      {placement === "inside" && <span className={phase.moreInside ? "phase-bar-label has-more" : "phase-bar-label"}>{insideText}</span>}
                    </button>
                    {placement !== "inside" && (
                      <span
                        className={`phase-bar-outside is-${placement}`}
                        style={placement === "right" ? { left: `calc(${phase.at * 100}% + 26px)` } : { right: `calc(${(1 - phase.startAt) * 100}% + 6px)` }}
                        title={insideText}
                      >
                        {phaseText(phase, true)}
                      </span>
                    )}
                    <button
                      type="button"
                      className="phase-bar-more"
                      style={{ left: phase.moreInside || phase.at > 0.97 ? `calc(${phase.at * 100}% - 20px)` : `calc(${phase.at * 100}% + 3px)` }}
                      title={translate("projects.phaseMenu")}
                      aria-label={translate("projects.phaseMenu")}
                      onClick={(event) => setPhaseMenu({ phase, anchor: event.currentTarget.getBoundingClientRect() })}
                      data-phase-more={phase.id}
                    >
                      …
                    </button>
                  </span>
                );
              })}
            </div>
          ))}
          <div className="phase-today" style={{ left: `${timeline.elapsedFraction * 100}%` }} />
        </div>
      )}
      {phaseMenu && (
        <PopupMenu anchor={phaseMenu.anchor} align="left" onClose={() => setPhaseMenu(null)}>
          <MenuLabel>{phaseMenu.phase.label}</MenuLabel>
          {next && next.reason === "pinned" && next.id === phaseMenu.phase.id ? (
            <MenuItem
              onClick={() => {
                setPhaseMenu(null);
                onPinDeadline(null);
              }}
            >
              {translate("projects.unpinKeyDeadline")}
            </MenuItem>
          ) : (
            <MenuItem
              onClick={() => {
                setPhaseMenu(null);
                onPinDeadline(phaseMenu.phase.id);
              }}
            >
              📌 {translate("projects.pinKeyDeadline")}
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              setPhaseMenu(null);
              onHideDeadline(phaseMenu.phase.id);
            }}
          >
            {translate("projects.hideDeadline")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              setPhaseMenu(null);
              onEditAll();
            }}
          >
            {translate("projects.editDeadlines")}
          </MenuItem>
        </PopupMenu>
      )}
      {(sourceNote || hiddenNote) && (
        <div className="deadline-source project-dim" data-deadline-source>
          {[sourceNote, hiddenNote].filter(Boolean).join(" · ")}
        </div>
      )}
      {pace && (
        <div className="deadline-pace" data-deadline-pace>
          <span className="computed-tag" title={translate("projects.computedHint")}>
            {translate("projects.computed")}
          </span>
          <span className="deadline-pace-text">{translate(pace.key, pace.values)}</span>
          <span className="project-header-spacer" />
          <span className="deadline-today-dots">
            {translate("projects.today")}
            {pace.todayDots.map((closed, index) => (
              <span key={index} className={closed ? "today-dot is-closed" : "today-dot"} />
            ))}
            {translate(pace.todayKey, { count: pace.handedOffToday, target: pace.todayTargetText })}
          </span>
        </div>
      )}
    </section>
  );
}

// ---- numbers (variant A) ------------------------------------------------------

function StatsCards({ snapshot, activeStat, onStat }) {
  const { translate } = useTranslation();
  const stats = snapshot.stats;
  const segments = bucketSegments(stats.buckets);
  const legend = [...BUCKET_ORDER, ...(stats.buckets.other > 0 ? ["other"] : [])];
  const highest = Math.max(...stats.people.map((person) => person.total), 1);
  const burnPoints = burnDownPoints(stats.pace.history, { width: BURN_DOWN_WIDTH, height: BURN_DOWN_HEIGHT });
  const lastPoint = stats.pace.history.length > 0 ? stats.pace.history[stats.pace.history.length - 1] : null;
  return (
    <div className="project-stats">
      <section className="project-card stat-where" data-stats-buckets>
        <h3>
          {translate("projects.whereTasksAre", { count: stats.total })}
          {stats.subtasks > 0 && (
            <span className="where-split" data-where-split>
              {" "}
              {translate("projects.tasksAndSubtasks", { tasks: stats.topLevel, subtasks: stats.subtasks })}
            </span>
          )}
          {snapshot.sources.truncated && snapshot.sources.truncated.buildTasks && (
            <span className="truncated-note" title={translate("projects.truncatedHint")} data-truncated>
              {" "}
              {translate("projects.truncatedNote")}
            </span>
          )}
        </h3>
        <div className="stack-bar">
          {segments.map((segment) => (
            <span key={segment.bucket} style={{ width: `${segment.fraction * 100}%`, background: segment.color }} />
          ))}
        </div>
        <div className="bucket-legend">
          {legend.map((bucket) => (
            <button
              type="button"
              key={bucket}
              className={activeStat && activeStat.kind === "bucket" && activeStat.bucket === bucket ? "bucket-legend-item is-active" : "bucket-legend-item"}
              onClick={() => onStat({ kind: "bucket", bucket })}
              title={translate("projects.statClickHint")}
              data-stat-bucket={bucket}
            >
              <span className="dot" style={{ background: BUCKET_COLORS[bucket] }} />
              <b>{stats.buckets[bucket] || 0}</b>
              <span>{translate(`projects.bucket.${bucket}`)}</span>
            </button>
          ))}
        </div>
        <div className="stat-bottom">
          <div className="burn-down" data-my-queue>
            <button type="button" className="burn-down-number" onClick={() => onStat({ kind: "perspective", perspective: "myQueue" })} data-stat-perspective="myQueue">
              <b>{stats.pace.leftToClose}</b>
              <span>{translate("projects.myQueue")}</span>
            </button>
            {burnPoints && (
              <svg className="burn-down-line" width={BURN_DOWN_WIDTH} height={BURN_DOWN_HEIGHT} viewBox={`0 0 ${BURN_DOWN_WIDTH} ${BURN_DOWN_HEIGHT}`} aria-hidden="true">
                <polyline points={burnPoints} />
                {lastPoint && <circle cx={BURN_DOWN_WIDTH} cy={burnPoints.split(" ").pop().split(",")[1]} r="2.5" />}
              </svg>
            )}
            <div className="burn-down-pace">
              {stats.pace.neededPerWeek !== null && (
                <span>{translate("projects.neededPerWeek", { count: stats.pace.neededPerWeek })}</span>
              )}
              <span className="is-actual">{translate("projects.actualPerWeek", { count: stats.pace.actualPerWeek })}</span>
            </div>
            <div className="queue-others">
              <button type="button" className="stat-counter" onClick={() => onStat({ kind: "perspective", perspective: "waiting" })} data-stat-perspective="waiting">
                <b>{stats.waiting || 0}</b>
                {translate("projects.waitingOnOthers")}
              </button>
              <button type="button" className="stat-counter" onClick={() => onStat({ kind: "perspective", perspective: "closed" })} data-stat-perspective="closed">
                <b>{stats.closed || 0}</b>
                {translate("projects.perspective.closed")}
              </button>
            </div>
          </div>
          <div className="stat-counters" data-stats-counters>
            {snapshot.mode !== "git" && (
              <>
                <button type="button" className="stat-counter" onClick={() => onStat({ kind: "specsToWrite" })} data-stat-counter="specsToWrite">
                  <b>{stats.specsToWrite}</b>
                  {translate("projects.specsToWrite")}
                </button>
                <button type="button" className="stat-counter is-gold" onClick={() => onStat({ kind: "specsInReview" })} data-stat-counter="specsInReview">
                  <b>{stats.specsInReview}</b>
                  {translate("projects.specsInReview")}
                </button>
              </>
            )}
            <button type="button" className={stats.redPullRequests > 0 ? "stat-counter is-coral" : "stat-counter"} onClick={() => onStat({ kind: "redCi" })} data-stat-counter="redCi">
              <b>{stats.redPullRequests}</b>
              {translate("projects.redCi")}
            </button>
          </div>
        </div>
      </section>
      <section className="project-card stat-people" data-stats-people>
        <h3>{translate("projects.whoHasWhat")}</h3>
        <div className="people-list">
          {stats.people.length === 0 && <span className="project-dim">{translate("projects.nobodyHasAnything")}</span>}
          {stats.people.slice(0, 7).map((person) => (
            <button
              type="button"
              key={person.id || "nobody"}
              className={activeStat && activeStat.kind === "person" && activeStat.personId === (person.isNobody ? null : person.id) ? "person-row is-active" : "person-row"}
              onClick={() =>
                onStat({
                  kind: "person",
                  personId: person.isNobody ? null : person.id,
                  name: person.isUser ? translate("projects.me") : person.isNobody ? translate("projects.nobody") : person.name
                })
              }
              title={translate("projects.statClickHint")}
              data-stat-person={person.id || "nobody"}
            >
              <span
                className={person.isNobody ? "person-avatar is-nobody" : "person-avatar"}
                style={person.isNobody ? undefined : { background: person.isUser ? "var(--accent)" : person.color || "var(--project-color-2)" }}
              >
                {person.isNobody ? "–" : person.initials}
              </span>
              <span className="person-name">
                {person.isUser ? translate("projects.me") : person.isNobody ? translate("projects.nobody") : person.name}
              </span>
              <span className="person-bar" style={{ width: `${Math.max((person.total / highest) * 100, 6)}%` }}>
                {bucketSegments(person.byBucket).map((segment) => (
                  <span key={segment.bucket} style={{ width: `${segment.fraction * 100}%`, background: segment.color }} />
                ))}
              </span>
              <span className="person-count">{person.total}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---- task cards (variant A) ----------------------------------------------------

function CardList({
  snapshot,
  filter,
  statCards = null,
  stat = null,
  now,
  language,
  expandedCardId,
  onToggle,
  showNotStarted,
  onShowNotStarted,
  pullRequestsAvailable,
  onOpenTask,
  onOpenExternal,
  onSelectSession,
  sessions,
  agents,
  repositories,
  actions,
  query
}) {
  const { translate } = useTranslation();
  const listed = statCards ? { cards: statCards, notStarted: [] } : cardsForFilter(snapshot, filter);
  // A search looks through the folded "nobody started" cards too.
  const searching = Boolean(String(query || "").trim());
  const cards = searchCards(listed.cards, query);
  const notStarted = searchCards(listed.notStarted, query);
  const visible = showNotStarted || searching ? [...cards, ...notStarted] : cards;
  const upNextIds = (snapshot.filters && snapshot.filters.upNext) || [];
  const cardProps = {
    now,
    language,
    pullRequestsAvailable,
    onOpenTask,
    onOpenExternal,
    onSelectSession,
    sessions,
    agents,
    repositories,
    actions,
    upNextIds,
    inUpNext: filter === "upNext",
    query,
    stat
  };
  return (
    <div className="task-list" data-task-list={filter}>
      {visible.length === 0 && (
        <div className="project-banner is-quiet">
          {translate(searching ? "projects.searchNoCards" : filter === "upNext" ? "projects.upNextEmpty" : "projects.filterEmpty")}
        </div>
      )}
      {visible.map((card) => (
        <TaskCard key={card.id} card={card} expanded={expandedCardId === card.id} onToggle={() => onToggle(card.id)} {...cardProps} />
      ))}
      {notStarted.length > 0 && !showNotStarted && !searching && (
        <button type="button" className="more-row" onClick={onShowNotStarted} data-show-not-started>
          {translate("projects.notStartedHidden", { count: notStarted.length })}
        </button>
      )}
    </div>
  );
}

function StatusPill({ card }) {
  const color = card.kind === "build" ? BUCKET_COLORS[card.bucket] || BUCKET_COLORS.other : "var(--mauve)";
  return (
    <span className="task-status" style={{ "--status-color": color }}>
      {card.status || "—"}
    </span>
  );
}

function Pipeline({ label, stage, emptyText }) {
  const { translate } = useTranslation();
  const dots = pipelineDots(stage);
  return (
    <div className="pipeline-row">
      <span className="pipeline-label">{label}</span>
      {dots.length === 0 || stage.index < 0 ? (
        <span className="pipeline-empty">{emptyText}</span>
      ) : (
        <span className="pipeline-steps">
          {dots.map((dot) => (
            <span
              key={dot.step}
              className={`pipeline-step is-${dot.state}${dot.others ? " is-others" : ""}${dot.handOff ? " is-hand-off" : ""}`}
              title={dot.handOff ? translate("projects.handOffHint") : dot.others ? translate("projects.othersHint") : undefined}
            >
              <span className="pipeline-node" />
              <span className="pipeline-caption">{translate(`projects.step.${dot.step}`)}</span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function SessionChip({ session, role, now, onSelectSession }) {
  const { translate } = useTranslation();
  const label = sessionStateLabel(session, now);
  return (
    <button
      type="button"
      className="link-chip"
      title={translate("projects.openSessionHint")}
      onClick={() => onSelectSession(session.sessionId)}
      data-session-chip={session.sessionId}
    >
      <span className={`chip-dot is-${sessionTone(session)}`} />
      <span className="chip-emoji">{session.agentEmoji || ROLE_EMOJI[role] || ROLE_EMOJI.other}</span>
      <b>{session.title}</b>
      <span>{translate(label.key, label.values)}</span>
    </button>
  );
}

function LinkChips({ card, now, pullRequestsAvailable, onOpenTask, onOpenExternal, onSelectSession }) {
  const { translate } = useTranslation();
  return (
    <div className="task-links">
      {cardLinks(card, { pullRequestsAvailable }).map((link, index) => {
        const key = `${link.kind}-${index}`;
        if (link.kind === "clickup") {
          return (
            <span key={key} className="link-chip is-split">
              <button type="button" onClick={() => onOpenTask(link.taskId, card.name)} title={translate("projects.openTaskHint")} data-clickup-chip={link.taskId}>
                <ClickupMark />
                <b className="mono">{link.label}</b>
              </button>
              <button type="button" className="link-chip-external" onClick={() => onOpenExternal(link.url)} title={translate("projects.openInClickup")}>
                ↗
              </button>
            </span>
          );
        }
        if (link.kind === "spec") {
          return (
            <button type="button" key={key} className="link-chip" onClick={() => onOpenExternal(link.url)} title={link.url} data-spec-chip>
              <ClickupMark />
              <span>📋 {translate("projects.specChip", { name: link.label })}</span>
            </button>
          );
        }
        if (link.kind === "planning") {
          return (
            <button type="button" key={key} className="link-chip" onClick={() => onOpenTask(link.taskId, link.label)} data-planning-chip>
              <ClickupMark />
              <span>{translate("projects.planningChip", { name: link.label })}</span>
            </button>
          );
        }
        if (link.kind === "session") {
          return <SessionChip key={key} session={link.session} role={link.role} now={now} onSelectSession={onSelectSession} />;
        }
        if (link.kind === "branch") {
          const details = [];
          if (typeof link.ahead === "number" && link.ahead > 0) {
            details.push(`+${link.ahead}`);
          }
          if (link.uncommitted) {
            details.push(translate("projects.uncommitted"));
          }
          if (link.inStaging) {
            details.push(translate("projects.inStaging"));
          }
          return (
            <span key={key} className="link-chip is-static" title={translate("projects.branchHint")} data-branch-chip>
              <span className="chip-glyph">⎇</span>
              <span className="mono">{link.name}</span>
              <span>
                {link.repository}
                {details.length > 0 ? ` ${details.join(" · ")}` : ""}
              </span>
            </span>
          );
        }
        if (link.kind === "pullRequest") {
          return (
            <button type="button" key={key} className={`link-chip is-ci-${link.ci}`} onClick={() => onOpenExternal(link.url)} data-pull-request-chip>
              <span className="chip-glyph">⇅</span>
              <b>PR #{link.number}</b>
              <span>{translate(`projects.pullRequestState.${link.state}`)}</span>
              {link.ci !== "none" && <span className="chip-ci">{translate(`projects.ci.${link.ci}`)}</span>}
            </button>
          );
        }
        return (
          <span key={key} className="link-chip is-missing">
            {translate(`projects.missing.${link.reason}`)}
          </span>
        );
      })}
    </div>
  );
}

function TaskCard({
  card,
  expanded,
  onToggle,
  now,
  language,
  pullRequestsAvailable,
  onOpenTask,
  onOpenExternal,
  onSelectSession,
  sessions,
  agents,
  repositories,
  actions,
  upNextIds,
  inUpNext,
  query,
  stat
}) {
  const { translate } = useTranslation();
  const needs = needsLabel(card.needs);
  const specStepName = card.spec && card.spec.steps ? card.spec.steps[card.spec.index] : null;
  return (
    <article
      className={expanded ? "task-card is-open" : "task-card"}
      data-task-card={card.id}
      onClick={(event) => {
        if (!event.target.closest("button, a, input, .subtask-block")) {
          onToggle();
        }
      }}
    >
      <div className="task-card-main">
        <div className="task-card-title">
          <span className={card.kind === "build" ? "kind-tag is-build" : "kind-tag is-spec"}>
            {translate(card.source === "git" ? "projects.kindBranch" : card.kind === "build" ? "projects.kindBuild" : "projects.kindSpec")}
          </span>
          <span className="task-card-name">{card.name}</span>
        </div>
        <CardMenu card={card} sessions={sessions} agents={agents} repositories={repositories} actions={actions} upNextIds={upNextIds} inUpNext={inUpNext} />
        <div className="task-card-pills">
          {card.upNext && <span className="up-next-mark" title={translate("projects.filter.upNext")}>📌</span>}
          <StatusPill card={card} />
          {card.perspective && (
            <span className={`perspective-tag is-${card.perspective}`} data-card-perspective={card.perspective}>
              {translate(`projects.perspective.${card.perspective}`)}
            </span>
          )}
          {card.developerStatus && (
            <span className="source-chip developer-status" title={card.developerStatusField || ""} data-developer-status>
              {card.developerStatusField}: {card.developerStatus}
            </span>
          )}
          {needs && (
            <span className="needs-pill" title={needs.subtaskName || undefined}>
              ● {translate(needs.key, needs.values)}
              {needs.subtaskName && <span className="needs-subtask">{translate("projects.needsInSubtask", { name: needs.subtaskName })}</span>}
            </span>
          )}
        </div>
      </div>
      <div className="task-card-pipelines">
        {card.source !== "git" && <Pipeline label={translate("projects.pipelineSpec")} stage={card.spec} emptyText="" />}
        {card.kind === "build" ? (
          <Pipeline
            label={translate("projects.pipelineBuild")}
            stage={card.build}
            emptyText={translate(specStepName === "approved" ? "projects.buildNotStarted" : "projects.buildAfterSpec")}
          />
        ) : (
          <Pipeline label={translate("projects.pipelineBuild")} stage={{ steps: [], index: -1 }} emptyText={translate("projects.buildAfterSpec")} />
        )}
      </div>
      <LinkChips
        card={card}
        now={now}
        pullRequestsAvailable={pullRequestsAvailable}
        onOpenTask={onOpenTask}
        onOpenExternal={onOpenExternal}
        onSelectSession={onSelectSession}
      />
      {(card.subtasks || []).length > 0 && (
        <SubtaskBlock card={card} now={now} query={query} stat={stat} onOpenTask={onOpenTask} onOpenExternal={onOpenExternal} onSelectSession={onSelectSession} />
      )}
      {expanded && <TaskDetails card={card} now={now} language={language} onSelectSession={onSelectSession} />}
    </article>
  );
}

// A card's subtasks: one line with how many there are and where they stand
// for the user, which opens the list — every subtask at every level, with
// its status, developer status, assignees, and its own CU- task, branches
// and sessions. Closed by default; open when a search or a number on top
// matched one of them (those rows are marked).
function SubtaskBlock({ card, now, query, stat, onOpenTask, onOpenExternal, onSelectSession }) {
  const { translate } = useTranslation();
  const [chosen, setChosen] = useState(null);
  const searching = Boolean(String(query || "").trim());
  const matched = new Set(
    card.subtasks
      .filter((subtask) => (searching && subtaskMatchesQuery(subtask, query)) || (stat && subtaskMatchesStat(subtask, stat)))
      .map((subtask) => subtask.id)
  );
  const open = chosen === null ? matched.size > 0 : chosen;
  const parts = subtaskSummaryParts(card);
  const toneOf = { "projects.subtasksInQueue": "is-myQueue", "projects.subtasksWaiting": "is-waiting", "projects.subtasksClosed": "is-closed" };
  return (
    <div className={open ? "subtask-block is-open" : "subtask-block"} data-subtasks={card.id}>
      <button type="button" className="subtask-summary" aria-expanded={open} onClick={() => setChosen(!open)} data-subtask-toggle>
        <span className="subtask-caret" aria-hidden="true">
          ▸
        </span>
        {parts.map((part, index) => (
          <span key={part.key} className={index === 0 ? "subtask-part is-total" : `subtask-part ${toneOf[part.key] || ""}`}>
            {index > 0 && <span className="subtask-dot" aria-hidden="true" />}
            {translate(part.key, part.values)}
          </span>
        ))}
      </button>
      {open && (
        <ul className="subtask-list" data-subtask-list={card.id}>
          {card.subtasks.map((subtask) => (
            <SubtaskRow
              key={subtask.id}
              subtask={subtask}
              matched={matched.has(subtask.id)}
              now={now}
              onOpenTask={onOpenTask}
              onOpenExternal={onOpenExternal}
              onSelectSession={onSelectSession}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubtaskRow({ subtask, matched, now, onOpenTask, onOpenExternal, onSelectSession }) {
  const { translate } = useTranslation();
  const needs = needsLabel(subtask.needs);
  const color = BUCKET_COLORS[subtask.bucket] || BUCKET_COLORS.other;
  const pullRequest = (subtask.pullRequests || [])[0] || null;
  return (
    <li
      className={`subtask-row is-${subtask.perspective || "myQueue"}${matched ? " is-match" : ""}`}
      style={{ "--subtask-depth": Math.max(subtask.depth - 1, 0) }}
      data-subtask={subtask.id}
    >
      <span className="subtask-name" title={subtask.depth > 1 && subtask.parentTitle ? translate("projects.subtaskOf", { name: subtask.parentTitle }) : subtask.name}>
        {subtask.depth > 1 && (
          <span className="subtask-branch-mark" aria-hidden="true">
            ↳
          </span>
        )}
        {subtask.name}
      </span>
      <span className="subtask-facts">
        <span className="task-status is-small" style={{ "--status-color": color }}>
          {subtask.status || "—"}
        </span>
        {subtask.developerStatus && (
          <span className="source-chip developer-status is-small" data-subtask-developer-status>
            {subtask.developerStatus}
          </span>
        )}
        {needs && <span className="needs-pill is-small">● {translate(needs.key, needs.values)}</span>}
        <span className="subtask-people">
          {(subtask.assignees || []).length === 0 ? (
            <span className="person-avatar is-nobody is-small" title={translate("projects.nobody")}>
              –
            </span>
          ) : (
            subtask.assignees.slice(0, 3).map((person) => (
              <span
                key={person.id || person.name}
                className="person-avatar is-small"
                style={{ background: subtask.assignedToUser && person.id ? "var(--accent)" : person.color || "var(--project-color-2)" }}
                title={person.name}
              >
                {person.initials}
              </span>
            ))
          )}
        </span>
        <span className="link-chip is-split is-small">
          <button type="button" onClick={() => onOpenTask(subtask.id, subtask.name)} title={translate("projects.openTaskHint")} data-clickup-chip={subtask.id}>
            <b className="mono">CU-{subtask.id}</b>
          </button>
          <button type="button" className="link-chip-external" onClick={() => onOpenExternal(subtask.url)} title={translate("projects.openInClickup")}>
            ↗
          </button>
        </span>
        {(subtask.branches || []).map((branch) => (
          <span key={`${branch.repository}-${branch.name}`} className="link-chip is-static is-small" title={translate("projects.branchHint")} data-branch-chip>
            <span className="chip-glyph">⎇</span>
            <span className="mono">{branch.name}</span>
            <span>{branch.repository}</span>
          </span>
        ))}
        {pullRequest && (
          <button type="button" className={`link-chip is-small is-ci-${pullRequest.ci}`} onClick={() => onOpenExternal(pullRequest.url)} data-pull-request-chip>
            <span className="chip-glyph">⇅</span>
            <b>PR #{pullRequest.number}</b>
          </button>
        )}
        {(subtask.sessions || []).map((session) => (
          <SessionChip key={session.sessionId} session={session} role={session.role} now={now} onSelectSession={onSelectSession} />
        ))}
      </span>
    </li>
  );
}

// The agent that fits a card: a spec card wants the agent whose role is
// spec, a build card the builder (by the agent's name, or the role the
// project gave it). None fitting means a plain session.
function agentForCard(card, agents) {
  const wanted = card.kind === "spec" ? "spec" : "build";
  return (agents || []).find((agent) => new RegExp(wanted, "i").test(agent.name || "")) || null;
}

// "…" on a card: Up next, the links made by hand, and starting a session
// for the task. Only project-boards.json changes (and a terminal opens).
function CardMenu({ card, sessions, agents, repositories, actions, upNextIds, inUpNext }) {
  const { translate } = useTranslation();
  const [anchor, setAnchor] = useState(null);
  const buttonRef = useRef(null);
  const close = () => setAnchor(null);
  const linkedIds = new Set(card.sessions.map((session) => session.sessionId));
  const recent = [...(sessions || [])]
    .filter((session) => !linkedIds.has(session.sessionId))
    .sort((first, second) => (second.lastModified || 0) - (first.lastModified || 0))
    .slice(0, SESSIONS_IN_LINK_MENU);
  const agent = agentForCard(card, agents);
  const place = upNextIds.indexOf(card.id);
  const usableRepositories = (repositories || []).filter((repository) => repository.localPath);
  return (
    <>
      <button
        type="button"
        className="row-menu-button task-card-menu"
        ref={buttonRef}
        title={translate("projects.cardMenu")}
        aria-label={translate("projects.cardMenu")}
        onClick={() => setAnchor(buttonRef.current.getBoundingClientRect())}
        data-card-menu={card.id}
      >
        <DotsIcon />
      </button>
      {anchor && (
        <PopupMenu anchor={anchor} onClose={close}>
          {card.upNext ? (
            <MenuItem marker="unpin" onClick={() => { close(); actions.unpin(card); }}>
              {translate("projects.unpin")}
            </MenuItem>
          ) : (
            <MenuItem marker="pin" onClick={() => { close(); actions.pin(card); }}>
              {translate("projects.pin")}
            </MenuItem>
          )}
          {inUpNext && place > 0 && (
            <MenuItem marker="move-up" onClick={() => { close(); actions.move(card, -1); }}>
              {translate("projectSettings.moveUp")}
            </MenuItem>
          )}
          {inUpNext && place >= 0 && place < upNextIds.length - 1 && (
            <MenuItem marker="move-down" onClick={() => { close(); actions.move(card, 1); }}>
              {translate("projectSettings.moveDown")}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuSubmenu label={translate("projects.linkSession")} marker="link-session">
            {recent.length === 0 && <MenuLabel>{translate("projects.noSessionsToLink")}</MenuLabel>}
            {recent.map((session) => (
              <MenuItem key={session.sessionId} marker={`link-${session.sessionId}`} onClick={() => { close(); actions.link(card, session.sessionId); }}>
                {session.title}
              </MenuItem>
            ))}
          </MenuSubmenu>
          {card.sessions.map((session) => (
            <MenuItem key={session.sessionId} marker={`unlink-${session.sessionId}`} onClick={() => { close(); actions.unlink(card, session.sessionId); }}>
              {translate("projects.unlinkSession", { name: session.title })}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuSubmenu label={translate("projects.startSession")} marker="start-session">
            {usableRepositories.length === 0 && <MenuLabel>{translate("projects.noRepositoryToStart")}</MenuLabel>}
            {usableRepositories.map((repository) => (
              <MenuItem key={`agent-${repository.name}`} marker={`start-${repository.name}`} onClick={() => { close(); actions.start(card, repository, agent); }}>
                {agent
                  ? translate("projects.startInWithAgent", { repository: repository.name, agent: agent.name })
                  : translate("projects.startIn", { repository: repository.name })}
              </MenuItem>
            ))}
            {agent &&
              usableRepositories.map((repository) => (
                <MenuItem key={`plain-${repository.name}`} marker={`start-plain-${repository.name}`} onClick={() => { close(); actions.start(card, repository, null); }}>
                  {translate("projects.startInPlain", { repository: repository.name })}
                </MenuItem>
              ))}
          </MenuSubmenu>
        </PopupMenu>
      )}
    </>
  );
}

// ---- details inline (variant A) ---------------------------------------------------

function TaskDetails({ card, now, language, onSelectSession }) {
  const { translate } = useTranslation();
  const shortDate = useShortDate(language);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);

  // The comments are not in the list answer; they are read (GET only) when
  // the card is opened.
  useEffect(() => {
    // A branch of a project without ClickUp has nothing more to read.
    if (card.source === "git") {
      setDetail({ task: null, comments: [] });
      return undefined;
    }
    let canceled = false;
    window.clauding
      .getBoardTaskDetail(card.id)
      .then((answer) => {
        if (!canceled) {
          setDetail(answer || { task: null, comments: [] });
        }
      })
      .catch((error) => {
        if (!canceled) {
          setDetailError(cleanErrorMessage(error));
        }
      });
    return () => {
      canceled = true;
    };
  }, [card.id, card.source]);

  const description = card.description || (detail && detail.task ? detail.task.description : "");
  const commentsText = detail
    ? translate("projects.commentsCount", { count: detail.comments.length })
    : detailError
      ? translate("projects.commentsUnavailable")
      : translate("projects.commentsLoading");
  return (
    <div className="task-details" data-task-details={card.id}>
      <div className="detail-box is-wide">
        <h5>{translate("projects.detailsTask")}</h5>
        <div className="detail-fields">
          <span className="detail-key">{translate("projects.assignee")}</span>
          <span>{card.assignees.length > 0 ? card.assignees.map((person) => person.name).join(", ") : translate("projects.nobody")}</span>
          <span className="detail-key">{translate("projects.due")}</span>
          <span>{card.dueDate ? shortDate(card.dueDate) : "—"}</span>
          {(card.fields || []).map((field) => (
            <FieldRow key={field.name} field={field} />
          ))}
          {card.source !== "git" && (
            <>
              <span className="detail-key">{translate("projects.comments")}</span>
              <span>{commentsText}</span>
            </>
          )}
        </div>
        {description ? <p className="detail-description">{description}</p> : <p className="project-dim">{translate("projects.noDescription")}</p>}
      </div>
      <div className="detail-box">
        <h5>{translate("projects.detailsSessions")}</h5>
        {card.sessions.length === 0 && <p className="project-dim">{translate("projects.noSessionsLinked")}</p>}
        {card.sessions.map((session) => {
          const label = sessionStateLabel(session, now);
          return (
            <button type="button" key={session.sessionId} className="detail-row" onClick={() => onSelectSession(session.sessionId)}>
              <span className={`chip-dot is-${sessionTone(session)}`} />
              <span className="chip-emoji">{session.agentEmoji || ROLE_EMOJI[session.role] || ROLE_EMOJI.other}</span>
              <b>{session.title}</b>
              <span className="project-dim">{translate(`projects.role.${session.role}`)}</span>
              <span className="detail-when">{translate(label.key, label.values)}</span>
            </button>
          );
        })}
      </div>
      <div className="detail-box">
        <h5>{translate("projects.detailsCode")}</h5>
        {card.branches.length === 0 && card.pullRequests.length === 0 && <p className="project-dim">{translate("projects.noBranches")}</p>}
        {card.branches.map((branch) => (
          <div key={`${branch.repository}-${branch.name}`} className="detail-row is-static">
            <span className="chip-glyph">⎇</span>
            <span className="mono">
              {branch.repository} · {branch.name}
            </span>
            <span className="detail-when">
              {[
                typeof branch.aheadOfBase === "number" ? translate("projects.aheadCount", { count: branch.aheadOfBase }) : null,
                branch.worktreePath ? translate("projects.worktree") : null,
                branch.uncommitted ? translate("projects.uncommitted") : null,
                branch.pushed ? null : translate("projects.notPushed"),
                branch.inStaging ? translate("projects.inStaging") : null
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        ))}
        {card.pullRequests.map((pull) => (
          <div key={`${pull.repository}-${pull.number}`} className="detail-row is-static">
            <span className="chip-glyph">⇅</span>
            <span>
              {pull.repository} · PR #{pull.number} {translate(`projects.pullRequestState.${pull.state}`)}
            </span>
            {pull.ci !== "none" && <span className={`detail-when is-ci-${pull.ci}`}>{translate(`projects.ci.${pull.ci}`)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function FieldRow({ field }) {
  const isLink = /^https?:\/\//.test(field.value);
  return (
    <>
      <span className="detail-key">{field.name}</span>
      <span className="detail-value" title={field.value}>
        {isLink ? field.value.replace(/^https?:\/\//, "") : field.value}
      </span>
    </>
  );
}

// ---- spec pipeline (variant C) --------------------------------------------------------

function SpecPipeline({ snapshot, stage, onStage, now, onOpenTask, onSelectSession, query }) {
  const { translate } = useTranslation();
  const current = snapshot.specPipeline.find((entry) => entry.stage === stage) || snapshot.specPipeline[0];
  const wanted = String(query || "").trim().toLowerCase();
  const items = wanted ? current.items.filter((item) => item.name.toLowerCase().includes(wanted) || item.id.includes(wanted)) : current.items;
  return (
    <div className="spec-pipeline" data-spec-pipeline={current.stage}>
      <div className="spec-funnel">
        {snapshot.specPipeline.map((entry) => (
          <button
            type="button"
            key={entry.stage}
            className={entry.stage === current.stage ? "spec-funnel-stage is-active" : "spec-funnel-stage"}
            onClick={() => onStage(entry.stage)}
            data-spec-stage={entry.stage}
          >
            <b>{entry.count}</b>
            {translate(`projects.specStage.${entry.stage}`)}
          </button>
        ))}
      </div>
      <div className="stage-head">
        {translate(`projects.specStage.${current.stage}`)} · {translate("projects.stageCount", { count: current.count })}
        {snapshot.sources.truncated && snapshot.sources.truncated.planningTasks && (
          <span className="truncated-note" title={translate("projects.truncatedHint")}> {translate("projects.truncatedNote")}</span>
        )}
      </div>
      {items.length === 0 && <div className="project-banner is-quiet">{translate(wanted ? "projects.searchNoCards" : "projects.stageEmpty")}</div>}
      {items.map((item) => (
        <div key={item.id} className="spec-row" data-spec-row={item.id}>
          <ClickupMark />
          <button type="button" className="spec-row-name" onClick={() => onOpenTask(item.id, item.name)} title={translate("projects.openTaskHint")}>
            {item.name}
          </button>
          <span className="spec-row-sessions">
            {item.sessions.map((session) => (
              <SessionChip key={session.sessionId} session={session} role="spec" now={now} onSelectSession={onSelectSession} />
            ))}
          </span>
          <span className="project-header-spacer" />
          {item.needs ? (
            <span className="needs-pill">{translate("projects.yourApproval")}</span>
          ) : item.buildStatus ? (
            <span className="source-chip">{translate("projects.buildStatus", { status: item.buildStatus })}</span>
          ) : (
            <span className="source-chip is-muted">{item.status}</span>
          )}
        </div>
      ))}
    </div>
  );
}
