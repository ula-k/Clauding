import { useEffect, useState } from "react";
import { useTranslation } from "../i18n.js";
import { folderLabel } from "../paths.js";
import TerminalPane from "./TerminalPane.jsx";
import { FolderIcon, ForkIcon, PencilIcon } from "./Icons.jsx";
import { AgentChip } from "./AgentBadge.jsx";
import { titleWithoutAgentEmoji } from "../agentConstants.js";

// "Start a copy of this conversation in a new terminal; this one stays as it
// is." Shown wherever a session id is known: in a live terminal's header, and
// on the note for a session running in a terminal or job outside the app —
// forking is the one useful thing that can be done with such a session.
function ForkButton({ onFork, standalone = false }) {
  const { translate } = useTranslation();
  return (
    <button
      type="button"
      className={standalone ? "fork-button is-standalone" : "fork-button"}
      title={translate("fork.tooltip")}
      onClick={onFork}
      data-fork-button
    >
      <ForkIcon />
      {translate("fork.button")}
    </button>
  );
}

function StatusPill({ statusGroup }) {
  const { translate } = useTranslation();
  if (statusGroup === "running") {
    return <span className="status-pill is-running">{translate("status.running")}</span>;
  }
  if (statusGroup === "waiting") {
    return <span className="status-pill is-waiting">{translate("status.waiting")}</span>;
  }
  return <span className="status-pill">{translate("status.idle")}</span>;
}

function EditableTitle({ title, onRename }) {
  const { translate } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);

  useEffect(() => {
    if (!editing) {
      setDraftTitle(title);
    }
  }, [title, editing]);

  function commit() {
    const trimmed = draftTitle.trim();
    setEditing(false);
    if (trimmed && trimmed !== title) {
      onRename(trimmed);
    }
  }

  if (editing) {
    return (
      <input
        type="text"
        className="title-input"
        value={draftTitle}
        autoFocus
        onChange={(event) => setDraftTitle(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          } else if (event.key === "Escape") {
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <h1
      title={onRename ? translate("header.renameHint") : undefined}
      className={onRename ? "is-editable" : ""}
      onClick={() => onRename && setEditing(true)}
    >
      {title}
      {onRename && <PencilIcon />}
    </h1>
  );
}

// What the middle column shows:
//   "terminal"   a live terminal of this app (new, or resumed here)
//   "elsewhere"  a terminal or job outside the app owns the session: a short
//                note and nothing else — this window is for talking, and that
//                conversation is not ours to talk in
//   "opening"    the click's terminal is still being spawned (or spawning
//                failed, which also raises an alert)
function columnMode({ session, terminal }) {
  if (terminal) {
    return "terminal";
  }
  if (session && session.liveStatus && session.liveStatus.source !== "app") {
    return "elsewhere";
  }
  return "opening";
}

function terminalStatusGroup(terminal, session) {
  if (session && session.ownedByApp) {
    return session.statusGroup;
  }
  return terminal.registryStatus === "idle" ? "waiting" : "running";
}

export default function MiddleColumn({ session, terminal, agent, panelOpen, onTogglePanel, onRename, onFork }) {
  const { translate } = useTranslation();
  const mode = columnMode({ session, terminal });

  if (!session && !terminal) {
    return (
      <div className="column column-middle">
        <div className="middle-centred">
          <div className="empty-card">
            <div className="empty-icon">✿</div>
            {translate("transcript.empty")}
          </div>
        </div>
      </div>
    );
  }

  // The chip next to it already carries the emoji, so the title does not.
  const title = titleWithoutAgentEmoji(session ? session.title : translate("newSession.untitled"), agent);
  const projectLabel = session ? session.projectLabel || session.projectName : folderLabel(terminal.workingDirectory);
  const workingDirectoryShort = session ? session.workingDirectoryShort : terminal.workingDirectory;

  if (mode !== "terminal") {
    return (
      <div className="column column-middle">
        <div className="middle-centred">
          <div className="elsewhere-note" data-elsewhere-note={mode === "elsewhere" ? "1" : "0"}>
            <div className="elsewhere-title">{title}</div>
            <div className="elsewhere-folder" title={workingDirectoryShort}>
              <FolderIcon />
              {projectLabel}
            </div>
            <p className="elsewhere-text">
              {mode === "elsewhere" ? translate("middle.runningElsewhere") : translate("middle.opening")}
            </p>
            {mode === "elsewhere" && onFork && session && session.sessionId && <ForkButton onFork={onFork} standalone />}
          </div>
        </div>
      </div>
    );
  }

  const projectColorIndex = session ? session.projectColorIndex : 0;

  return (
    <div className="column column-middle">
      <header className="transcript-header">
        <div className="header-top">
          <EditableTitle title={title} onRename={session ? onRename : null} />
          <AgentChip agent={agent} />
          <StatusPill statusGroup={terminalStatusGroup(terminal, session)} />
          {onFork && terminal.sessionId && <ForkButton onFork={onFork} />}
          <button type="button" className="panel-toggle" onClick={onTogglePanel}>
            {panelOpen ? translate("panel.hide") : translate("panel.show")}
          </button>
        </div>
        <div className="header-meta">
          <span className="meta-item" title={workingDirectoryShort}>
            <span className="project-dot" style={{ background: `var(--project-color-${projectColorIndex})` }} />
            <FolderIcon />
            {projectLabel}
          </span>
          {session && session.gitBranch && (
            <span className="meta-item">
              <span className="meta-label">{translate("header.branch")}</span>
              <code>{session.gitBranch}</code>
            </span>
          )}
        </div>
      </header>
      <TerminalPane terminalId={terminal.terminalId} />
    </div>
  );
}
