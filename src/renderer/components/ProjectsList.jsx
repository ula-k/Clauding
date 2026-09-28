import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { projectListModel } from "../projectsView.js";

// The Projects tab of the left column (variant B): one row per project with
// its color, name, how many tasks are left, a thin bar of where the tasks
// are, the nearest deadline and how much is closed. The numbers come from
// the last ClickUp answer on disk, so the list draws at once; a project
// that was never opened says so instead of showing zeros.
//
// "Add a project…" is a link, not a button: it opens a small sheet that
// asks for a name, one ClickUp task link and the local repositories — the
// lists are found from the task. Nothing is written to ClickUp.
export default function ProjectsList({ summaries, loading, selectedBoardId, onSelect, onAdd, readOnly }) {
  const { translate } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const groups = useMemo(() => projectListModel(summaries), [summaries]);

  return (
    <div className="session-list projects-list" data-projects-list>
      {loading && summaries.length === 0 && <div className="list-note">{translate("list.loading")}</div>}
      {!loading && summaries.length === 0 && (
        <div className="projects-empty" data-projects-empty>
          <p>{translate("projects.emptyList")}</p>
          <button type="button" className="text-link" onClick={() => setAddOpen(true)} data-add-project>
            {translate("projects.addProject")}
          </button>
        </div>
      )}
      {groups.map((group) => (
        <section key={group.name} className="projects-group">
          <div className="projects-group-title">{group.name}</div>
          {group.projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={project.id === selectedBoardId ? "project-line is-selected" : "project-line"}
              onClick={() => onSelect(project.id)}
              data-project-row={project.id}
            >
              <span className="project-line-top">
                <span className="project-ring" style={{ borderColor: project.color }} />
                <span className="project-line-name">{project.name}</span>
                {project.loaded && (
                  <span className="project-line-meta">{translate("projects.leftCount", { count: project.leftToClose })}</span>
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
                {project.loaded && <span>{translate("projects.closedPercent", { count: project.closedPercent })}</span>}
              </span>
            </button>
          ))}
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
            const board = await onAdd(draft);
            setAddOpen(false);
            if (board && board.id) {
              onSelect(board.id);
            }
          }}
        />
      )}
    </div>
  );
}

// Only what stage 1 needs to start a project: a name, one task link, and
// the repositories to look for CU- branches in (one folder per line). The
// full settings sheet (lists, people, deadlines, status map) is stage 2.
function AddProjectSheet({ onClose, onAdd, readOnly }) {
  const { translate } = useTranslation();
  const [name, setName] = useState("");
  const [seedLink, setSeedLink] = useState("");
  const [repositoryText, setRepositoryText] = useState("");
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
    setFailure(null);
    try {
      await onAdd({ name: name.trim(), seedLink: seedLink.trim() || null, repositories });
    } catch (error) {
      setFailure(String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      setSaving(false);
    }
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
            />
            <label className="sheet-label" htmlFor="add-project-seed">
              {translate("projects.fieldSeed")}
            </label>
            <input
              id="add-project-seed"
              type="text"
              className="agent-form-input"
              value={seedLink}
              spellCheck={false}
              placeholder="https://app.clickup.com/t/…"
              onChange={(event) => setSeedLink(event.target.value)}
            />
            <p className="sheet-hint">{translate("projects.fieldSeedHint")}</p>
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
            />
            <p className="sheet-hint">{translate("projects.stageTwoHint")}</p>
            {failure && <p className="sheet-hint is-problem">{failure}</p>}
          </>
        )}
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" onClick={onClose}>
            {translate("projects.cancel")}
          </button>
          {!readOnly && (
            <button type="submit" className="button is-primary" disabled={!name.trim() || saving}>
              {translate("projects.addConfirm")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
