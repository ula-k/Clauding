import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { projectListModel, searchProjects } from "../projectsView.js";
import { SearchIcon } from "./Icons.jsx";

// The Projects tab of the left column (variant B): one row per project with
// its color, name, how many tasks are left, a thin bar of where the tasks
// are, the nearest deadline and how much is closed. The numbers come from
// the last ClickUp answer on disk, so the list draws at once; a project
// that was never opened says so instead of showing zeros.
//
// "Add a project…" is a link, not a button: it opens a small sheet that
// asks for a name, one ClickUp link (list, view, folder or space) and the
// local repositories — the lists are found from the link. Nothing is
// written to ClickUp. The search box finds projects by name and their
// tasks by name or id (from the cached ClickUp answer).
export default function ProjectsList({ summaries, loading, selectedBoardId, onSelect, onSelectTask, onAdd, readOnly, addRequest, onAddRequestHandled }) {
  const { translate } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const found = useMemo(() => searchProjects(summaries, query), [summaries, query]);
  const groups = useMemo(() => projectListModel(found), [found]);
  const matchesById = useMemo(() => new Map(found.map((entry) => [entry.id, entry])), [found]);

  // Projects → Add a Project… in the menu bar.
  useEffect(() => {
    if (addRequest) {
      setAddOpen(true);
      if (onAddRequestHandled) {
        onAddRequestHandled();
      }
    }
  }, [addRequest, onAddRequestHandled]);

  return (
    <div className="session-list projects-list" data-projects-list>
      {summaries.length > 0 && (
        <div className="search-box projects-search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            placeholder={translate("projects.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
            data-projects-search
          />
        </div>
      )}
      {loading && summaries.length === 0 && <div className="list-note">{translate("list.loading")}</div>}
      {!loading && summaries.length === 0 && (
        <div className="projects-empty" data-projects-empty>
          <p>{translate("projects.emptyList")}</p>
          {!readOnly && (
            <button type="button" className="text-link" onClick={() => setAddOpen(true)} data-add-project>
              {translate("projects.addProject")}
            </button>
          )}
        </div>
      )}
      {summaries.length > 0 && found.length === 0 && <div className="list-note">{translate("projects.searchNothing")}</div>}
      {groups.map((group) => (
        <section key={group.name} className="projects-group">
          <div className="projects-group-title">{group.name}</div>
          {group.projects.map((project) => {
            const match = matchesById.get(project.id);
            return (
              <div key={project.id} className="project-line-wrap">
                <button
                  type="button"
                  className={project.id === selectedBoardId ? "project-line is-selected" : "project-line"}
                  onClick={() => onSelect(project.id)}
                  data-project-row={project.id}
                >
                  <span className="project-line-top">
                    <span className="project-ring" style={{ borderColor: project.color }} />
                    <span className="project-line-name">{project.name}</span>
                    {project.loaded && (
                      <span className="project-line-meta">{translate("projects.inQueueCount", { count: project.inQueue })}</span>
                    )}
                  </span>
                  <span className="thin-bar">
                    {project.segments.map((segment) => (
                      <span key={segment.bucket} style={{ width: `${segment.fraction * 100}%`, background: segment.color }} />
                    ))}
                  </span>
                  <span className="project-line-under">
                    <span className={project.deadline.soon ? "is-soon" : ""}>
                      {project.loaded ? translate(project.deadline.key, project.deadline.values) : translate("projects.notLoaded")}
                    </span>
                    {project.loaded && <span>{translate("projects.waitingClosed", { waiting: project.waiting, closed: project.closed })}</span>}
                  </span>
                </button>
                {match && match.matchingTasks.length > 0 && (
                  <div className="project-task-matches" data-project-task-matches={project.id}>
                    {match.matchingTasks.map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        className="project-task-match"
                        onClick={() => onSelectTask(project.id, task.id, query)}
                        data-project-task-match={task.id}
                      >
                        <span className="mono">CU-{task.id}</span> {task.name}
                      </button>
                    ))}
                    {match.hiddenMatches > 0 && (
                      <span className="project-dim project-task-more">{translate("projects.searchMoreTasks", { count: match.hiddenMatches })}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
      {summaries.length > 0 && !readOnly && (
        <button type="button" className="text-link projects-add-link" onClick={() => setAddOpen(true)} data-add-project>
          + {translate("projects.addProject")}
        </button>
      )}
      {addOpen && (
        <AddProjectSheet
          readOnly={readOnly}
          onClose={() => setAddOpen(false)}
          onAdd={async (draft) => {
            const answer = await onAdd(draft);
            if (answer && answer.board) {
              setAddOpen(false);
              onSelect(answer.board.id);
            }
            return answer;
          }}
        />
      )}
    </div>
  );
}

// A new project: a name, one ClickUp link — a list, a saved view, a folder
// or a space — and, if the user wants, one task link that settles which
// list is the build list; plus the repositories to look for CU- branches in
// (one folder per line). When the lists of a folder or space cannot be told
// apart, the sheet asks which one is the build list. Everything else
// (branches, people, deadlines, the status map) is in the settings sheet.
function AddProjectSheet({ onClose, onAdd, readOnly }) {
  const { translate } = useTranslation();
  const [name, setName] = useState("");
  const [projectLink, setProjectLink] = useState("");
  const [taskLink, setTaskLink] = useState("");
  const [repositoryText, setRepositoryText] = useState("");
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState(null);
  const [chosenListId, setChosenListId] = useState("");
  const sheetRef = useRef(null);

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

  async function submit(event) {
    event.preventDefault();
    const repositories = repositoryText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((folder) => ({ name: folder.split(/[\\/]/).filter(Boolean).pop() || folder, localPath: folder }));
    const draft = { name: name.trim(), projectLink: projectLink.trim() || null, taskLink: taskLink.trim() || null, repositories };
    if (choice) {
      const chosen = choice.candidates.find((candidate) => candidate.id === chosenListId);
      if (!chosen) {
        setFailure({ key: "projects.linkError.pickList", values: {} });
        return;
      }
      draft.clickup = { ...choice.clickup, buildListId: chosen.id, buildListName: chosen.name };
    }
    setSaving(true);
    setFailure(null);
    try {
      const answer = await onAdd(draft);
      if (answer && answer.errorKey) {
        setFailure({ key: answer.errorKey, values: answer.values || {} });
      } else if (answer && answer.candidates) {
        setChoice({ candidates: answer.candidates, clickup: answer.clickup || {} });
        setChosenListId(answer.candidates[0] ? answer.candidates[0].id : "");
      }
    } catch (error) {
      setFailure({ key: "projects.linkError.clickupFailed", values: { message: String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") } });
    }
    setSaving(false);
  }

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (sheetRef.current && !sheetRef.current.contains(event.target)) {
          onClose();
        }
      }}
    >
      <form className="sheet add-project-sheet" ref={sheetRef} onSubmit={submit} data-add-project-sheet>
        <div className="sheet-title">{translate("projects.addTitle")}</div>
        {readOnly ? (
          <p className="sheet-hint">{translate("projects.fixtureReadOnly")}</p>
        ) : (
          <>
            <label className="sheet-label" htmlFor="add-project-name">
              {translate("projects.fieldName")}
            </label>
            <input
              id="add-project-name"
              type="text"
              className="agent-form-input"
              value={name}
              autoFocus
              placeholder={translate("projects.fieldNamePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              data-add-project-name
            />
            <label className="sheet-label" htmlFor="add-project-link">
              {translate("projects.fieldProjectLink")}
            </label>
            <input
              id="add-project-link"
              type="text"
              className="agent-form-input"
              value={projectLink}
              spellCheck={false}
              placeholder="https://app.clickup.com/…/v/li/…"
              onChange={(event) => {
                setProjectLink(event.target.value);
                setChoice(null);
              }}
              data-add-project-link
            />
            <p className="sheet-hint">{translate("projects.fieldProjectLinkHint")}</p>
            <label className="sheet-label" htmlFor="add-project-task">
              {translate("projects.fieldTaskLink")}
            </label>
            <input
              id="add-project-task"
              type="text"
              className="agent-form-input"
              value={taskLink}
              spellCheck={false}
              placeholder="https://app.clickup.com/t/…"
              onChange={(event) => {
                setTaskLink(event.target.value);
                setChoice(null);
              }}
              data-add-project-task
            />
            <p className="sheet-hint">{translate("projects.fieldTaskLinkHint")}</p>
            {choice && (
              <>
                <label className="sheet-label" htmlFor="add-project-choice">
                  {translate("projects.pickBuildList")}
                </label>
                <select
                  id="add-project-choice"
                  className="sheet-agent-select"
                  value={chosenListId}
                  onChange={(event) => setChosenListId(event.target.value)}
                  data-add-project-choice
                >
                  {choice.candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.folderName ? `${candidate.folderName} › ${candidate.name}` : candidate.name}
                    </option>
                  ))}
                </select>
                <p className="sheet-hint">{translate("projects.pickBuildListHint")}</p>
              </>
            )}
            <label className="sheet-label" htmlFor="add-project-repositories">
              {translate("projects.fieldRepositories")}
            </label>
            <textarea
              id="add-project-repositories"
              className="agent-form-input add-project-repositories"
              value={repositoryText}
              rows={3}
              spellCheck={false}
              placeholder={translate("projects.fieldRepositoriesPlaceholder")}
              onChange={(event) => setRepositoryText(event.target.value)}
              data-add-project-repositories
            />
            <p className="sheet-hint">{translate("projects.settingsLaterHint")}</p>
            {failure && (
              <p className="sheet-hint is-problem" data-add-project-problem>
                {translate(failure.key, failure.values)}
              </p>
            )}
          </>
        )}
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" onClick={onClose}>
            {translate("projects.cancel")}
          </button>
          {!readOnly && (
            <button type="submit" className="button is-primary" disabled={!name.trim() || saving} data-add-project-confirm>
              {saving ? translate("projects.addChecking") : translate("projects.addConfirm")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
