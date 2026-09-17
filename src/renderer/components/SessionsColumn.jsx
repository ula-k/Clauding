import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation, LANGUAGES } from "../i18n.js";
import SessionRow from "./SessionRow.jsx";
import GroupHeader from "./GroupHeader.jsx";
import { SearchIcon, PlusIcon, EyeIcon, ChevronRightIcon } from "./Icons.jsx";
import NewSessionSheet from "./NewSessionSheet.jsx";
import AgentsTab from "./AgentsTab.jsx";
import AgentForm from "./AgentForm.jsx";
import { buildGroupedList, groupIdForSession } from "../sessionGrouping.js";
import { hasChosenColor, sessionColorToken } from "../sessionColors.js";
import { commandKeyPressed } from "../platform.js";

// The left column: two tabs. "Sessions" is the user's own groups, each a header
// with plain name-only rows under it and a single "Hidden (N)" line at the
// very bottom; "Agents" is the agents the user defined, one row each.
//
// Both sheets that can cover this column live here: the "+ New" sheet (whose
// open state belongs to App, because starting a session closes it) and the
// agent form, which is only ever opened from this column.
export default function SessionsColumn({
  sessions,
  loading,
  error,
  hasMore,
  onShowMore,
  selectedSessionId,
  onSelectSession,
  now,
  newSheetOpen,
  newSheetGroupId,
  newSheetAgentId,
  onOpenNewSheet,
  onCloseNewSheet,
  onConfirmNewSession,
  groupState,
  groupActions,
  agentSessions,
  agents,
  menuAgents,
  agentActions,
  sessionAgents,
  onRenameSession,
  onDeleteSession,
  definitionSuggestions,
  onDismissSuggestion,
  onCreateAgentFromSession,
  onHarvestSkillsFromSession,
  onEditSessionFlags,
  onReadAgentDefinition,
  // Several rows at once: the ids picked out, what a click on a row means,
  // and the four things the bulk menu does with them.
  selectedSessionIds = [],
  onRowClick,
  onSetSessionColor,
  onSelectAllVisible,
  onClearSelection,
  bulkActions
}) {
  const { translate, language, setLanguage } = useTranslation();
  const [activeTab, setActiveTab] = useState("sessions");
  // null when the agent form is closed; otherwise which agent it edits
  // (null id = a new one) and whether the "+ New" sheet should come back
  // afterwards, which is what "Add agent…" inside that sheet does.
  const [agentFormState, setAgentFormState] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const listRef = useRef(null);
  const lastSearchTextRef = useRef(searchText);

  const { buckets, hiddenSessions, visibleCount } = useMemo(
    () =>
      buildGroupedList({
        sessions,
        groups: groupState.groups,
        membership: groupState.membership,
        hidden: groupState.hidden,
        collapsed: groupState.collapsed,
        searchText
      }),
    [sessions, groupState, searchText]
  );

  // The rows as they are drawn, top to bottom: that is the order a
  // Shift-click takes its range from, and what ⌘A picks out. A collapsed
  // group draws no rows, so nothing of it is in here; the hidden ones only
  // count while the "Hidden (N)" line is open.
  const visibleOrder = useMemo(() => {
    const order = [];
    for (const bucket of buckets) {
      if (bucket.collapsed) {
        continue;
      }
      for (const session of bucket.sessions) {
        order.push(session.sessionId);
      }
    }
    if (hiddenExpanded) {
      for (const session of hiddenSessions) {
        order.push(session.sessionId);
      }
    }
    return order;
  }, [buckets, hiddenSessions, hiddenExpanded]);

  const pickedIds = useMemo(() => new Set(selectedSessionIds || []), [selectedSessionIds]);
  const selectionCount = pickedIds.size;
  // Only a real selection — two rows or more — turns the row menus into the
  // bulk one; one picked row is just the row it always was.
  const bulkMenu = selectionCount > 1 && bulkActions ? { count: selectionCount, ...bulkActions } : null;
  const storedColors = groupState.colors || {};

  // The colour a row's name is drawn in, and whether the menu should tick
  // "Automatic" rather than one of the swatches.
  function rowColorProps(sessionId) {
    return {
      colorToken: sessionColorToken(sessionId, storedColors),
      colorIsAutomatic: !hasChosenColor(sessionId, storedColors)
    };
  }

  // A search puts the selection away: the rows it narrows the list to are
  // not the rows that were picked out, and a bulk action must never reach a
  // row nobody can see any more.
  useEffect(() => {
    if (lastSearchTextRef.current === searchText) {
      return;
    }
    lastSearchTextRef.current = searchText;
    onClearSelection();
  }, [searchText, onClearSelection]);

  // ⌘A picks out every row on screen, but only while the list has the
  // keyboard: the same keys belong to the terminal and to every text field
  // in the window, and neither should lose them to this.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== "a" && event.key !== "A") {
        return;
      }
      if (!commandKeyPressed(event) || event.shiftKey || event.altKey) {
        return;
      }
      const list = listRef.current;
      if (!list || !document.activeElement || !list.contains(document.activeElement)) {
        return;
      }
      event.preventDefault();
      onSelectAllVisible(visibleOrder);
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [visibleOrder, onSelectAllVisible]);

  function confirmNewGroup() {
    const trimmed = newGroupName.trim();
    setCreatingGroup(false);
    setNewGroupName("");
    if (trimmed) {
      groupActions.createGroup(trimmed);
    }
  }

  return (
    <div className="column column-left">
      <div className="left-header">
        <div className="left-header-row">
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={activeTab === "sessions" ? "tab is-active" : "tab"}
              onClick={() => setActiveTab("sessions")}
              data-sessions-tab
            >
              {translate("tabs.sessions")}
            </button>
            <button
              type="button"
              role="tab"
              className={activeTab === "agents" ? "tab is-active" : "tab"}
              onClick={() => setActiveTab("agents")}
              data-agents-tab
            >
              {translate("tabs.agents")}
            </button>
          </div>
          <button type="button" className="button is-primary new-button" onClick={() => onOpenNewSheet(null, null)} data-new-button>
            <PlusIcon />
            {translate("newSession.button")}
          </button>
        </div>
        {newSheetOpen && !agentFormState && (
          <NewSessionSheet
            sessions={sessions}
            agents={agents}
            initialAgentId={newSheetAgentId}
            groupName={
              newSheetGroupId
                ? (groupState.groups.find((group) => group.id === newSheetGroupId) || { name: null }).name ||
                  translate("groups.default")
                : null
            }
            onConfirm={onConfirmNewSession}
            onClose={onCloseNewSheet}
            onAddAgentRequested={() => {
              onCloseNewSheet();
              setAgentFormState({ agentId: null, returnToNewSession: true });
            }}
          />
        )}
        {agentFormState && (
          <AgentForm
            agent={agents.find((agent) => agent.id === agentFormState.agentId) || null}
            initialFolder={agentFormState.folder || null}
            onClose={() => setAgentFormState(null)}
            onSave={async (draft) => {
              const returning = agentFormState.returnToNewSession;
              const saved = agentFormState.agentId
                ? await agentActions.updateAgent(agentFormState.agentId, draft)
                : await agentActions.addAgent(draft);
              if (agentFormState.folder && onDismissSuggestion) {
                onDismissSuggestion(agentFormState.folder);
              }
              setAgentFormState(null);
              if (returning) {
                onOpenNewSheet(newSheetGroupId, saved ? saved.id : null);
              }
            }}
          />
        )}
        {activeTab === "sessions" && (
          <div className="search-box">
            <SearchIcon />
            <input
              type="search"
              value={searchText}
              placeholder={
                selectionCount > 1 && !searchText
                  ? translate("row.selectedCount", { count: selectionCount })
                  : translate("search.placeholder")
              }
              onChange={(event) => setSearchText(event.target.value)}
              spellCheck={false}
            />
          </div>
        )}
      </div>

      {activeTab === "agents" ? (
        <AgentsTab
          agents={agents}
          sessions={agentSessions || sessions}
          sessionAgents={sessionAgents}
          sessionColors={storedColors}
          hiddenSessionIds={groupState.hidden}
          selectedSessionId={selectedSessionId}
          onSelectSession={onSelectSession}
          now={now}
          onStartSession={(agentId) => onOpenNewSheet(null, agentId)}
          onAddAgent={() => setAgentFormState({ agentId: null, returnToNewSession: false })}
          onEditAgent={(agentId) => setAgentFormState({ agentId, returnToNewSession: false })}
          onDeleteAgent={agentActions.deleteAgent}
          onRestoreBuiltin={agentActions.restoreBuiltin}
          onReadDefinition={onReadAgentDefinition}
          definitionSuggestions={definitionSuggestions}
          onAddSuggestion={(suggestion) =>
            setAgentFormState({ agentId: null, returnToNewSession: false, folder: suggestion })
          }
          onDismissSuggestion={onDismissSuggestion}
        />
      ) : (
        <div className="session-list" ref={listRef} data-session-list>
          {loading && sessions.length === 0 && <div className="list-note">{translate("list.loading")}</div>}
          {error && <div className="list-note">{translate("list.error")}</div>}
          {!loading && !error && visibleCount === 0 && searchText && <div className="list-note">{translate("list.empty")}</div>}
          {creatingGroup ? (
            <input
              type="text"
              className="new-group-input"
              value={newGroupName}
              autoFocus
              placeholder={translate("groups.namePlaceholder")}
              onChange={(event) => setNewGroupName(event.target.value)}
              onBlur={confirmNewGroup}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  confirmNewGroup();
                } else if (event.key === "Escape") {
                  setCreatingGroup(false);
                  setNewGroupName("");
                }
              }}
            />
          ) : (
            <button type="button" className="new-group-button" onClick={() => setCreatingGroup(true)} data-new-group>
              <PlusIcon />
              {translate("groups.add")}
            </button>
          )}

          {buckets.map((bucket, bucketIndex) => (
            <section key={bucket.group.id} className="group-section">
              <GroupHeader
                group={bucket.group}
                count={bucket.sessions.length}
                isFirst={bucketIndex === 0}
                isLast={bucketIndex >= buckets.length - 2}
                collapsed={bucket.collapsed}
                hasRunning={bucket.hasRunning}
                hasNeedsAnswer={bucket.hasNeedsAnswer}
                onToggleCollapsed={groupActions.setGroupCollapsed}
                onRename={groupActions.renameGroup}
                onMove={groupActions.moveGroup}
                onDelete={groupActions.deleteGroup}
                onNewSessionInGroup={onOpenNewSheet}
                onDropSession={groupActions.assignSession}
              />
              {bucket.collapsed ? null : bucket.sessions.length === 0 ? (
                <div className="group-empty">{translate("groups.empty")}</div>
              ) : (
                bucket.sessions.map((session) => (
                  <SessionRow
                    key={session.sessionId}
                    session={session}
                    isSelected={session.sessionId === selectedSessionId}
                    isMultiSelected={pickedIds.has(session.sessionId)}
                    bulk={bulkMenu}
                    onSelect={(sessionId, modifiers) => onRowClick(sessionId, modifiers, visibleOrder)}
                    now={now}
                    groups={groupState.groups}
                    currentGroupId={groupIdForSession(session.sessionId, groupState.membership, groupState.groups)}
                    onMoveToGroup={groupActions.assignSession}
                    onHide={groupActions.hideSession}
                    onUnhide={groupActions.unhideSession}
                    onRenameSession={onRenameSession}
                    onDeleteSession={onDeleteSession}
                    agents={menuAgents || agents}
                    currentAgentId={session.agent ? session.agent.id : null}
                    onAssignAgent={agentActions.assignSession}
                    onCreateAgent={onCreateAgentFromSession}
                    onHarvestSkills={onHarvestSkillsFromSession}
                    onEditSessionFlags={onEditSessionFlags}
                    onSetColor={onSetSessionColor}
                    {...rowColorProps(session.sessionId)}
                  />
                ))
              )}
            </section>
          ))}

          {hiddenSessions.length > 0 && (
            <div className="hidden-section">
              <button
                type="button"
                className={hiddenExpanded ? "hidden-toggle is-expanded" : "hidden-toggle"}
                onClick={() => setHiddenExpanded(!hiddenExpanded)}
                data-hidden-toggle
              >
                <ChevronRightIcon />
                <EyeIcon />
                {translate("groups.hiddenCount", { count: hiddenSessions.length })}
              </button>
              {hiddenExpanded &&
                hiddenSessions.map((session) => (
                  <SessionRow
                    key={session.sessionId}
                    session={session}
                    isSelected={session.sessionId === selectedSessionId}
                    isMultiSelected={pickedIds.has(session.sessionId)}
                    bulk={bulkMenu}
                    onSelect={(sessionId, modifiers) => onRowClick(sessionId, modifiers, visibleOrder)}
                    now={now}
                    groups={groupState.groups}
                    currentGroupId={groupIdForSession(session.sessionId, groupState.membership, groupState.groups)}
                    onMoveToGroup={groupActions.assignSession}
                    onHide={groupActions.hideSession}
                    onUnhide={groupActions.unhideSession}
                    onRenameSession={onRenameSession}
                    onDeleteSession={onDeleteSession}
                    onSetColor={onSetSessionColor}
                    {...rowColorProps(session.sessionId)}
                    hiddenVariant
                  />
                ))}
            </div>
          )}

          {hasMore && !searchText && (
            <button type="button" className="show-more" onClick={onShowMore}>
              {translate("list.showMore")}
            </button>
          )}
        </div>
      )}

      <div className="left-footer">
        <span>{translate("language.label")}</span>
        <select className="language-select" value={language} onChange={(event) => setLanguage(event.target.value)}>
          {LANGUAGES.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
