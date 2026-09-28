import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { BUCKET_ORDER, SPEC_STAGE_ORDER, dateInputToTime, moveInList, timeToDateInput } from "../projectsView.js";

// Project settings (one sheet per project, from the gear in the project
// header or Projects → Project Settings… in the menu bar). Everything here
// is saved to project-boards.json only; ClickUp, git and GitHub are read,
// never written.
//
// Sections, top to bottom: the project itself (name, group, color), the
// ClickUp lists (picked from the workspace tree) and the field that holds a
// spec link, the repositories with their base and staging branches, who
// "me" is in ClickUp, the deadlines, what My focus shows, Up next, the
// status map (the real status names read from ClickUp), which agent writes
// specs and which builds, the session links made by hand — and removing the
// project, which asks first.

export const SETTINGS_SECTIONS = ["general", "clickup", "repositories", "people", "deadlines", "focus", "upNext", "statuses", "developer", "roles", "links", "remove"];
const PERSPECTIVES = ["myQueue", "waiting", "closed"];
const COLOR_COUNT = 10;
const FOCUS_RULES = ["myQueue", "needsMe", "recentSession", "upNext", "everythingOpen"];
const ROLES = ["spec", "builder", "other"];
const AUTOMATIC = "";

function cleanErrorMessage(error) {
  return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function newIdentifier() {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `deadline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function ProjectSettingsSheet({ boardId, snapshot, sessions, agents, initialSection, onClose, onSaved, onRemoved }) {
  const { translate } = useTranslation();
  const [draft, setDraft] = useState(null);
  const [data, setData] = useState(null);
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [picking, setPicking] = useState(null);
  const sheetRef = useRef(null);

  useEffect(() => {
    let canceled = false;
    window.clauding.getBoards().then((state) => {
      if (!canceled) {
        const board = (state.boards || []).find((candidate) => candidate.id === boardId);
        setDraft(board ? JSON.parse(JSON.stringify(board)) : null);
      }
    });
    window.clauding
      .getBoardSettingsData(boardId)
      .then((answer) => {
        if (!canceled) {
          setData(answer);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setData({ buildStatuses: [], planningStatuses: [], planningFields: [], members: [], datedTasks: [], currentUser: null, error: cleanErrorMessage(error) });
        }
      });
    return () => {
      canceled = true;
    };
  }, [boardId]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape" && !picking) {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, picking]);

  // Open at the section that was asked for (e.g. "deadlines" from the axis).
  useEffect(() => {
    if (!draft || !initialSection || !sheetRef.current) {
      return;
    }
    const target = sheetRef.current.querySelector(`[data-settings-section="${initialSection}"]`);
    if (target) {
      target.scrollIntoView({ block: "start" });
    }
  }, [draft, initialSection]);

  const cardsById = useMemo(() => new Map(((snapshot && snapshot.cards) || []).map((card) => [card.id, card])), [snapshot]);
  const sessionsById = useMemo(() => new Map((sessions || []).map((session) => [session.sessionId, session])), [sessions]);

  function change(update) {
    setDraft((previous) => ({ ...previous, ...update }));
  }

  async function save() {
    setSaving(true);
    setFailure(null);
    try {
      const saved = await window.clauding.updateBoard(boardId, { ...draft, deadlines: usableDeadlines(draft.deadlines) });
      onSaved(saved);
    } catch (error) {
      setFailure(cleanErrorMessage(error));
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await window.clauding.deleteBoard(boardId);
      onRemoved(boardId);
    } catch (error) {
      setFailure(cleanErrorMessage(error));
    }
  }

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (sheetRef.current && !sheetRef.current.contains(event.target) && !picking) {
          onClose();
        }
      }}
    >
      <div className="sheet is-wide project-settings" ref={sheetRef} data-project-settings={boardId}>
        <div className="sheet-title">{translate("projectSettings.title", { name: draft ? draft.name : "" })}</div>
        <p className="sheet-hint">{translate("projectSettings.readOnlyNote")}</p>
        {!draft && <p className="project-dim">{translate("panel.loading")}</p>}
        {draft && (
          <div className="project-settings-body">
            <GeneralSection draft={draft} change={change} />
            <ClickupSection draft={draft} change={change} data={data} onPick={setPicking} />
            <RepositoriesSection draft={draft} change={change} />
            <PeopleSection draft={draft} change={change} data={data} />
            <DeadlinesSection
              draft={draft}
              change={change}
              data={data}
              cardsById={cardsById}
              axisItems={snapshot && snapshot.timeline ? snapshot.timeline.items || [] : []}
            />
            <FocusSection draft={draft} change={change} />
            <UpNextSection draft={draft} change={change} cardsById={cardsById} />
            <StatusesSection draft={draft} change={change} data={data} />
            <DeveloperSection draft={draft} change={change} data={data} />
            <RolesSection draft={draft} change={change} agents={agents} />
            <LinksSection draft={draft} change={change} cardsById={cardsById} sessionsById={sessionsById} />
            <section className="settings-section is-danger" data-settings-section="remove">
              <h4>{translate("projectSettings.removeTitle")}</h4>
              {confirmingRemove ? (
                <div className="settings-confirm" data-remove-confirm>
                  <span>{translate("projectSettings.removeConfirm", { name: draft.name })}</span>
                  <button type="button" className="button is-danger is-small" onClick={remove} data-remove-confirm-button>
                    {translate("projectSettings.removeConfirmButton")}
                  </button>
                  <button type="button" className="button is-ghost is-small" onClick={() => setConfirmingRemove(false)}>
                    {translate("projects.cancel")}
                  </button>
                </div>
              ) : (
                <>
                  <p className="sheet-hint">{translate("projectSettings.removeHint")}</p>
                  <button type="button" className="button is-secondary is-small" onClick={() => setConfirmingRemove(true)} data-remove-project>
                    {translate("projectSettings.removeButton")}
                  </button>
                </>
              )}
            </section>
          </div>
        )}
        {failure && <p className="sheet-hint is-problem">{failure}</p>}
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" onClick={onClose}>
            {translate("projects.cancel")}
          </button>
          <button type="button" className="button is-primary" disabled={!draft || !draft.name.trim() || saving} onClick={save} data-settings-save>
            {translate("projectSettings.save")}
          </button>
        </div>
        {picking && (
          <ListPicker
            onClose={() => setPicking(null)}
            onPick={(list) => {
              const clickup = { ...draft.clickup };
              if (picking === "build") {
                clickup.buildListId = list.id;
                clickup.buildListName = list.name;
              } else {
                clickup.planningListId = list.id;
                clickup.planningListName = list.name;
              }
              change({ clickup });
              setPicking(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function Section({ name, children }) {
  const { translate } = useTranslation();
  return (
    <section className="settings-section" data-settings-section={name}>
      <h4>{translate(`projectSettings.section.${name}`)}</h4>
      {children}
    </section>
  );
}

function GeneralSection({ draft, change }) {
  const { translate } = useTranslation();
  return (
    <Section name="general">
      <div className="settings-grid">
        <label className="sheet-label" htmlFor="settings-name">
          {translate("projects.fieldName")}
        </label>
        <input id="settings-name" className="agent-form-input" value={draft.name} onChange={(event) => change({ name: event.target.value })} />
        <label className="sheet-label" htmlFor="settings-group">
          {translate("projectSettings.group")}
        </label>
        <input
          id="settings-group"
          className="agent-form-input"
          value={draft.group}
          list="settings-group-choices"
          onChange={(event) => change({ group: event.target.value })}
        />
        <datalist id="settings-group-choices">
          <option value="Work" />
          <option value="Private" />
        </datalist>
        <span className="sheet-label">{translate("projectSettings.color")}</span>
        <span className="settings-colors">
          {Array.from({ length: COLOR_COUNT }, (unused, index) => `--project-color-${index}`).map((color) => (
            <button
              type="button"
              key={color}
              className={draft.color === color ? "settings-color is-selected" : "settings-color"}
              style={{ background: `var(${color})` }}
              onClick={() => change({ color })}
              aria-label={color}
            />
          ))}
        </span>
      </div>
      <div className="settings-checks">
        <label className="settings-check">
          <input type="checkbox" checked={draft.countSubtasks !== false} onChange={(event) => change({ countSubtasks: event.target.checked })} data-count-subtasks />
          {translate("projectSettings.countSubtasks")}
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={draft.includeClosed !== false} onChange={(event) => change({ includeClosed: event.target.checked })} data-include-closed />
          {translate("projectSettings.includeClosed")}
        </label>
      </div>
      <p className="sheet-hint">{translate("projectSettings.countingHint")}</p>
    </Section>
  );
}

function ClickupSection({ draft, change, data, onPick }) {
  const { translate } = useTranslation();
  const fields = (data && data.planningFields) || [];
  const fieldNames = [...new Set([draft.specUrlFieldName, ...fields.map((field) => field.name)].filter(Boolean))];
  return (
    <Section name="clickup">
      <div className="settings-lists">
        <div className="settings-list-box" data-settings-build-list>
          <span className="sheet-label">{translate("projectSettings.buildList")}</span>
          <div className="settings-list-value">
            <span className="clickup-mark" aria-hidden="true" />
            <span>{draft.clickup.buildListName || translate("projectSettings.noList")}</span>
            {draft.clickup.buildListId && <span className="project-dim mono">{draft.clickup.buildListId}</span>}
            <span className="project-header-spacer" />
            <button type="button" className="text-link" onClick={() => onPick("build")} data-pick-build-list>
              {translate("projectSettings.change")}
            </button>
          </div>
        </div>
        <div className="settings-list-box" data-settings-planning-list>
          <span className="sheet-label">{translate("projectSettings.planningList")}</span>
          <div className="settings-list-value">
            <span className="clickup-mark" aria-hidden="true" />
            <span>{draft.clickup.planningListName || translate("projectSettings.noPlanningList")}</span>
            {draft.clickup.planningListId && <span className="project-dim mono">{draft.clickup.planningListId}</span>}
            <span className="project-header-spacer" />
            <button type="button" className="text-link" onClick={() => onPick("planning")} data-pick-planning-list>
              {translate("projectSettings.change")}
            </button>
            {draft.clickup.planningListId && (
              <button
                type="button"
                className="text-link"
                onClick={() => change({ clickup: { ...draft.clickup, planningListId: null, planningListName: null } })}
              >
                {translate("projectSettings.clear")}
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="sheet-hint">{translate("projectSettings.listsHint")}</p>
      <label className="sheet-label" htmlFor="settings-spec-field">
        {translate("projectSettings.specField")}
      </label>
      <select
        id="settings-spec-field"
        className="sheet-agent-select"
        value={draft.specUrlFieldName}
        onChange={(event) => change({ specUrlFieldName: event.target.value })}
        data-settings-spec-field
      >
        {fieldNames.map((fieldName) => (
          <option key={fieldName} value={fieldName}>
            {fieldName}
          </option>
        ))}
      </select>
      <p className="sheet-hint">{translate("projectSettings.specFieldHint")}</p>
    </Section>
  );
}

function RepositoriesSection({ draft, change }) {
  const { translate } = useTranslation();
  const repositories = draft.repositories || [];
  const update = (index, patch) => change({ repositories: repositories.map((repository, position) => (position === index ? { ...repository, ...patch } : repository)) });
  return (
    <Section name="repositories">
      {repositories.length === 0 && <p className="project-dim">{translate("projectSettings.noRepositories")}</p>}
      {repositories.length > 0 && (
        <div className="settings-table settings-repositories">
          <span className="settings-column-head">{translate("projectSettings.repositoryName")}</span>
          <span className="settings-column-head">{translate("projectSettings.repositoryPath")}</span>
          <span className="settings-column-head">{translate("projectSettings.baseBranch")}</span>
          <span className="settings-column-head">{translate("projectSettings.stagingBranch")}</span>
          <span />
          {repositories.map((repository, index) => (
            <RepositoryRow key={index} repository={repository} onChange={(patch) => update(index, patch)} onRemove={() => change({ repositories: repositories.filter((unused, position) => position !== index) })} />
          ))}
        </div>
      )}
      <button
        type="button"
        className="text-link"
        onClick={() => change({ repositories: [...repositories, { name: "", localPath: "", baseBranch: "main", stagingBranch: "staging" }] })}
        data-add-repository
      >
        + {translate("projectSettings.addRepository")}
      </button>
      <p className="sheet-hint">{translate("projectSettings.repositoriesHint")}</p>
    </Section>
  );
}

function RepositoryRow({ repository, onChange, onRemove }) {
  const { translate } = useTranslation();
  return (
    <>
      <input className="agent-form-input" value={repository.name} onChange={(event) => onChange({ name: event.target.value })} />
      <input
        className="agent-form-input mono"
        value={repository.localPath || ""}
        spellCheck={false}
        onChange={(event) => {
          const localPath = event.target.value;
          const guessedName = localPath.split(/[\\/]/).filter(Boolean).pop() || "";
          onChange(repository.name ? { localPath } : { localPath, name: guessedName });
        }}
      />
      <input className="agent-form-input mono" value={repository.baseBranch} spellCheck={false} onChange={(event) => onChange({ baseBranch: event.target.value })} />
      <input className="agent-form-input mono" value={repository.stagingBranch} spellCheck={false} onChange={(event) => onChange({ stagingBranch: event.target.value })} />
      <button type="button" className="settings-remove" onClick={onRemove} title={translate("projectSettings.removeRow")}>
        ✕
      </button>
    </>
  );
}

function PeopleSection({ draft, change, data }) {
  const { translate } = useTranslation();
  const members = (data && data.members) || [];
  const known = members.some((person) => person.id === draft.clickupUserId);
  return (
    <Section name="people">
      <label className="sheet-label" htmlFor="settings-me">
        {translate("projectSettings.me")}
      </label>
      <select
        id="settings-me"
        className="sheet-agent-select"
        value={draft.clickupUserId || ""}
        onChange={(event) => change({ clickupUserId: event.target.value || null })}
        data-settings-me
      >
        <option value="">{translate("projectSettings.meTokenOwner", { name: data && data.currentUser ? data.currentUser.name : "—" })}</option>
        {!known && draft.clickupUserId && <option value={draft.clickupUserId}>{draft.clickupUserId}</option>}
        {members.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
      <p className="sheet-hint">{translate("projectSettings.meHint")}</p>
    </Section>
  );
}

// One deadline, as a row: its name, where its date comes from (typed by
// hand, or a ClickUp task's due date — it moves when the task moves), the
// date or the task, and a remove button that asks first. Used here and in
// the sheet a click on the deadline axis opens.
export function DeadlineRow({ deadline, datedTasks, cardsById, onChange, onRemove }) {
  const { translate } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const taskChoices = useMemo(() => {
    const choices = new Map();
    for (const task of datedTasks || []) {
      choices.set(task.id, task);
    }
    for (const card of cardsById ? cardsById.values() : []) {
      if (!choices.has(card.id)) {
        choices.set(card.id, { id: card.id, name: card.name, dueDate: card.dueDate || null });
      }
    }
    return [...choices.values()].sort((first, second) => (second.dueDate ? 1 : 0) - (first.dueDate ? 1 : 0) || first.name.localeCompare(second.name));
  }, [datedTasks, cardsById]);
  return (
    <div className="deadline-row" data-deadline-row={deadline.id}>
      <input
        className="agent-form-input"
        value={deadline.label}
        placeholder={translate("projectSettings.deadlineName")}
        onChange={(event) => onChange({ label: event.target.value })}
        data-deadline-label
      />
      <select
        className="sheet-agent-select"
        value={deadline.source}
        onChange={(event) => onChange({ source: event.target.value, taskId: event.target.value === "task" ? deadline.taskId : null })}
        data-deadline-source
      >
        <option value="manual">{translate("projectSettings.deadlineManual")}</option>
        <option value="task">{translate("projectSettings.deadlineFromTask")}</option>
      </select>
      {deadline.source === "task" ? (
        <select className="sheet-agent-select" value={deadline.taskId || ""} onChange={(event) => onChange({ taskId: event.target.value || null })} data-deadline-task>
          <option value="">{translate("projectSettings.pickTask")}</option>
          {taskChoices.map((task) => (
            <option key={task.id} value={task.id}>
              {task.dueDate ? `${timeToDateInput(task.dueDate)} · ` : ""}
              {task.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="date"
          className="agent-form-input"
          value={timeToDateInput(deadline.date)}
          onChange={(event) => onChange({ date: dateInputToTime(event.target.value) })}
          data-deadline-date
        />
      )}
      {confirming ? (
        <span className="settings-confirm">
          <button type="button" className="button is-danger is-small" onClick={onRemove} data-deadline-remove-confirm>
            {translate("projectSettings.removeRowConfirm")}
          </button>
          <button type="button" className="button is-ghost is-small" onClick={() => setConfirming(false)}>
            {translate("projects.cancel")}
          </button>
        </span>
      ) : (
        <button type="button" className="settings-remove" onClick={() => setConfirming(true)} title={translate("projectSettings.removeRow")} data-deadline-remove>
          ✕
        </button>
      )}
    </div>
  );
}

export function blankDeadline() {
  return { id: newIdentifier(), label: "", date: null, source: "manual", taskId: null };
}

// Rows without a name, or without a date or a task, are not kept.
export function usableDeadlines(deadlines) {
  return (deadlines || []).filter(
    (deadline) => deadline.label.trim() && (deadline.source === "task" ? Boolean(deadline.taskId) : Number.isFinite(deadline.date))
  );
}

// Every phase and date the axis could draw (typed here or read from
// ClickUp): a check box shows or hides each one (board.deadlineHidden), and
// one of them can be the key deadline "Next" counts to (board.keyDeadlineId).
function AxisItems({ items, draft, change }) {
  const { translate } = useTranslation();
  const hidden = new Set(draft.deadlineHidden || []);
  const keyId = draft.keyDeadlineId || "";
  const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="settings-axis-items" data-axis-items>
      <div className="sheet-label">{translate("projectSettings.deadlineItems")}</div>
      {items.map((item) => (
        <div key={item.id} className="settings-axis-item" data-axis-item={item.id}>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={!hidden.has(item.id)}
              onChange={(event) => {
                const next = new Set(hidden);
                if (event.target.checked) {
                  next.delete(item.id);
                } else {
                  next.add(item.id);
                }
                change({ deadlineHidden: [...next], keyDeadlineId: !event.target.checked && keyId === item.id ? null : keyId || null });
              }}
              data-axis-item-show={item.id}
            />
            <span className="settings-axis-item-name" title={item.label}>
              {item.label}
            </span>
            <span className="project-dim">
              {item.start ? `${formatter.format(item.start)} → ` : ""}
              {formatter.format(item.date)}
            </span>
          </label>
          <label className="settings-axis-item-key" title={translate("projectSettings.deadlineItemKey")}>
            <input
              type="radio"
              name="key-deadline"
              checked={keyId === item.id}
              disabled={hidden.has(item.id)}
              onChange={() => change({ keyDeadlineId: item.id })}
              data-axis-item-key={item.id}
            />
            📌
          </label>
        </div>
      ))}
      <label className="settings-check">
        <input type="radio" name="key-deadline" checked={!keyId} onChange={() => change({ keyDeadlineId: null })} data-axis-item-key="none" />
        {translate("projectSettings.deadlineNoKey")}
      </label>
      <p className="sheet-hint">{translate("projectSettings.deadlineItemsHint")}</p>
    </div>
  );
}

function DeadlinesSection({ draft, change, data, cardsById, axisItems = [] }) {
  const { translate } = useTranslation();
  const deadlines = draft.deadlines || [];
  const update = (deadlineId, patch) => change({ deadlines: deadlines.map((deadline) => (deadline.id === deadlineId ? { ...deadline, ...patch } : deadline)) });
  const datedTasks = (data && data.datedTasks) || [];
  const candidates = (data && data.deadlineCandidates) || [];
  const source = draft.deadlineSource || { mode: "auto", includeManual: true };
  const chosen = data && data.deadlineChosenId ? candidates.find((candidate) => candidate.id === data.deadlineChosenId) : null;
  const sourceValue = source.mode === "task" || source.mode === "list" ? `${source.mode}:${source.id}` : source.mode;
  const known = candidates.some((candidate) => `${candidate.kind}:${candidate.id}` === sourceValue);
  const chooseSource = (value) => {
    if (value === "auto" || value === "manual") {
      change({ deadlineSource: { ...source, mode: value, id: null, name: null } });
      return;
    }
    const [kind, ...rest] = value.split(":");
    const id = rest.join(":");
    const candidate = candidates.find((entry) => entry.kind === kind && entry.id === id);
    change({ deadlineSource: { ...source, mode: kind, id, name: candidate ? candidate.name : source.name } });
  };
  return (
    <Section name="deadlines">
      <label className="sheet-label" htmlFor="settings-deadline-source">
        {translate("projectSettings.deadlineSource")}
      </label>
      <select id="settings-deadline-source" className="sheet-agent-select" value={sourceValue} onChange={(event) => chooseSource(event.target.value)} data-deadline-source-select>
        <option value="auto">
          {chosen ? translate("projectSettings.deadlineSourceAutoFound", { name: chosen.name }) : translate("projectSettings.deadlineSourceAuto")}
        </option>
        {candidates.map((candidate) => (
          <option key={`${candidate.kind}:${candidate.id}`} value={`${candidate.kind}:${candidate.id}`}>
            {translate(candidate.kind === "task" ? "projectSettings.deadlineSourceTask" : "projectSettings.deadlineSourceList", {
              name: candidate.name,
              where: candidate.where || "—",
              count: candidate.dated
            })}
          </option>
        ))}
        {!known && (source.mode === "task" || source.mode === "list") && <option value={sourceValue}>{source.name || source.id}</option>}
        <option value="manual">{translate("projectSettings.deadlineSourceManual")}</option>
      </select>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={source.mode === "manual" || source.includeManual !== false}
          disabled={source.mode === "manual"}
          onChange={(event) => change({ deadlineSource: { ...source, includeManual: event.target.checked } })}
          data-deadline-include-manual
        />
        {translate("projectSettings.deadlineIncludeManual")}
      </label>
      <p className="sheet-hint">
        {candidates.length === 0
          ? translate("projectSettings.deadlineNoCandidates")
          : !chosen && source.mode === "auto"
            ? translate("projectSettings.deadlineManyCandidates", { names: candidates.map((candidate) => candidate.name).join(", ") })
            : translate("projectSettings.deadlineSourceHint")}
        {data && data.deadlineSearchTruncated ? ` ${translate("projectSettings.deadlineSearchTruncated")}` : ""}
      </p>
      <AxisItems items={axisItems} draft={draft} change={change} />
      {deadlines.length === 0 && <p className="project-dim">{translate("projectSettings.noDeadlines")}</p>}
      {deadlines.map((deadline) => (
        <DeadlineRow
          key={deadline.id}
          deadline={deadline}
          datedTasks={datedTasks}
          cardsById={cardsById}
          onChange={(patch) => update(deadline.id, patch)}
          onRemove={() => change({ deadlines: deadlines.filter((candidate) => candidate.id !== deadline.id) })}
        />
      ))}
      <button type="button" className="text-link" onClick={() => change({ deadlines: [...deadlines, blankDeadline()] })} data-add-deadline>
        + {translate("projectSettings.addDeadline")}
      </button>
      <p className="sheet-hint">
        {translate("projectSettings.deadlinesHint")}{" "}
        {datedTasks.length === 0 ? translate("projectSettings.noDatedTasks") : translate("projectSettings.datedTasks", { count: datedTasks.length })}
      </p>
    </Section>
  );
}

function FocusSection({ draft, change }) {
  const { translate } = useTranslation();
  const rules = draft.focusRules || {};
  return (
    <Section name="focus">
      <div className="settings-checks">
        {FOCUS_RULES.map((rule) => (
          <label key={rule} className="settings-check">
            <input type="checkbox" checked={Boolean(rules[rule])} onChange={(event) => change({ focusRules: { ...rules, [rule]: event.target.checked } })} data-focus-rule={rule} />
            {translate(`projectSettings.focus.${rule}`)}
          </label>
        ))}
      </div>
    </Section>
  );
}

function UpNextSection({ draft, change, cardsById }) {
  const { translate } = useTranslation();
  const upNext = draft.upNext || [];
  return (
    <Section name="upNext">
      {upNext.length === 0 && <p className="project-dim">{translate("projectSettings.upNextEmpty")}</p>}
      {upNext.map((taskId, index) => {
        const card = cardsById.get(taskId);
        return (
          <div key={taskId} className="settings-up-next" data-settings-up-next={taskId}>
            <span className="settings-up-next-place">{index + 1}</span>
            <span className="settings-up-next-name">{card ? card.name : `CU-${taskId}`}</span>
            <button type="button" className="text-link" disabled={index === 0} onClick={() => change({ upNext: moveInList(upNext, taskId, -1) })} title={translate("projectSettings.moveUp")}>
              ↑
            </button>
            <button type="button" className="text-link" disabled={index === upNext.length - 1} onClick={() => change({ upNext: moveInList(upNext, taskId, 1) })} title={translate("projectSettings.moveDown")}>
              ↓
            </button>
            <button type="button" className="settings-remove" onClick={() => change({ upNext: upNext.filter((candidate) => candidate !== taskId) })} title={translate("projects.unpin")}>
              ✕
            </button>
          </div>
        );
      })}
      <p className="sheet-hint">{translate("projectSettings.upNextHint")}</p>
    </Section>
  );
}

function StatusesSection({ draft, change, data }) {
  const { translate } = useTranslation();
  const buildStatuses = (data && data.buildStatuses) || [];
  const planningStatuses = (data && data.planningStatuses) || [];
  const findOverride = (overrides, statusName) => {
    const entry = Object.entries(overrides || {}).find(([name]) => name.trim().toLowerCase() === statusName.trim().toLowerCase());
    return entry ? entry[1] : AUTOMATIC;
  };
  const setOverride = (field, statusName, value) => {
    const overrides = Object.fromEntries(Object.entries(draft[field] || {}).filter(([name]) => name.trim().toLowerCase() !== statusName.trim().toLowerCase()));
    if (value !== AUTOMATIC) {
      overrides[statusName] = value;
    }
    change({ [field]: overrides });
  };
  return (
    <Section name="statuses">
      {!data && <p className="project-dim">{translate("panel.loading")}</p>}
      {data && data.error && <p className="sheet-hint is-problem">{translate("projectSettings.clickupUnavailable")}</p>}
      <div className="settings-status-columns">
        <div data-settings-build-statuses>
          <span className="sheet-label">{translate("projectSettings.buildStatuses")}</span>
          {buildStatuses.map((status) => (
            <div key={status.name} className="settings-status-row is-three">
              <span className="settings-status-name">{status.name}</span>
              <select
                className="sheet-agent-select"
                value={findOverride(draft.perspectiveOverrides, status.name)}
                onChange={(event) => setOverride("perspectiveOverrides", status.name, event.target.value)}
                data-perspective-select={status.name}
              >
                <option value={AUTOMATIC}>{translate("projectSettings.automatic", { name: translate(`projects.perspective.${status.automaticPerspective || "myQueue"}`) })}</option>
                {PERSPECTIVES.map((perspective) => (
                  <option key={perspective} value={perspective}>
                    {translate(`projects.perspective.${perspective}`)}
                  </option>
                ))}
              </select>
              <select className="sheet-agent-select" value={findOverride(draft.statusOverrides, status.name)} onChange={(event) => setOverride("statusOverrides", status.name, event.target.value)}>
                <option value={AUTOMATIC}>{translate("projectSettings.automatic", { name: translate(`projects.bucket.${status.automatic}`) })}</option>
                {[...BUCKET_ORDER, "other"].map((bucket) => (
                  <option key={bucket} value={bucket}>
                    {translate(`projects.bucket.${bucket}`)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <div data-settings-planning-statuses>
          <span className="sheet-label">{translate("projectSettings.planningStatuses")}</span>
          {data && !draft.clickup.planningListId && <p className="project-dim">{translate("projectSettings.noPlanningList")}</p>}
          {planningStatuses.map((status) => (
            <div key={status.name} className="settings-status-row">
              <span className="settings-status-name">{status.name}</span>
              <select className="sheet-agent-select" value={findOverride(draft.specStatusOverrides, status.name)} onChange={(event) => setOverride("specStatusOverrides", status.name, event.target.value)}>
                <option value={AUTOMATIC}>{translate("projectSettings.automatic", { name: translate(`projects.specStage.${status.automatic}`) })}</option>
                {SPEC_STAGE_ORDER.filter((stage) => stage !== "session").map((stage) => (
                  <option key={stage} value={stage}>
                    {translate(`projects.specStage.${stage}`)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
      <p className="sheet-hint">{translate("projectSettings.statusesHint")}</p>
    </Section>
  );
}

// The developer's own status, when the tasks carry one in a drop-down
// field: which field (detected unless chosen) and which of its values put a
// task in the user's queue, waiting on others, or closed.
function DeveloperSection({ draft, change, data }) {
  const { translate } = useTranslation();
  const dropDowns = ((data && data.buildFields) || []).filter((field) => field.type === "drop_down");
  const detected = data ? data.detectedDeveloperField : null;
  const fieldName = draft.developerStatusFieldName || detected || "";
  const field = dropDowns.find((candidate) => candidate.name === fieldName) || null;
  const map = draft.developerStatusMap || {};
  const setValue = (value, perspective) => {
    const next = Object.fromEntries(Object.entries(map).filter(([name]) => name !== value));
    if (perspective !== AUTOMATIC) {
      next[value] = perspective;
    }
    change({ developerStatusMap: next });
  };
  return (
    <Section name="developer">
      <label className="sheet-label" htmlFor="settings-developer-field">
        {translate("projectSettings.developerField")}
      </label>
      <select
        id="settings-developer-field"
        className="sheet-agent-select"
        value={draft.developerStatusFieldName || ""}
        onChange={(event) => change({ developerStatusFieldName: event.target.value || null })}
        data-developer-field
      >
        <option value="">{detected ? translate("projectSettings.developerDetected", { name: detected }) : translate("projectSettings.developerNone")}</option>
        {dropDowns.map((candidate) => (
          <option key={candidate.name} value={candidate.name}>
            {candidate.name}
          </option>
        ))}
      </select>
      {field && (field.options || []).length > 0 && (
        <div className="settings-developer-values" data-developer-values>
          {field.options.map((value) => (
            <div key={value} className="settings-status-row">
              <span className="settings-status-name">{value}</span>
              <select className="sheet-agent-select" value={map[value] || AUTOMATIC} onChange={(event) => setValue(value, event.target.value)}>
                <option value={AUTOMATIC}>{translate("projectSettings.developerByStatus")}</option>
                {PERSPECTIVES.map((perspective) => (
                  <option key={perspective} value={perspective}>
                    {translate(`projects.perspective.${perspective}`)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
      <p className="sheet-hint">{translate("projectSettings.developerHint")}</p>
    </Section>
  );
}

function RolesSection({ draft, change, agents }) {
  const { translate } = useTranslation();
  const roles = draft.agentRoles || {};
  return (
    <Section name="roles">
      {(agents || []).length === 0 && <p className="project-dim">{translate("projectSettings.noAgents")}</p>}
      {(agents || []).map((agent) => (
        <div key={agent.id} className="settings-status-row">
          <span className="settings-status-name">
            {agent.emoji ? `${agent.emoji} ` : ""}
            {agent.name}
          </span>
          <select
            className="sheet-agent-select"
            value={roles[agent.id] || AUTOMATIC}
            onChange={(event) => {
              const next = { ...roles };
              if (event.target.value === AUTOMATIC) {
                delete next[agent.id];
              } else {
                next[agent.id] = event.target.value;
              }
              change({ agentRoles: next });
            }}
          >
            <option value={AUTOMATIC}>{translate("projectSettings.roleAutomatic")}</option>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {translate(`projects.role.${role}`)}
              </option>
            ))}
          </select>
        </div>
      ))}
      <p className="sheet-hint">{translate("projectSettings.rolesHint")}</p>
    </Section>
  );
}

function LinksSection({ draft, change, cardsById, sessionsById }) {
  const { translate } = useTranslation();
  const links = Object.entries(draft.manualLinks || {});
  const setLink = (taskId, link) => {
    const next = { ...(draft.manualLinks || {}) };
    if (link.sessionIds.length === 0 && link.unlinkedSessionIds.length === 0) {
      delete next[taskId];
    } else {
      next[taskId] = link;
    }
    change({ manualLinks: next });
  };
  const sessionName = (sessionId) => {
    const session = sessionsById.get(sessionId);
    return session ? session.title : sessionId.slice(0, 8);
  };
  return (
    <Section name="links">
      {links.length === 0 && <p className="project-dim">{translate("projectSettings.noLinks")}</p>}
      {links.map(([taskId, link]) => {
        const card = cardsById.get(taskId);
        return (
          <div key={taskId} className="settings-link" data-settings-link={taskId}>
            <b>{card ? card.name : `CU-${taskId}`}</b>
            {link.sessionIds.map((sessionId) => (
              <span key={sessionId} className="settings-link-chip">
                {translate("projectSettings.linked", { name: sessionName(sessionId) })}
                <button type="button" className="settings-remove" onClick={() => setLink(taskId, { ...link, sessionIds: link.sessionIds.filter((candidate) => candidate !== sessionId) })}>
                  ✕
                </button>
              </span>
            ))}
            {link.unlinkedSessionIds.map((sessionId) => (
              <span key={sessionId} className="settings-link-chip is-unlinked">
                {translate("projectSettings.unlinked", { name: sessionName(sessionId) })}
                <button type="button" className="settings-remove" onClick={() => setLink(taskId, { ...link, unlinkedSessionIds: link.unlinkedSessionIds.filter((candidate) => candidate !== sessionId) })}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        );
      })}
      <p className="sheet-hint">{translate("projectSettings.linksHint")}</p>
    </Section>
  );
}

// Workspace → space → folder → list, read from ClickUp one level at a time.
function ListPicker({ onClose, onPick }) {
  const { translate } = useTranslation();
  const [trail, setTrail] = useState([]);
  const [items, setItems] = useState(null);
  const [failure, setFailure] = useState(null);
  const place = trail.length > 0 ? trail[trail.length - 1] : null;

  useEffect(() => {
    let canceled = false;
    setItems(null);
    setFailure(null);
    window.clauding
      .browseClickup(place ? { kind: place.kind, id: place.id } : {})
      .then((answer) => {
        if (!canceled) {
          setItems(answer.items || []);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setFailure(cleanErrorMessage(error));
        }
      });
    return () => {
      canceled = true;
    };
  }, [place]);

  return (
    <div className="list-picker" data-list-picker>
      <div className="list-picker-head">
        <b>{translate("projectSettings.pickList")}</b>
        <span className="project-header-spacer" />
        <button type="button" className="text-link" onClick={onClose}>
          {translate("projects.cancel")}
        </button>
      </div>
      <div className="list-picker-trail">
        <button type="button" className="text-link" onClick={() => setTrail([])}>
          ClickUp
        </button>
        {trail.map((step, index) => (
          <span key={step.id}>
            {" › "}
            <button type="button" className="text-link" onClick={() => setTrail(trail.slice(0, index + 1))}>
              {step.name}
            </button>
          </span>
        ))}
      </div>
      {failure && <p className="sheet-hint is-problem">{failure}</p>}
      {!items && !failure && <p className="project-dim">{translate("panel.loading")}</p>}
      <div className="list-picker-items">
        {(items || []).map((item) =>
          item.kind === "list" ? (
            <button type="button" key={item.id} className="list-picker-item is-list" onClick={() => onPick(item)} data-list-picker-list={item.id}>
              <span className="clickup-mark" aria-hidden="true" />
              {item.name}
            </button>
          ) : (
            <button type="button" key={item.id} className="list-picker-item" onClick={() => setTrail([...trail, item])} data-list-picker-place={item.id}>
              {item.name} ›
            </button>
          )
        )}
        {items && items.length === 0 && <p className="project-dim">{translate("projectSettings.pickListEmpty")}</p>}
      </div>
    </div>
  );
}
