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

// The system prompt says who the fork is; it does not make it start
// working. The CLI comes up at an empty prompt, so the app types the job in
// as the *first user message* too (electron/lib/terminalKickoff.js). These
// are those messages: English like the task lines above, because they are
// written to Claude and never shown on screen.
//
// Both of them open by saying where the session now is. A conversation can
// have been started in a plain terminal and only taken over by Clauding at
// the fork, in which case nothing in it has ever mentioned the app or the
// `clauding` command.
const INSIDE_CLAUDING =
  "You are now inside Clauding, a desktop app around Claude Code: your terminal is the middle column, " +
  "a side panel on the right shows HTML/Markdown/URL tabs, and the `clauding` command is on your PATH " +
  "(`clauding open <path|url>` shows a page there, `clauding agent add <folder>` registers an agent " +
  "definition in the app, `clauding tabs`, `clauding panel hide`).";

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

// The first message typed into a "Create agent from this conversation" fork.
export function createAgentKickoffMessage(agentsRoot) {
  return (
    `${INSIDE_CLAUDING} ` +
    `Distil this conversation into a new agent definition under ${agentsRoot}: ` +
    `propose the agent's name and slug, write ${agentsRoot}/<slug>/<slug>.md following the Agent Maker rules, ` +
    "show the draft in the side panel with clauding open, and wait for my approval before finalising. " +
    "Do not describe the Agent Maker itself."
  );
}

// The first message typed into a "Harvest skills" fork.
export function harvestSkillsKickoffMessage(skillsRoot) {
  return (
    `${INSIDE_CLAUDING} ` +
    "Run the skill-maker skill over this conversation: read it whole, " +
    "list the candidate procedures with one line each, ask me which to keep, " +
    `then write the kept ones under ${skillsRoot} (one folder per skill with SKILL.md) and show me the list.`
  );
}

// A *new* session started with an agent (the Agents tab row, "+ New" with an
// agent picked, a group header's "+" with one) has exactly the same problem
// as an assignment: the definition is appended to the system prompt, which
// nobody can see, and the CLI comes up at an empty prompt — so the session
// looked like any other empty terminal with a colored chip on it. This is
// the message the app types in for it, so the first thing on screen is the
// agent saying who it is.
export function agentStartKickoffMessage(agentName) {
  return (
    `You are running as the agent "${agentName}" inside Clauding. ` +
    "Read your definition and ONLY the files it lists as read-first; " +
    "do not browse the rest of the wiki, and ignore folder notes or memory pointers " +
    "that concern other topics than your role. " +
    "Then tell me in two sentences who you are and what you will start with — " +
    "and wait for my instructions."
  );
}

// "Assign to agent": after the terminal is restarted (or the session
// resumed) the definition is in the system prompt — where nobody can see
// it. So the app types one message in, the same way the two meta actions
// do, and the answer on screen is the proof that the definition arrived.
export function agentAssignmentKickoffMessage(agentName) {
  return (
    `You are now assigned the ${agentName} definition. ` +
    "Read it and tell me in two sentences what you will do differently in this conversation from now on."
  );
}
