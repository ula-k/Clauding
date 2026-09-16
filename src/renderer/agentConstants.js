// The eight colours an agent can wear. They are the same tokens the project
// dots use (theme.css), repeated here so the renderer does not import from
// the Electron side — electron/agents.js keeps the identical list and is the
// one that decides what may be stored.
export const AGENT_COLOR_TOKENS = [
  "--project-color-0",
  "--project-color-1",
  "--project-color-2",
  "--project-color-3",
  "--project-color-4",
  "--project-color-5",
  "--project-color-6",
  "--project-color-7"
];

export const DEFAULT_AGENT_EMOJI = "✦";
export const DEFAULT_AGENT_COLOR = AGENT_COLOR_TOKENS[0];

// "…/agenci/spec-writer" — the last two parts of the definition folder, the
// dim second line of an agent row.
export function definitionFolderLabel(definitionFolder) {
  const parts = String(definitionFolder || "").split("/").filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  return `…/${parts.slice(-2).join("/")}`;
}

export function fileNameOf(filePath) {
  const parts = String(filePath || "").split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

// A session started as an agent is named "<emoji> <agent name>" by the CLI,
// and the row already draws that emoji in the agent's circle — so the title
// drops the copy in front of it instead of printing the emoji twice.
export function titleWithoutAgentEmoji(title, agent) {
  const text = String(title || "");
  if (!agent || !agent.emoji || !text.startsWith(agent.emoji)) {
    return text;
  }
  return text.slice(agent.emoji.length).trim() || text;
}

// How many agents the "Assign to agent" menus show before "More…": a menu
// long enough to scroll past is no quicker than a picker. Ten is the whole
// list for almost everybody.
export const MENU_AGENT_LIMIT = 10;

// The agents most likely to be wanted, most used first. "Used" is how many
// sessions are linked to the agent in agents.json plus the terminals
// running as it right now; ties go to whichever was used last
// (`lastUsedAt`, written whenever an agent starts a session or is assigned
// to one), and after that the order the agents are stored in — so a list
// that never changes never reorders itself. Built-ins are ranked like any
// other agent.
export function rankAgentsByUse(agents, { sessionAgents = {}, liveAgentIds = [] } = {}) {
  const sessionCount = new Map();
  for (const agentId of Object.values(sessionAgents || {})) {
    sessionCount.set(agentId, (sessionCount.get(agentId) || 0) + 1);
  }
  for (const agentId of liveAgentIds || []) {
    if (agentId) {
      sessionCount.set(agentId, (sessionCount.get(agentId) || 0) + 1);
    }
  }
  return (agents || [])
    .map((agent, position) => ({ agent, position, sessions: sessionCount.get(agent.id) || 0 }))
    .sort((first, second) => {
      if (first.sessions !== second.sessions) {
        return second.sessions - first.sessions;
      }
      const firstUsed = Number(first.agent.lastUsedAt) || 0;
      const secondUsed = Number(second.agent.lastUsedAt) || 0;
      if (firstUsed !== secondUsed) {
        return secondUsed - firstUsed;
      }
      return first.position - second.position;
    })
    .map((entry) => entry.agent);
}
