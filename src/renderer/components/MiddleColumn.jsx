import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { folderLabel } from "../paths.js";
import TerminalPane from "./TerminalPane.jsx";
import DocumentReader from "./DocumentReader.jsx";
import { DotsIcon, FolderIcon, ForkIcon, PencilIcon, SparkIcon } from "./Icons.jsx";
import PopupMenu, { MenuItem, MenuLabel, MenuSeparator } from "./PopupMenu.jsx";
import { AgentChip } from "./AgentBadge.jsx";
import { titleWithoutAgentEmoji } from "../agentConstants.js";

// "Create agent from this conversation" and "Harvest skills": both fork the
// conversation into a second terminal that does one job — the Agent Maker
// distilling this conversation into a definition, or the skill-maker
// looking for the procedures in it. Neither can run before the CLI has
// registered a session id, because there is nothing to fork yet; until then
// the buttons are disabled and say why.
function MetaActionButtons({ sessionId, onCreateAgent, onHarvestSkills }) {
  const { translate } = useTranslation();
  const disabled = !sessionId;
  return (
    <>
      <button
        type="button"
        className="fork-button"
        disabled={disabled}
        title={translate(disabled ? "meta.waitForSession" : "meta.createAgentTooltip")}
        onClick={onCreateAgent}
        data-create-agent-button
      >
        <SparkIcon />
        {translate("meta.createAgent")}
      </button>
      <button
        type="button"
        className="fork-button"
        disabled={disabled}
        title={translate(disabled ? "meta.waitForSession" : "meta.harvestSkillsTooltip")}
        onClick={onHarvestSkills}
        data-harvest-skills-button
      >
        {translate("meta.harvestSkills")}
      </button>
    </>
  );
}

// The header's own "…": which agent this session is assigned to, and the
// two meta actions again, for the people who look for them in a menu.
function HeaderMenuButton({ sessionId, agents, currentAgentId, onAssignAgent, onCreateAgent, onHarvestSkills }) {
  const { translate } = useTranslation();
  const [menuAnchor, setMenuAnchor] = useState(null);
  const menuButtonRef = useRef(null);
  return (
    <>
      <button
        type="button"
        className="row-menu-button is-header"
        ref={menuButtonRef}
        title={translate("header.menu")}
        aria-label={translate("header.menu")}
        data-header-menu-button
        onClick={() => setMenuAnchor(menuButtonRef.current.getBoundingClientRect())}
      >
        <DotsIcon />
      </button>
      {menuAnchor && (
        <PopupMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)}>
          <MenuLabel>{translate("row.assignToAgent")}</MenuLabel>
          {agents.map((agent) => (
            <MenuItem
              key={agent.id}
              selected={agent.id === currentAgentId}
              onClick={() => {
                setMenuAnchor(null);
                onAssignAgent(sessionId, agent.id);
              }}
            >
              {`${agent.emoji} ${agent.name}`}
            </MenuItem>
          ))}
          <MenuItem
            selected={!currentAgentId}
            onClick={() => {
              setMenuAnchor(null);
              onAssignAgent(sessionId, null);
            }}
          >
            {translate("row.noAgent")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={!sessionId}
            onClick={() => {
              setMenuAnchor(null);
              onCreateAgent();
            }}
          >
            {translate("meta.createAgentLong")}
          </MenuItem>
          <MenuItem
            disabled={!sessionId}
            onClick={() => {
              setMenuAnchor(null);
              onHarvestSkills();
            }}
          >
            {translate("meta.harvestSkills")}
          </MenuItem>
        </PopupMenu>
      )}
    </>
  );
}

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

// A fork opened to do one job types its own first message. When the CLI
// never got to its prompt in time (a dialog nobody answered, a slow start),
// nothing was typed — and the header says so, because otherwise the
// terminal just sits there looking idle.
function KickoffHint({ terminal }) {
  const { translate } = useTranslation();
  if (!terminal || terminal.kickoffState !== "needsMessage") {
    return null;
  }
  return (
    <span className="kickoff-hint" data-kickoff-hint>
      {translate("kickoff.typeToStart")}
    </span>
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

export default function MiddleColumn({
  session,
  terminal,
  agent,
  agents,
  panelOpen,
  onTogglePanel,
  onRename,
  onFork,
  onAssignAgent,
  onCreateAgent,
  onHarvestSkills,
  reader,
  onCloseReader,
  onOpenReaderInPanel,
  windowTools
}) {
  const { translate } = useTranslation();
  const mode = columnMode({ session, terminal });
  const sessionId = (terminal && terminal.sessionId) || (session && session.sessionId) || null;
  // With the reader open the window tools move into its header, so they are
  // rendered once and stay in the same corner of the window.
  const readerPane = reader ? (
    <DocumentReader reader={reader} onClose={onCloseReader} onOpenInPanel={onOpenReaderInPanel} windowTools={windowTools} />
  ) : null;
  const underTools = reader ? null : windowTools;

  if (!session && !terminal) {
    return (
      <div className="column column-middle">
        {readerPane}
        {!reader && (
          <>
            <div className="middle-tools">{underTools}</div>
            <div className="middle-centred">
              <div className="empty-card">
                <div className="empty-icon">✿</div>
                {translate("transcript.empty")}
              </div>
            </div>
          </>
        )}
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
        {readerPane}
        {!reader && (
          <>
            <div className="middle-tools">{underTools}</div>
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
          </>
        )}
      </div>
    );
  }

  const projectColorIndex = session ? session.projectColorIndex : 0;

  // The terminal stays mounted while the reader is on top of it: unmounting
  // TerminalPane would detach the xterm instance and the scrollback would
  // scroll back into view from the top. Only its wrapper is hidden.
  return (
    <div className="column column-middle">
      {readerPane}
      <div className={reader ? "terminal-stack is-hidden" : "terminal-stack"} data-terminal-stack={reader ? "hidden" : "shown"}>
        <header className="transcript-header">
          <div className="header-top">
            <EditableTitle title={title} onRename={session ? onRename : null} />
            <AgentChip agent={agent} />
            <StatusPill statusGroup={terminalStatusGroup(terminal, session)} />
            <KickoffHint terminal={terminal} />
            {onFork && terminal.sessionId && <ForkButton onFork={onFork} />}
            <MetaActionButtons sessionId={sessionId} onCreateAgent={onCreateAgent} onHarvestSkills={onHarvestSkills} />
            <HeaderMenuButton
              sessionId={sessionId}
              agents={agents || []}
              currentAgentId={agent ? agent.id : null}
              onAssignAgent={onAssignAgent}
              onCreateAgent={onCreateAgent}
              onHarvestSkills={onHarvestSkills}
            />
            {underTools}
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
    </div>
  );
}
