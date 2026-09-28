import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n.js";
import { renderMarkdown } from "../markdown.js";
import { clickupErrorLabel } from "../projectsView.js";

// The side panel's own view of one ClickUp task (Projects view): status,
// assignees, due date, custom fields, the description and the comments,
// read by the main process with GET requests only. It is not a webview on
// purpose — ClickUp in a panel would be signed out; "Open in ClickUp ↗"
// takes the real page to the default browser, where the user is signed in.
export default function ClickupTaskTab({ tab, active, reloadCounter, onOpenExternal }) {
  const { translate, language } = useTranslation();
  const [detail, setDetail] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    let canceled = false;
    setFailure(null);
    window.clauding
      .getBoardTaskDetail(tab.target)
      .then((answer) => {
        if (canceled) {
          return;
        }
        if (answer && answer.errorKind) {
          const label = clickupErrorLabel(answer.errorKind, answer.status);
          setFailure(translate(label.key, label.values));
          return;
        }
        if (!answer || !answer.task) {
          setFailure(translate("clickupTab.notFound"));
          return;
        }
        setDetail(answer);
      })
      .catch((error) => {
        if (!canceled) {
          setFailure(String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
        }
      });
    return () => {
      canceled = true;
    };
  }, [tab.target, reloadCounter, translate]);

  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(language || "en", { month: "short", day: "numeric", year: "numeric" }), [language]);
  const task = detail ? detail.task : null;
  const descriptionHtml = useMemo(() => (task && task.description ? renderMarkdown(task.description) : ""), [task]);
  const url = task ? task.url : `https://app.clickup.com/t/${tab.target}`;

  return (
    <div className={active ? "panel-tab-content panel-reading clickup-tab" : "panel-tab-content panel-reading clickup-tab is-hidden"} data-clickup-tab={tab.target}>
      {failure && (
        <div className="panel-note is-error">
          {translate("clickupTab.loadFailed", { message: failure })}
          <button type="button" className="text-link" onClick={() => onOpenExternal(url)}>
            {translate("projects.openInClickup")}
          </button>
        </div>
      )}
      {!task && !failure && <div className="panel-note">{translate("panel.loading")}</div>}
      {task && (
        <article className="clickup-task">
          <div className="clickup-task-pills">
            <span className="task-status" style={{ "--status-color": task.statusColor || "var(--accent)" }}>
              {task.status || "—"}
            </span>
            {task.listName && <span className="source-chip">{task.listName}</span>}
            <span className="project-header-spacer" />
            <button type="button" className="clickup-open-button" onClick={() => onOpenExternal(url)} data-open-in-clickup>
              {translate("projects.openInClickup")}
            </button>
          </div>
          <h2 className="clickup-task-title">{task.name}</h2>
          <div className="clickup-task-fields">
            <span className="detail-key">{translate("projects.assignee")}</span>
            <span>{task.assignees.length > 0 ? task.assignees.map((person) => person.name).join(", ") : translate("projects.nobody")}</span>
            <span className="detail-key">{translate("projects.due")}</span>
            <span>{task.dueDate ? dateFormatter.format(new Date(task.dueDate)) : "—"}</span>
            {task.customFields
              .filter((field) => typeof field.value === "string" || typeof field.value === "number")
              .map((field) => (
                <FieldValue key={field.name} field={field} onOpenExternal={onOpenExternal} />
              ))}
          </div>
          <h4>{translate("clickupTab.description")}</h4>
          {descriptionHtml ? (
            <div className="markdown" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
          ) : (
            <p className="project-dim">{translate("projects.noDescription")}</p>
          )}
          <h4>{translate("clickupTab.comments", { count: detail.comments.length })}</h4>
          {detail.comments.length === 0 && <p className="project-dim">{translate("clickupTab.noComments")}</p>}
          {detail.comments.map((comment) => (
            <div key={comment.id} className="clickup-comment">
              <b>{comment.author.name}</b>
              {comment.createdAt ? ` · ${dateFormatter.format(new Date(comment.createdAt))}` : ""} — {comment.text}
            </div>
          ))}
          <p className="clickup-read-only">{translate("clickupTab.readOnly")}</p>
        </article>
      )}
    </div>
  );
}

function FieldValue({ field, onOpenExternal }) {
  const text = String(field.value);
  const isLink = /^https?:\/\//.test(text);
  return (
    <>
      <span className="detail-key">{field.name}</span>
      {isLink ? (
        <button type="button" className="text-link detail-value" title={text} onClick={() => onOpenExternal(text)}>
          {text.replace(/^https?:\/\//, "")}
        </button>
      ) : (
        <span className="detail-value">{text}</span>
      )}
    </>
  );
}
