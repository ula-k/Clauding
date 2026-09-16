// How an agent shows itself: a small circle in its own colour with its
// emoji inside. The session rows use the circle alone (before the name, next
// to the status dot); the terminal header uses the chip, which adds the
// name. Both take their colour from a theme.css token, never a stored hex.
import { useTranslation } from "../i18n.js";

export function AgentBadge({ agent }) {
  if (!agent) {
    return null;
  }
  return (
    <span
      className="agent-badge"
      style={{ "--agent-color": `var(${agent.color})` }}
      title={agent.name}
      aria-label={agent.name}
      data-agent-badge={agent.id}
    >
      {agent.emoji}
    </span>
  );
}

// `definitionPending` is the session that was assigned with "Assign only"
// while its terminal was running: the link is written, but the conversation
// on screen still carries the system prompt it started with — so the chip
// says in so many words when the definition will be read.
//
// `starting` is the other half: a session that has just been started as an
// agent, whose first message the app is still waiting to type in. Until it
// goes, the terminal looks idle, so the chip says what is happening.
export function AgentChip({ agent, definitionPending = false, starting = false }) {
  const { translate } = useTranslation();
  if (!agent) {
    return null;
  }
  return (
    <>
      <span
        className="agent-chip"
        style={{ "--agent-color": `var(${agent.color})` }}
        title={agent.name}
        data-agent-chip={agent.id}
      >
        <span className="agent-chip-emoji">{agent.emoji}</span>
        <span className="agent-chip-name">{agent.name}</span>
      </span>
      {definitionPending && (
        <span className="agent-chip-pending" data-agent-chip-pending>
          {translate("agents.pendingResume")}
        </span>
      )}
      {!definitionPending && starting && (
        <span className="agent-chip-pending" data-agent-chip-starting>
          {translate("agents.starting")}
        </span>
      )}
    </>
  );
}
