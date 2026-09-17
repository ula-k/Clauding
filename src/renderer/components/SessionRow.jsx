import { useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { relativeTime } from "../time.js";
import { DotsIcon } from "./Icons.jsx";
import PopupMenu, { MenuItem, MenuLabel, MenuSeparator, MenuSubmenu } from "./PopupMenu.jsx";
import ColorMenuItems from "./ColorMenu.jsx";
import TagMenuItems from "./TagMenu.jsx";
import { AgentBadge } from "./AgentBadge.jsx";
import { groupDisplayName } from "../groupConstants.js";
import { MENU_AGENT_LIMIT, titleWithoutAgentEmoji } from "../agentConstants.js";
import { commandKeyPressed, shortcutLabels } from "../platform.js";

export const SESSION_DRAG_TYPE = "application/x-clauding-session";

// "⌘⌫" on macOS, "Ctrl+Backspace" on Windows — the sentence around it is
// translated, only the keys change (src/renderer/platform.js).
const HIDE_SHORTCUT = { shortcut: shortcutLabels().hideSession };

// running -> working, waiting for you -> waiting, everything else -> idle.
// The row shows this as a color only; the words live in theme.css tokens.
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
//
// The **name is drawn in the session's own color** (the row menu's
// "Color", or one worked out from the session id), and a quiet session's
// name is faded; the **dot** says what the session is doing right now. Two
// signals, two places, and neither borrows the other's color.
//
// A session started with an agent shows that agent's emoji in a small
// neutral circle between the dot and the name (`session.agent`, attached in
// App.jsx).
//
// Clicking works like every list: a plain click selects this one row and
// opens its terminal, ⌘-click adds or removes a row, Shift-click takes the
// range from the last one. A modifier click never opens a terminal — five
// picked rows would be five `claude` processes.
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
  onEditSessionFlags,
  colorToken,
  hasOwnColor = false,
  onSetColor,
  // The user's own tags on this row: the ones it wears (whole tag objects,
  // drawn as pills after the name) and everything the "Tags ▸" submenu
  // needs — see TagMenu.jsx for the shape.
  tags = [],
  tagMenu = null,
  // Part of a selection of several rows: the row is drawn as picked out, and
  // its menu is the bulk one as soon as there are two or more.
  isMultiSelected = false,
  bulk = null,
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
  if (isMultiSelected) {
    rowClassNames.push("is-picked");
  }
  const bulkMenu = isMultiSelected && bulk && bulk.count > 1 ? bulk : null;
  // A hidden row has buttons instead of a menu — unless it is part of a
  // selection, where the right-click is the only way to the bulk menu.
  const rightClickOpensMenu = !hiddenVariant || Boolean(bulkMenu);

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
      onContextMenu={rightClickOpensMenu ? openMenuAtPointer : undefined}
    >
      <button
        type="button"
        className={rowClassNames.join(" ")}
        data-session-row={session.sessionId}
        data-status={statusName(session)}
        data-running-elsewhere={runsElsewhere ? "1" : "0"}
        onClick={(event) =>
          onSelect(session.sessionId, { toggle: commandKeyPressed(event), range: event.shiftKey })
        }
        title={session.workingDirectoryShort || session.projectLabel || ""}
        style={colorToken ? { "--session-color": `var(${colorToken})` } : undefined}
      >
        <span className="row-status-dot" />
        <AgentBadge agent={session.agent} />
        <span className="row-main">
          <span className="row-title">{titleWithoutAgentEmoji(session.title, session.agent)}</span>
          {session.needsAnswer && <span className="row-needs-answer">{translate("row.needsAnswer")}</span>}
          {tags.map((tag) => (
            <span className="tag-pill" key={tag.id} style={{ "--tag-color": `var(${tag.color})` }} data-row-tag={tag.id}>
              {tag.label}
            </span>
          ))}
        </span>
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
              title={runsElsewhere ? translate("row.deleteRunningElsewhere") : translate("row.deleteHint", HIDE_SHORTCUT)}
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
      {/* Two or more rows picked out: the menu is about all of them, and
          nothing in it is about this one row alone. */}
      {menuAnchor && bulkMenu && (
        <PopupMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)}>
          <MenuLabel>{translate("row.selectedCount", { count: bulkMenu.count })}</MenuLabel>
          <MenuItem
            marker="bulk-hide"
            title={translate("row.hideHint", HIDE_SHORTCUT)}
            onClick={() => {
              setMenuAnchor(null);
              bulkMenu.onHide();
            }}
          >
            {translate("row.hideMany", { count: bulkMenu.count })}
          </MenuItem>
          <MenuItem
            marker="bulk-delete"
            tone="danger"
            onClick={() => {
              setMenuAnchor(null);
              bulkMenu.onDelete();
            }}
          >
            {translate("row.deleteMany", { count: bulkMenu.count })}
          </MenuItem>
          <MenuSeparator />
          <MenuSubmenu label={translate("row.assignToAgent")} marker="bulk-assign-agent">
            <MenuLabel>{translate("row.assignToAgent")}</MenuLabel>
            <MenuItem
              marker="bulk-assign-none"
              onClick={() => {
                setMenuAnchor(null);
                bulkMenu.onAssignAgent(null);
              }}
            >
              {translate("row.noAgent")}
            </MenuItem>
            {agents.slice(0, MENU_AGENT_LIMIT).map((agent) => (
              <MenuItem
                key={agent.id}
                marker={`bulk-assign-${agent.id}`}
                onClick={() => {
                  setMenuAnchor(null);
                  bulkMenu.onAssignAgent(agent.id);
                }}
              >
                {`${agent.emoji} ${agent.name}`}
              </MenuItem>
            ))}
            {agents.length > MENU_AGENT_LIMIT && bulkMenu.onOpenAgentPicker && (
              <MenuItem
                marker="bulk-assign-more"
                onClick={() => {
                  setMenuAnchor(null);
                  bulkMenu.onOpenAgentPicker();
                }}
              >
                {translate("agents.more")}
              </MenuItem>
            )}
          </MenuSubmenu>
          <MenuSubmenu label={translate("row.moveTo")} marker="bulk-move-to-group">
            <MenuLabel>{translate("row.moveTo")}</MenuLabel>
            {groups.map((group) => (
              <MenuItem
                key={group.id}
                marker={`bulk-group-${group.id}`}
                onClick={() => {
                  setMenuAnchor(null);
                  bulkMenu.onMoveToGroup(group.id);
                }}
              >
                {groupDisplayName(group, translate)}
              </MenuItem>
            ))}
          </MenuSubmenu>
          {bulkMenu.tags && (
            <MenuSubmenu label={translate("tags.submenu")} marker="bulk-tags">
              <TagMenuItems
                tags={bulkMenu.tags.catalogue}
                tagState={bulkMenu.tags.stateForTag}
                onToggle={bulkMenu.tags.onToggle}
                onCreate={bulkMenu.tags.onCreate}
                onManage={() => {
                  setMenuAnchor(null);
                  bulkMenu.tags.onManage();
                }}
              />
            </MenuSubmenu>
          )}
          <MenuSubmenu label={translate("row.color")} marker="bulk-color">
            <MenuLabel>{translate("row.color")}</MenuLabel>
            <ColorMenuItems
              hasOwnColor={false}
              currentToken={null}
              onPick={(token) => {
                setMenuAnchor(null);
                bulkMenu.onSetColor(token);
              }}
            />
          </MenuSubmenu>
        </PopupMenu>
      )}
      {menuAnchor && !bulkMenu && (
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
          {onEditSessionFlags && (
            <>
              <MenuSeparator />
              <MenuItem
                marker="session-flags"
                onClick={() => {
                  setMenuAnchor(null);
                  onEditSessionFlags(session.sessionId);
                }}
              >
                {translate("flags.sessionMenu")}
              </MenuItem>
            </>
          )}
          {tagMenu && (
            <>
              <MenuSeparator />
              <MenuSubmenu label={translate("tags.submenu")} marker="session-tags">
                <TagMenuItems
                  tags={tagMenu.catalogue}
                  tagState={tagMenu.stateForTag}
                  onToggle={tagMenu.onToggle}
                  onCreate={tagMenu.onCreate}
                  onManage={() => {
                    setMenuAnchor(null);
                    tagMenu.onManage();
                  }}
                />
              </MenuSubmenu>
            </>
          )}
          {onSetColor && (
            <>
              <MenuSeparator />
              <MenuSubmenu label={translate("row.color")} marker="session-color">
                <MenuLabel>{translate("row.color")}</MenuLabel>
                <ColorMenuItems
                  currentToken={colorToken}
                  hasOwnColor={hasOwnColor}
                  onPick={(token) => {
                    setMenuAnchor(null);
                    onSetColor(session.sessionId, token);
                  }}
                />
              </MenuSubmenu>
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
            title={translate("row.hideHint", HIDE_SHORTCUT)}
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
              title={runsElsewhere ? translate("row.deleteRunningElsewhere") : translate("row.deleteHint", HIDE_SHORTCUT)}
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
