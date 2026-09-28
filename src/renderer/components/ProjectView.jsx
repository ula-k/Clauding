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
  dailyPaceText,
  defaultSpecStage,
  filterChips,
  needsLabel,
  pipelineDots,
  sessionStateLabel,
  sessionTone,
  sourceState
} from "../projectsView.js";

// The middle column while a project is selected in the Projects tab. It
// replaces the terminal only on screen: MiddleColumn keeps the terminal
// stack mounted underneath, so nothing running is closed or re-drawn.
//
// Top to bottom: the header (name, where the data comes from, Refresh),
// the deadline axis with the computed "per day" line, the numbers, the
// filter chips, and the task cards — or, under "Specs pipeline", the stage
// counters with the list of one stage. Everything is read-only: the only
// things a click changes are what this view shows, the side panel (the
// app's own ClickUp task view) and which session is on screen.

const AUTO_REFRESH_MILLISECONDS = 5 * 60 * 1000;
const ROLE_EMOJI = { spec: "✍️", builder: "🔨", other: "💬" };
const BURN_DOWN_WIDTH = 150;
const BURN_DOWN_HEIGHT = 36;

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
  windowTools
}) {
  const { translate, language } = useTranslation();
  const [snapshot, setSnapshot] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("focus");
  const [expandedCardId, setExpandedCardId] = useState(null);
  const [specStage, setSpecStage] = useState(null);
  const [showNotStarted, setShowNotStarted] = useState(false);
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
    load();
    // Every five minutes while the view is open; the main process only
    // asks ClickUp again when its cache is older than that.
    const timer = setInterval(() => load(), AUTO_REFRESH_MILLISECONDS);
    return () => clearInterval(timer);
  }, [boardId, load]);

  function chooseFilter(filterId) {
    setFilter(filterId);
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
            <DeadlineCard snapshot={snapshot} now={now} language={language} />
            {snapshot.cards.length > 0 && <StatsCards snapshot={snapshot} />}
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
                  {filter !== "specs" && filter !== "upNext" && <span className="project-sorted">{translate("projects.sortedNeedsFirst")}</span>}
                </div>
                {filter === "specs" ? (
                  <SpecPipeline
                    snapshot={snapshot}
                    stage={specStage || defaultSpecStage(snapshot.specPipeline)}
                    onStage={setSpecStage}
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
                  />
                )}
              </>
            )}
          </>
        )}
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
        <span>{state.message}</span>
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

function DeadlineCard({ snapshot, now, language }) {
  const { translate } = useTranslation();
  const shortDate = useShortDate(language);
  const timeline = snapshot.timeline;
  if (!timeline || timeline.deadlines.length === 0) {
    return (
      <section className="project-card deadlines is-empty" data-deadlines="none">
        <b>{translate("projects.deadlines")}</b>
        <span className="project-dim">{translate("projects.noDeadlinesYet")}</span>
      </section>
    );
  }
  const milestones = axisMilestones(timeline);
  const pace = dailyPaceText(snapshot.dailyPace);
  const next = timeline.next;
  return (
    <section className="project-card deadlines" data-deadlines={timeline.deadlines.length}>
      <div className="deadlines-head">
        <b>{translate("projects.deadlines")}</b>
        <span className="project-dim">
          {shortDate(timeline.start)} → {shortDate(timeline.end)}
          {timeline.daysLeft > 0 ? ` · ${translate("projects.daysLeft", { count: timeline.daysLeft })}` : ""}
        </span>
        <span className="project-header-spacer" />
        {next && (
          <span className="pill is-gold">
            {next.daysLeft <= 0
              ? translate("projects.nextToday", { label: next.label })
              : translate("projects.nextIn", { label: next.label, count: next.daysLeft })}
          </span>
        )}
      </div>
      <div className="deadline-axis">
        <div className="deadline-track" />
        <div className="deadline-elapsed" style={{ width: `${timeline.elapsedFraction * 100}%` }} />
        <div className="deadline-today" style={{ left: `${timeline.elapsedFraction * 100}%` }}>
          <span>{translate("projects.today")}</span>
        </div>
        {milestones.map((milestone) => (
          <div
            key={milestone.id || milestone.label}
            className={`deadline-milestone is-${milestone.state}${milestone.row ? " is-lower" : ""}${milestone.at < 0.08 ? " is-start" : ""}${milestone.at > 0.92 ? " is-end" : ""}`}
            style={{ left: `${milestone.at * 100}%` }}
            title={`${milestone.label} · ${shortDate(milestone.date)}`}
          >
            <span className="deadline-diamond" />
            <span className="deadline-label">
              {milestone.label} · <b>{shortDate(milestone.date)}</b>
            </span>
          </div>
        ))}
      </div>
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
            {translate("projects.closedOfTarget", { closed: pace.closedToday, target: pace.todayTarget })}
          </span>
        </div>
      )}
    </section>
  );
}

// ---- numbers (variant A) ------------------------------------------------------

function StatsCards({ snapshot }) {
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
        <h3>{translate("projects.whereTasksAre", { count: stats.total })}</h3>
        <div className="stack-bar">
          {segments.map((segment) => (
            <span key={segment.bucket} style={{ width: `${segment.fraction * 100}%`, background: segment.color }} />
          ))}
        </div>
        <div className="bucket-legend">
          {legend.map((bucket) => (
            <span key={bucket} className="bucket-legend-item">
              <span className="dot" style={{ background: BUCKET_COLORS[bucket] }} />
              <b>{stats.buckets[bucket] || 0}</b>
              <span>{translate(`projects.bucket.${bucket}`)}</span>
            </span>
          ))}
        </div>
        <div className="stat-bottom">
          <div className="burn-down">
            <div className="burn-down-number">
              <b>{stats.pace.leftToClose}</b>
              <span>{translate("projects.leftToClose")}</span>
            </div>
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
          </div>
          <div className="stat-counters" data-stats-counters>
            <span className="stat-counter">
              <b>{stats.specsToWrite}</b>
              {translate("projects.specsToWrite")}
            </span>
            <span className="stat-counter is-gold">
              <b>{stats.specsInReview}</b>
              {translate("projects.specsInReview")}
            </span>
            <span className={stats.redPullRequests > 0 ? "stat-counter is-coral" : "stat-counter"}>
              <b>{stats.redPullRequests}</b>
              {translate("projects.redCi")}
            </span>
          </div>
        </div>
      </section>
      <section className="project-card stat-people" data-stats-people>
        <h3>{translate("projects.whoHasWhat")}</h3>
        <div className="people-list">
          {stats.people.length === 0 && <span className="project-dim">{translate("projects.nobodyHasAnything")}</span>}
          {stats.people.slice(0, 7).map((person) => (
            <div key={person.id || "nobody"} className="person-row">
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
            </div>
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
  now,
  language,
  expandedCardId,
  onToggle,
  showNotStarted,
  onShowNotStarted,
  pullRequestsAvailable,
  onOpenTask,
  onOpenExternal,
  onSelectSession
}) {
  const { translate } = useTranslation();
  const { cards, notStarted } = cardsForFilter(snapshot, filter);
  const visible = showNotStarted ? [...cards, ...notStarted] : cards;
  const cardProps = { now, language, pullRequestsAvailable, onOpenTask, onOpenExternal, onSelectSession };
  return (
    <div className="task-list" data-task-list={filter}>
      {visible.length === 0 && (
        <div className="project-banner is-quiet">{translate(filter === "upNext" ? "projects.upNextEmpty" : "projects.filterEmpty")}</div>
      )}
      {visible.map((card) => (
        <TaskCard key={card.id} card={card} expanded={expandedCardId === card.id} onToggle={() => onToggle(card.id)} {...cardProps} />
      ))}
      {notStarted.length > 0 && !showNotStarted && (
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
            <span key={dot.step} className={`pipeline-step is-${dot.state}`}>
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

function TaskCard({ card, expanded, onToggle, now, language, pullRequestsAvailable, onOpenTask, onOpenExternal, onSelectSession }) {
  const { translate } = useTranslation();
  const needs = needsLabel(card.needs);
  const specStepName = card.spec && card.spec.steps ? card.spec.steps[card.spec.index] : null;
  return (
    <article
      className={expanded ? "task-card is-open" : "task-card"}
      data-task-card={card.id}
      onClick={(event) => {
        if (!event.target.closest("button, a, input")) {
          onToggle();
        }
      }}
    >
      <div className="task-card-main">
        <div className="task-card-title">
          <span className={card.kind === "build" ? "kind-tag is-build" : "kind-tag is-spec"}>
            {translate(card.kind === "build" ? "projects.kindBuild" : "projects.kindSpec")}
          </span>
          <span className="task-card-name">{card.name}</span>
        </div>
        <div className="task-card-pills">
          <StatusPill card={card} />
          {needs && <span className="needs-pill">● {translate(needs.key, needs.values)}</span>}
          {card.subtaskCount > 0 && <span className="project-dim">{translate(card.subtaskCount === 1 ? "projects.subtaskOne" : "projects.subtasks", { count: card.subtaskCount })}</span>}
        </div>
      </div>
      <div className="task-card-pipelines">
        <Pipeline label={translate("projects.pipelineSpec")} stage={card.spec} emptyText="" />
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
      {expanded && <TaskDetails card={card} now={now} language={language} onSelectSession={onSelectSession} />}
    </article>
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
  }, [card.id]);

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
          <span className="detail-key">{translate("projects.comments")}</span>
          <span>{commentsText}</span>
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

function SpecPipeline({ snapshot, stage, onStage, now, onOpenTask, onSelectSession }) {
  const { translate } = useTranslation();
  const current = snapshot.specPipeline.find((entry) => entry.stage === stage) || snapshot.specPipeline[0];
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
      </div>
      {current.items.length === 0 && <div className="project-banner is-quiet">{translate("projects.stageEmpty")}</div>}
      {current.items.map((item) => (
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
