import { useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { relativeTime } from "../time.js";
import { DotsIcon } from "./Icons.jsx";
import PopupMenu, { MenuItem, MenuLabel, MenuSeparator } from "./PopupMenu.jsx";
import { AgentBadge } from "./AgentBadge.jsx";
import { groupDisplayName } from "../groupConstants.js";
import { MENU_AGENT_LIMIT, titleWithoutAgentEmoji } from "../agentConstants.js";

export const SESSION_DRAG_TYPE = "application/x-clauding-session";

// running -> working, waiting for you -> waiting, everything else -> idle.
// The row shows this as a colour only; the words live in theme.css tokens.
function statusName(session) {
  if (session.statusGroup === "running") {
    return "working";
  }
  if (session.statusGroup === "waiting") {
    return "waiting";
  }
  return "idle";
}

// One line: a status dot, the name, and a dim relative time. The folder is
// only in the tooltip — names, not a second line of noise.
// A session started with an agent shows that agent's emoji in a small
// coloured circle between the dot and the name (`session.agent`, attached in
// App.jsx); a session without one looks exactly as it always did.
export default function SessionRow({
  session,
  isSelected,
  onSelect,
  now,
  groups,
  currentGroupId,
  onMoveToGroup,
  onHide,
  onUnhide,
  onRenameSession,
  onDeleteSession,
  agents = [],
  currentAgentId = null,
  onAssignAgent,
  onOpenAgentPicker,
  onCreateAgent,
  onHarvestSkills,
  hiddenVariant = false
}) {
  const { translate } = useTranslation();
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(session.title);
  const menuButtonRef = useRef(null);

  const runsElsewhere = Boolean(session.liveStatus && session.liveStatus.source !== "app");
  const rowClassNames = ["session-row", `is-${statusName(session)}`];
  if (session.agent) {
    rowClassNames.push("has-agent");
  }
  if (isSelected) {
    rowClassNames.push("is-selected");
  }

  function openMenuFromButton() {
    if (menuButtonRef.current) {
      setMenuAnchor(menuButtonRef.current.getBoundingClientRect());
    }
  }

  function openMenuAtPointer(event) {
    event.preventDefault();
    setMenuAnchor({ left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY });
  }

  function commitName() {
    const trimmed = draftName.trim();
    setEditingName(false);
    if (trimmed && trimmed !== session.title) {
      onRenameSession(session.sessionId, trimmed);
    }
  }

  if (editingName) {
    return (
      <div className="session-row-wrapper">
        <input
          type="text"
          className="row-rename-input"
          value={draftName}
          autoFocus
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitName();
            } else if (event.key === "Escape") {
              setEditingName(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={menuAnchor ? "session-row-wrapper has-menu" : "session-row-wrapper"}
      draggable={!hiddenVariant}
      onDragStart={(event) => {
        event.dataTransfer.setData(SESSION_DRAG_TYPE, session.sessionId);
        event.dataTransfer.setData("text/plain", session.sessionId);
        event.dataTransfer.effectAllowed = "move";
      }}
      onContextMenu={hiddenVariant ? undefined : openMenuAtPointer}
    >
      <button
        type="button"
        className={rowClassNames.join(" ")}
        data-session-row={session.sessionId}
        data-status={statusName(session)}
        data-running-elsewhere={runsElsewhere ? "1" : "0"}
        onClick={() => onSelect(session.sessionId)}
        title={session.workingDirectoryShort || session.projectLabel || ""}
      >
        <span className="row-status-dot" />
        <AgentBadge agent={session.agent} />
        <span className="row-title">{titleWithoutAgentEmoji(session.title, session.agent)}</span>
        {session.needsAnswer && <span className="row-needs-answer">{translate("row.needsAnswer")}</span>}
        <span className="row-time">{relativeTime(session.lastModified, translate, now)}</span>
      </button>
      {hiddenVariant ? (
        <div className="row-hidden-actions">
          <button type="button" className="row-unhide" onClick={() => onUnhide(session.sessionId)}>
            {translate("row.unhide")}
          </button>
          {onDeleteSession && (
            <button
              type="button"
              className="row-delete"
              disabled={runsElsewhere}
              title={runsElsewhere ? translate("row.deleteRunningElsewhere") : translate("row.deleteHint")}
              data-row-delete={session.sessionId}
              onClick={() => onDeleteSession(session.sessionId)}
            >
              {translate("row.deleteConfirmButton")}
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="row-menu-button"
          ref={menuButtonRef}
          title={translate("row.menu")}
          aria-label={translate("row.menu")}
          data-row-menu-button={session.sessionId}
          onClick={openMenuFromButton}
        >
          <DotsIcon />
        </button>
      )}
      {menuAnchor && (
        <PopupMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)}>
          <MenuLabel>{translate("row.moveTo")}</MenuLabel>
          {groups.map((group) => (
            <MenuItem
              key={group.id}
              selected={group.id === currentGroupId}
              onClick={() => {
                setMenuAnchor(null);
                onMoveToGroup(session.sessionId, group.id);
              }}
            >
              {groupDisplayName(group, translate)}
            </MenuItem>
          ))}
          {onAssignAgent && (
            <>
              <MenuSeparator />
              <MenuLabel>{translate("row.assignToAgent")}</MenuLabel>
              <MenuItem
                marker="assign-none"
                selected={!currentAgentId}
                onClick={() => {
                  setMenuAnchor(null);
                  onAssignAgent(session.sessionId, null);
                }}
              >
                {translate("row.noAgent")}
              </MenuItem>
              {agents.slice(0, MENU_AGENT_LIMIT).map((agent) => (
                <MenuItem
                  key={agent.id}
                  marker={`assign-${agent.id}`}
                  selected={agent.id === currentAgentId}
                  onClick={() => {
                    setMenuAnchor(null);
                    onAssignAgent(session.sessionId, agent.id);
                  }}
                >
                  {`${agent.emoji} ${agent.name}`}
                </MenuItem>
              ))}
              {agents.length > MENU_AGENT_LIMIT && onOpenAgentPicker && (
                <MenuItem
                  marker="assign-more"
                  onClick={() => {
                    setMenuAnchor(null);
                    onOpenAgentPicker(session.sessionId);
                  }}
                >
                  {translate("agents.more")}
                </MenuItem>
              )}
            </>
          )}
          {onCreateAgent && (
            <>
              <MenuSeparator />
              <MenuItem
                disabled={!session.sessionId}
                onClick={() => {
                  setMenuAnchor(null);
                  onCreateAgent(session.sessionId);
                }}
              >
                {translate("meta.createAgentLong")}
              </MenuItem>
              <MenuItem
                disabled={!session.sessionId}
                onClick={() => {
                  setMenuAnchor(null);
                  onHarvestSkills(session.sessionId);
                }}
              >
                {translate("meta.harvestSkills")}
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              setDraftName(session.title);
              setEditingName(true);
            }}
          >
            {translate("row.rename")}
          </MenuItem>
          <MenuItem
            marker="hide-session"
            title={translate("row.hideHint")}
            onClick={() => {
              setMenuAnchor(null);
              onHide(session.sessionId);
            }}
          >
            {translate("row.hide")}
          </MenuItem>
          {onDeleteSession && (
            <MenuItem
              marker="delete-session"
              tone="danger"
              disabled={runsElsewhere}
              title={runsElsewhere ? translate("row.deleteRunningElsewhere") : translate("row.deleteHint")}
              onClick={() => {
                setMenuAnchor(null);
                onDeleteSession(session.sessionId);
              }}
            >
              {translate("row.delete")}
            </MenuItem>
          )}
        </PopupMenu>
      )}
    </div>
  );
}
