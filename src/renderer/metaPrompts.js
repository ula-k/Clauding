// The two "meta" actions a conversation can be sent off to do, and the names
// their forks get.
//
// Both work the same way: the conversation is forked into a second terminal
// (the original is never touched), and the fork's prompt file carries one
// extra paragraph saying what this copy is for. The text is deliberately in
// English and not translated: it goes into the CLI's system prompt, not onto
// the screen, and the session answers the user in whatever language they
// write in.
//
// The suffixes are the same kind of thing as " (fork)": they become the
// session's stored name, so they are not redrawn when the interface language
// changes.
const NEW_AGENT_SUFFIX = " → new agent";
const SKILLS_SUFFIX = " → skills";
const FORK_NAME_MAX_LENGTH = 90;

function withSuffix(originalTitle, suffix) {
  const cleaned = String(originalTitle || "").replace(/\s+/g, " ").trim();
  const room = FORK_NAME_MAX_LENGTH - suffix.length;
  const shortened = cleaned.length > room ? `${cleaned.slice(0, room - 1)}…` : cleaned;
  return `${shortened}${suffix}`;
}

export function newAgentSessionName(originalTitle) {
  return withSuffix(originalTitle, NEW_AGENT_SUFFIX);
}

export function harvestSkillsSessionName(originalTitle) {
  return withSuffix(originalTitle, SKILLS_SUFFIX);
}

// "Create agent from this conversation": the fork runs as the Agent Maker,
// so its definition is already in the prompt; this is only the job.
export function createAgentTaskPrompt(agentsRoot) {
  return (
    `Your task in this session: distil THIS conversation into a new agent definition under ${agentsRoot}. ` +
    "Describe the role, the steps and the rules this conversation actually followed; " +
    "do not describe the Agent Maker itself. " +
    "Show the draft in the side panel and wait for approval."
  );
}

// "Harvest skills": no agent, just the skill and the job.
export function harvestSkillsTaskPrompt(skillsRoot) {
  return (
    "Your task in this session: run the skill-maker skill over THIS conversation: " +
    `list candidate procedures, ask which to keep, then write them under ${skillsRoot}.`
  );
}
