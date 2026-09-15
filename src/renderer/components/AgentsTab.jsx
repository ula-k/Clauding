import { useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { relativeTime } from "../time.js";
import { DotsIcon, PlusIcon } from "./Icons.jsx";
import PopupMenu, { MenuItem, MenuSeparator } from "./PopupMenu.jsx";
import { AgentBadge } from "./AgentBadge.jsx";
import { definitionFolderLabel, titleWithoutAgentEmoji } from "../agentConstants.js";
import { buildAgentSessionList } from "../sessionGrouping.js";

// running -> working, waiting for you -> waiting, everything else -> idle:
// the same three colours the session list uses.
function statusName(session) {
  if (session.statusGroup === "running") {
    return "working";
  }
  if (session.statusGroup === "waiting") {
    return "waiting";
  }
  return "idle";
}

// One session this agent started, under its row: the same status dot, name
// and right-aligned time as in the Sessions list, and the same click — the
// session opens in a terminal exactly as it would over there.
function AgentSessionRow({ session, isSelected, onSelect, now }) {
  const { translate } = useTranslation();
  const classNames = ["session-row", "agent-session-row", `is-${statusName(session)}`];
  if (isSelected) {
    classNames.push("is-selected");
  }
  return (
    <button
      type="button"
      className={classNames.join(" ")}
      data-session-row={session.sessionId}
      data-agent-session-row={session.sessionId}
      data-status={statusName(session)}
      title={session.workingDirectoryShort || session.projectLabel || ""}
      onClick={() => onSelect(session.sessionId)}
    >
      <span className="row-status-dot" />
      <span className="row-title">{titleWithoutAgentEmoji(session.title, session.agent)}</span>
      {session.needsAnswer && <span className="row-needs-answer">{translate("row.needsAnswer")}</span>}
      <span className="row-time">{relativeTime(session.lastModified, translate, now)}</span>
    </button>
  );
}

// One agent in the list: the emoji in its coloured circle, the name, and the
// dim definition folder under it. Clicking the row opens the "+ New" sheet
// with this agent already picked — the quickest way to put it to work.
function AgentRow({
  agent,
  sessions,
  hiddenCount,
  selectedSessionId,
  onSelectSession,
  now,
  onStartSession,
  onEdit,
  onDelete,
  onRestoreBuiltin
}) {
  const { translate } = useTranslation();
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuButtonRef = useRef(null);

  function closeMenu() {
    setMenuAnchor(null);
    setConfirmingDelete(false);
  }

  return (
    <div className={menuAnchor ? "agent-row-wrapper has-menu" : "agent-row-wrapper"}>
      <button
        type="button"
        className="agent-row"
        data-agent-row={agent.id}
        title={translate("agents.startSession")}
        onClick={() => onStartSession(agent.id)}
      >
        <AgentBadge agent={agent} />
        <span className="agent-row-text">
          <span className="agent-row-name">
            {agent.name}
            {agent.builtin && (
              <span className="agent-row-builtin" data-agent-builtin={agent.builtin}>
                {translate("agents.builtin")}
              </span>
            )}
            {sessions.length > 0 && <span className="agent-row-count" data-agent-session-count={agent.id}>{` · ${sessions.length}`}</span>}
          </span>
          <span className="agent-row-folder">{definitionFolderLabel(agent.definitionFolder)}</span>
        </span>
      </button>
      <button
        type="button"
        className="row-menu-button"
        ref={menuButtonRef}
        title={translate("agents.menu")}
        aria-label={translate("agents.menu")}
        data-agent-menu-button={agent.id}
        onClick={() => setMenuAnchor(menuButtonRef.current.getBoundingClientRect())}
      >
        <DotsIcon />
      </button>
      {menuAnchor && (
        <PopupMenu anchor={menuAnchor} onClose={closeMenu}>
          {confirmingDelete ? (
            <>
              <div className="popup-menu-note">{translate("agents.deleteConfirm", { name: agent.name })}</div>
              <MenuItem
                tone="danger"
                onClick={() => {
                  closeMenu();
                  onDelete(agent.id);
                }}
              >
                {translate("agents.deleteConfirmButton")}
              </MenuItem>
              <MenuItem onClick={() => setConfirmingDelete(false)}>{translate("terminal.cancel")}</MenuItem>
            </>
          ) : (
            <>
              <MenuItem
                onClick={() => {
                  closeMenu();
                  onEdit(agent.id);
                }}
              >
                {translate("agents.edit")}
              </MenuItem>
              <MenuSeparator />
              {/* An agent that came with the app cannot be deleted — it is
                  part of Clauding, not of the user's list. What it gets
                  instead is a way back to the definition the app ships. */}
              {agent.builtin ? (
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    onRestoreBuiltin();
                  }}
                >
                  {translate("agents.restoreBuiltin")}
                </MenuItem>
              ) : (
                <MenuItem tone="danger" onClick={() => setConfirmingDelete(true)}>
                  {translate("agents.delete")}
                </MenuItem>
              )}
            </>
          )}
        </PopupMenu>
      )}
      {(sessions.length > 0 || hiddenCount > 0) && (
        <div className="agent-session-list" data-agent-sessions={agent.id}>
          {sessions.map((session) => (
            <AgentSessionRow
              key={session.sessionId}
              session={session}
              isSelected={session.sessionId === selectedSessionId}
              onSelect={onSelectSession}
              now={now}
            />
          ))}
          {hiddenCount > 0 && (
            <div className="agent-session-hidden" data-agent-hidden-sessions={agent.id}>
              {translate("agents.hiddenSessions", { count: hiddenCount })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The left column's second tab. An agent is a name plus the folder it takes
// its information from — never the folder it works in; that one is picked
// per session in the "+ New" sheet.
export default function AgentsTab({
  agents,
  sessions,
  sessionAgents,
  hiddenSessionIds,
  selectedSessionId,
  onSelectSession,
  now,
  onStartSession,
  onAddAgent,
  onEditAgent,
  onDeleteAgent,
  onRestoreBuiltin,
  definitionSuggestions,
  onAddSuggestion,
  onDismissSuggestion
}) {
  const { translate } = useTranslation();
  return (
    <div className="agent-list">
      <button type="button" className="new-group-button" onClick={onAddAgent} data-add-agent>
        <PlusIcon />
        {translate("agents.add")}
      </button>
      {/* A definition folder that turned up under the agents root while the
          app was running — the Agent Maker just wrote one, most likely. One
          click fills the form with it. */}
      {(definitionSuggestions || []).map((suggestion) => (
        <div className="agent-suggestion" key={suggestion.definitionFolder} data-agent-suggestion={suggestion.definitionFolder}>
          <div className="agent-suggestion-text">
            <span className="agent-suggestion-title">{translate("agents.definitionFound")}</span>
            {/* The name is taken from the file's heading, which often ends
                in the same emoji — do not print it twice. */}
            <span className="agent-suggestion-name">
              {suggestion.name.includes(suggestion.emoji) ? suggestion.name : `${suggestion.emoji} ${suggestion.name}`}
            </span>
            <span className="agent-suggestion-folder">{definitionFolderLabel(suggestion.definitionFolder)}</span>
          </div>
          <div className="agent-suggestion-actions">
            <button
              type="button"
              className="button is-primary is-small"
              onClick={() => onAddSuggestion(suggestion)}
              data-agent-suggestion-add
            >
              {translate("agents.addAsAgent")}
            </button>
            <button type="button" className="button is-ghost is-small" onClick={() => onDismissSuggestion(suggestion)}>
              {translate("agents.dismiss")}
            </button>
          </div>
        </div>
      ))}
      {agents.length === 0 ? (
        <div className="list-note">{translate("agents.empty")}</div>
      ) : (
        agents.map((agent) => {
          const own = buildAgentSessionList({
            sessions,
            agentId: agent.id,
            sessionAgents,
            hidden: hiddenSessionIds
          });
          return (
            <AgentRow
              key={agent.id}
              agent={agent}
              sessions={own.sessions}
              hiddenCount={own.hiddenCount}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              now={now}
              onStartSession={onStartSession}
              onEdit={onEditAgent}
              onDelete={onDeleteAgent}
              onRestoreBuiltin={onRestoreBuiltin}
            />
          );
        })
      )}
    </div>
  );
}
