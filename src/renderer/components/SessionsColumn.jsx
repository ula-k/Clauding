import { useMemo, useState } from "react";
import { useTranslation, LANGUAGES } from "../i18n.js";
import SessionRow from "./SessionRow.jsx";
import GroupHeader from "./GroupHeader.jsx";
import { SearchIcon, PlusIcon, EyeIcon, ChevronRightIcon } from "./Icons.jsx";
import NewSessionSheet from "./NewSessionSheet.jsx";
import AgentsTab from "./AgentsTab.jsx";
import AgentForm from "./AgentForm.jsx";
import { buildGroupedList, groupIdForSession } from "../sessionGrouping.js";

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
  onReadAgentDefinition
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
              placeholder={translate("search.placeholder")}
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
        <div className="session-list">
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
                    onSelect={onSelectSession}
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
                    onSelect={onSelectSession}
                    now={now}
                    groups={groupState.groups}
                    currentGroupId={groupIdForSession(session.sessionId, groupState.membership, groupState.groups)}
                    onMoveToGroup={groupActions.assignSession}
                    onHide={groupActions.hideSession}
                    onUnhide={groupActions.unhideSession}
                    onRenameSession={onRenameSession}
                    onDeleteSession={onDeleteSession}
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
