import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { FolderIcon } from "./Icons.jsx";
import { folderLabel } from "../paths.js";

const ADD_AGENT_OPTION = "add-agent";
const NO_AGENT_OPTION = "";

// Small sheet under the "+ New" button: pick the working directory (a recent
// project folder or any other) and, if you like, the agent the session runs
// as. A terminal running `claude` then opens in that folder.
//
// `groupName` is set when the sheet was opened from a group header's "+":
// the new session then lands in that group instead of Default.
// `initialAgentId` is set when the sheet was opened from the Agents tab —
// nothing else preselects an agent, "No agent" is always the default.
export default function NewSessionSheet({
  sessions,
  agents,
  initialAgentId,
  groupName,
  onConfirm,
  onClose,
  onAddAgentRequested
}) {
  const { translate } = useTranslation();
  const [recentProjects, setRecentProjects] = useState([]);
  const [workingDirectory, setWorkingDirectory] = useState(null);
  const [agentId, setAgentId] = useState(initialAgentId || null);
  const sheetRef = useRef(null);

  // A folder that is not in ~/.claude.json yet (an agent's last one, or a
  // folder picked with "Other…") is put at the top of the list so it can be
  // seen and unpicked again.
  function rememberFolder(folderPath) {
    setRecentProjects((previous) =>
      previous.some((project) => project.path === folderPath)
        ? previous
        : [{ path: folderPath, pathShort: folderPath, label: folderLabel(folderPath), colorIndex: 0 }].concat(previous)
    );
  }

  useEffect(() => {
    window.clauding.listRecentProjects().then((projects) => {
      // The session list knows better than ~/.claude.json when a folder was
      // last used: take the newest session per folder into account.
      const newestSessionByFolder = new Map();
      for (const session of sessions || []) {
        const previous = newestSessionByFolder.get(session.workingDirectory) || 0;
        newestSessionByFolder.set(session.workingDirectory, Math.max(previous, session.lastModified || 0));
      }
      const sorted = projects
        .map((project) => ({ ...project, lastUsed: Math.max(project.lastUsed, newestSessionByFolder.get(project.path) || 0) }))
        .sort((first, second) => second.lastUsed - first.lastUsed);
      setRecentProjects(sorted);
      const startingAgent = (agents || []).find((agent) => agent.id === initialAgentId) || null;
      const preferred = startingAgent && startingAgent.lastWorkingDirectory ? startingAgent.lastWorkingDirectory : null;
      if (preferred) {
        setWorkingDirectory(preferred);
        rememberFolder(preferred);
      } else if (!workingDirectory && sorted.length > 0) {
        setWorkingDirectory(sorted[0].path);
      }
    });
    // Only on open: the list is a snapshot for this sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleMouseDown(event) {
      if (sheetRef.current && !sheetRef.current.contains(event.target)) {
        onClose();
      }
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "Enter" && workingDirectory) {
        onConfirm({ workingDirectory, agentId });
      }
    }
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, onConfirm, workingDirectory, agentId]);

  async function pickOther() {
    const picked = await window.clauding.pickProjectFolder();
    if (picked) {
      setWorkingDirectory(picked);
      rememberFolder(picked);
    }
  }

  // Picking an agent that has worked somewhere before moves the folder
  // selection there; the user can still change it afterwards.
  function chooseAgent(value) {
    if (value === ADD_AGENT_OPTION) {
      onAddAgentRequested();
      return;
    }
    const chosenId = value === NO_AGENT_OPTION ? null : value;
    setAgentId(chosenId);
    const chosen = (agents || []).find((agent) => agent.id === chosenId) || null;
    if (chosen && chosen.lastWorkingDirectory) {
      setWorkingDirectory(chosen.lastWorkingDirectory);
      rememberFolder(chosen.lastWorkingDirectory);
    }
  }

  return (
    <div className="new-session-sheet" ref={sheetRef} data-new-session-sheet>
      <div className="sheet-title">{translate("newSession.title")}</div>
      {groupName && <div className="sheet-group">{translate("newSession.inGroup", { name: groupName })}</div>}
      <div className="sheet-label">{translate("newSession.workingDirectory")}</div>
      <div className="sheet-folders">
        {recentProjects.length === 0 && <div className="list-note">{translate("newSession.noRecent")}</div>}
        {recentProjects.map((project) => (
          <button
            type="button"
            key={project.path}
            className={project.path === workingDirectory ? "sheet-folder is-selected" : "sheet-folder"}
            title={project.pathShort}
            onClick={() => setWorkingDirectory(project.path)}
            onDoubleClick={() => onConfirm({ workingDirectory: project.path, agentId })}
          >
            <FolderIcon />
            <span>{project.label}</span>
          </button>
        ))}
      </div>
      <button type="button" className="button is-ghost is-small sheet-other" onClick={pickOther}>
        {translate("newSession.other")}
      </button>
      <label className="sheet-label sheet-agent-label" htmlFor="new-session-agent">
        {translate("newSession.agent")}
      </label>
      <select
        id="new-session-agent"
        className="sheet-agent-select"
        value={agentId || NO_AGENT_OPTION}
        onChange={(event) => chooseAgent(event.target.value)}
        data-new-session-agent
      >
        <option value={NO_AGENT_OPTION}>{translate("newSession.noAgent")}</option>
        {(agents || []).map((agent) => (
          <option key={agent.id} value={agent.id}>
            {`${agent.emoji} ${agent.name}`}
          </option>
        ))}
        <option value={ADD_AGENT_OPTION}>{translate("newSession.addAgent")}</option>
      </select>
      <div className="sheet-hint">{translate("newSession.hint")}</div>
      <div className="sheet-actions">
        <button type="button" className="button is-ghost" onClick={onClose}>
          {translate("terminal.cancel")}
        </button>
        <button
          type="button"
          className="button is-primary"
          disabled={!workingDirectory}
          onClick={() => onConfirm({ workingDirectory, agentId })}
          data-new-confirm
        >
          {translate("newSession.confirm")}
        </button>
      </div>
    </div>
  );
}
