import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { definitionFolderLabel } from "../agentConstants.js";

// "More…" at the bottom of an "Assign to agent" menu: every agent there is,
// with a search box. Picking one only opens the usual assign question — this
// sheet writes nothing either.
export default function AgentPickerSheet({ agents, currentAgentId, onPick, onClose }) {
  const { translate } = useTranslation();
  const [searchText, setSearchText] = useState("");
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

  const query = searchText.trim().toLowerCase();
  const shown = query
    ? agents.filter((agent) => `${agent.emoji} ${agent.name} ${agent.definitionFolder}`.toLowerCase().includes(query))
    : agents;

  return (
    <div
      className="sheet-backdrop"
      data-agent-picker
      onMouseDown={(event) => {
        if (sheetRef.current && !sheetRef.current.contains(event.target)) {
          onClose();
        }
      }}
    >
      <div className="sheet agent-picker" ref={sheetRef} role="dialog" aria-modal="true">
        <div className="sheet-title">{translate("row.assignToAgent")}</div>
        <input
          type="text"
          className="scan-search"
          autoFocus
          placeholder={translate("agents.pickSearch")}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          data-agent-picker-search
        />
        <div className="agent-picker-list">
          {shown.length === 0 && <div className="list-note">{translate("agents.emojiNoMatch")}</div>}
          {shown.map((agent) => (
            <button
              type="button"
              key={agent.id}
              className={agent.id === currentAgentId ? "agent-picker-row is-selected" : "agent-picker-row"}
              data-agent-picker-row={agent.id}
              onClick={() => onPick(agent.id)}
            >
              <span className="agent-badge" style={{ "--agent-color": `var(${agent.color})` }}>
                {agent.emoji}
              </span>
              <span className="agent-picker-name">{agent.name}</span>
              <span className="agent-picker-folder">{definitionFolderLabel(agent.definitionFolder)}</span>
            </button>
          ))}
        </div>
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" onClick={onClose} data-agent-picker-close>
            {translate("agents.assignCancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
