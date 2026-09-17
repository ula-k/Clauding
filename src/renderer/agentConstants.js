// The small helpers the agent list, the form and the badges share.
//
// Agents have no colour of their own: what tells one from another is its
// emoji, drawn in one neutral circle wherever it appears. The palette
// belongs to the sessions — see sessionColors.js.
import { lastSegmentOf, segmentsOf, separatorOf } from "./paths.js";

export const DEFAULT_AGENT_EMOJI = "✦";

// "…/agenci/spec-writer" — the last two parts of the definition folder, the
// dim second line of an agent row. A Windows folder is split the same way
// and keeps its own separator.
export function definitionFolderLabel(definitionFolder) {
  const parts = segmentsOf(String(definitionFolder || ""));
  if (parts.length === 0) {
    return "";
  }
  const separator = separatorOf(String(definitionFolder || ""));
  return `…${separator}${parts.slice(-2).join(separator)}`;
}

export function fileNameOf(filePath) {
  return lastSegmentOf(filePath);
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
