import { useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { ChevronRightIcon, DotsIcon, PlusIcon } from "./Icons.jsx";
import PopupMenu, { MenuItem, MenuSeparator } from "./PopupMenu.jsx";
import { DEFAULT_GROUP_ID, groupDisplayName } from "../groupConstants.js";
import { SESSION_DRAG_TYPE } from "./SessionRow.jsx";

// A group header never hides itself: it is the line sessions are dragged onto,
// so it has to stay where the user put it — even when the group is folded shut.
// Collapsed, the header is all there is of the group, so it also carries the
// two things nobody should miss: a "needs answer" badge and a running dot.
export default function GroupHeader({
  group,
  count,
  isFirst,
  isLast,
  collapsed,
  hasRunning,
  hasNeedsAnswer,
  onToggleCollapsed,
  onRename,
  onMove,
  onDelete,
  onNewSessionInGroup,
  onDropSession
}) {
  const { translate } = useTranslation();
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [isDropTarget, setIsDropTarget] = useState(false);
  const menuButtonRef = useRef(null);

  const name = groupDisplayName(group, translate);

  function closeMenu() {
    setMenuAnchor(null);
    setConfirmingDelete(false);
  }

  function commitName() {
    const trimmed = draftName.trim();
    setEditingName(false);
    if (trimmed && trimmed !== name) {
      onRename(group.id, trimmed);
    }
  }

  function carriesSession(event) {
    return Array.from(event.dataTransfer.types || []).includes(SESSION_DRAG_TYPE);
  }

  const headerClassNames = ["group-header"];
  if (isDropTarget) {
    headerClassNames.push("is-drop-target");
  }
  if (collapsed) {
    headerClassNames.push("is-collapsed");
  }

  return (
    <div
      className={headerClassNames.join(" ")}
      data-group-header={group.id}
      data-group-collapsed={collapsed ? "1" : "0"}
      onDragOver={(event) => {
        if (carriesSession(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setIsDropTarget(true);
        }
      }}
      onDragLeave={() => setIsDropTarget(false)}
      onDrop={(event) => {
        setIsDropTarget(false);
        const sessionId = event.dataTransfer.getData(SESSION_DRAG_TYPE);
        if (sessionId) {
          event.preventDefault();
          onDropSession(sessionId, group.id);
        }
      }}
    >
      <button
        type="button"
        className={collapsed ? "group-chevron is-collapsed" : "group-chevron"}
        title={collapsed ? translate("groups.expand") : translate("groups.collapse")}
        aria-label={collapsed ? translate("groups.expand") : translate("groups.collapse")}
        aria-expanded={!collapsed}
        data-group-chevron={group.id}
        onClick={() => onToggleCollapsed(group.id, !collapsed)}
      >
        <ChevronRightIcon />
      </button>
      {editingName ? (
        <input
          type="text"
          className="group-name-input"
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
      ) : (
        <>
          <span className="group-name">{name}</span>
          <span className="group-count">{count}</span>
          {collapsed && hasNeedsAnswer && <span className="group-needs-answer">{translate("row.needsAnswer")}</span>}
          {collapsed && hasRunning && (
            <span className="group-running-dot" title={translate("status.running")} aria-label={translate("status.running")} />
          )}
        </>
      )}
      <button
        type="button"
        className="group-action is-first-action"
        title={translate("groups.newSessionHere")}
        aria-label={translate("groups.newSessionHere")}
        data-group-new={group.id}
        onClick={() => onNewSessionInGroup(group.id)}
      >
        <PlusIcon />
      </button>
      <button
        type="button"
        className="group-action"
        ref={menuButtonRef}
        title={translate("groups.menu")}
        aria-label={translate("groups.menu")}
        data-group-menu-button={group.id}
        onClick={() => setMenuAnchor(menuButtonRef.current.getBoundingClientRect())}
      >
        <DotsIcon />
      </button>
      {menuAnchor && (
        <PopupMenu anchor={menuAnchor} onClose={closeMenu}>
          {confirmingDelete ? (
            <>
              <div className="popup-menu-note">{translate("groups.deleteConfirm", { name })}</div>
              <MenuItem
                tone="danger"
                onClick={() => {
                  closeMenu();
                  onDelete(group.id);
                }}
              >
                {translate("groups.deleteConfirmButton")}
              </MenuItem>
              <MenuItem onClick={() => setConfirmingDelete(false)}>{translate("terminal.cancel")}</MenuItem>
            </>
          ) : (
            <>
              <MenuItem
                onClick={() => {
                  closeMenu();
                  setDraftName(name);
                  setEditingName(true);
                }}
              >
                {translate("groups.rename")}
              </MenuItem>
              <MenuItem
                disabled={isFirst}
                onClick={() => {
                  closeMenu();
                  onMove(group.id, "up");
                }}
              >
                {translate("groups.moveUp")}
              </MenuItem>
              <MenuItem
                disabled={isLast}
                onClick={() => {
                  closeMenu();
                  onMove(group.id, "down");
                }}
              >
                {translate("groups.moveDown")}
              </MenuItem>
              {group.id !== DEFAULT_GROUP_ID && (
                <>
                  <MenuSeparator />
                  <MenuItem tone="danger" onClick={() => setConfirmingDelete(true)}>
                    {translate("groups.delete")}
                  </MenuItem>
                </>
              )}
            </>
          )}
        </PopupMenu>
      )}
    </div>
  );
}
