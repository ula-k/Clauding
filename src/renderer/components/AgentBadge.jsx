// How an agent shows itself: a small circle in its own colour with its
// emoji inside. The session rows use the circle alone (before the name, next
// to the status dot); the terminal header uses the chip, which adds the
// name. Both take their colour from a theme.css token, never a stored hex.

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

export function AgentChip({ agent }) {
  if (!agent) {
    return null;
  }
  return (
    <span
      className="agent-chip"
      style={{ "--agent-color": `var(${agent.color})` }}
      title={agent.name}
      data-agent-chip={agent.id}
    >
      <span className="agent-chip-emoji">{agent.emoji}</span>
      <span className="agent-chip-name">{agent.name}</span>
    </span>
  );
}
