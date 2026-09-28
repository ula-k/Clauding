// Projects view: which Claude Code sessions belong to which ClickUp task.
//
// Rules, the first one that says anything wins for a session:
//   1. manual    — the user linked the session to the task by hand
//                  (board.manualLinks); also the only way to UNlink
//   2. branch    — the session's git branch or working folder carries
//                  CU-<task id> (a builder typically works in a CU- worktree)
//   3. mention   — the session's first prompt or title contains the task's
//                  link (app.clickup.com/t/<id>) or CU-<id>; a builder
//                  always starts from the task link
//   4. transcript — the same, found in the first part of the transcript
//                  (passed in as `transcriptTextBySession`; reading it is
//                  the caller's job)
//
// A session's role comes from the agent it was born from: an agent whose
// name says "spec" writes specs, one whose name says "build" builds. The user can map any agent to a
// role (board.agentRoles); unknown agents and plain sessions are "other".
import { taskIdFromBranch } from "./gitInspector.js";

export const SESSION_ROLES = {
  spec: "spec",
  builder: "builder",
  other: "other"
};

export function roleForAgent(agent, agentRoles = {}) {
  if (!agent) {
    return SESSION_ROLES.other;
  }
  const chosen = agentRoles[agent.id];
  if (chosen && Object.values(SESSION_ROLES).includes(chosen)) {
    return chosen;
  }
  const name = String(agent.name || "").toLowerCase();
  if (/spec/.test(name)) {
    return SESSION_ROLES.spec;
  }
  if (/build/.test(name)) {
    return SESSION_ROLES.builder;
  }
  return SESSION_ROLES.other;
}

// Every task id a piece of text mentions, as ClickUp links or CU- ids.
export function taskIdsMentionedIn(text) {
  const found = new Set();
  const source = String(text || "");
  for (const match of source.matchAll(/app\.clickup\.com\/t\/(?:\d+\/)?([0-9a-z]{6,12})\b/gi)) {
    found.add(match[1].toLowerCase());
  }
  for (const match of source.matchAll(/\bCU-([0-9a-z]{6,12})\b/gi)) {
    found.add(match[1].toLowerCase());
  }
  return found;
}

function taskIdsFromPath(folderPath) {
  const found = new Set();
  for (const part of String(folderPath || "").split(/[\\/]/)) {
    const taskId = taskIdFromBranch(part);
    if (taskId) {
      found.add(taskId);
    }
  }
  return found;
}

// → Map<taskId, [{ sessionId, role, via }]>, sessions newest first.
export function linkSessionsToTasks({
  sessions = [],
  taskIds = [],
  sessionAgents = {},
  agents = [],
  agentRoles = {},
  manualLinks = {},
  transcriptTextBySession = {}
}) {
  const known = new Set(taskIds.map((taskId) => String(taskId).toLowerCase()));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const links = new Map();

  // Manual links and unlinks, per session.
  const manualTasksBySession = new Map();
  const unlinked = new Set();
  for (const [taskId, link] of Object.entries(manualLinks || {})) {
    for (const sessionId of (link && link.sessionIds) || []) {
      if (!manualTasksBySession.has(sessionId)) {
        manualTasksBySession.set(sessionId, new Set());
      }
      manualTasksBySession.get(sessionId).add(taskId.toLowerCase());
    }
    for (const sessionId of (link && link.unlinkedSessionIds) || []) {
      unlinked.add(`${taskId.toLowerCase()}|${sessionId}`);
    }
  }

  const ordered = [...sessions].sort((first, second) => (second.lastModified || 0) - (first.lastModified || 0));
  for (const session of ordered) {
    let via = null;
    let found = new Set();
    const manual = manualTasksBySession.get(session.sessionId);
    if (manual && manual.size > 0) {
      via = "manual";
      found = manual;
    }
    if (!via) {
      const fromBranch = new Set([
        ...taskIdsFromPath(session.gitBranch),
        ...taskIdsFromPath(session.workingDirectory)
      ]);
      if (fromBranch.size > 0) {
        via = "branch";
        found = fromBranch;
      }
    }
    if (!via) {
      const fromMention = taskIdsMentionedIn(`${session.firstPrompt || ""}\n${session.title || ""}`);
      if (fromMention.size > 0) {
        via = "mention";
        found = fromMention;
      }
    }
    if (!via) {
      const fromTranscript = taskIdsMentionedIn(transcriptTextBySession[session.sessionId]);
      if (fromTranscript.size > 0) {
        via = "transcript";
        found = fromTranscript;
      }
    }
    if (!via) {
      continue;
    }
    const agent = agentsById.get(sessionAgents[session.sessionId]) || null;
    const role = roleForAgent(agent, agentRoles);
    for (const taskId of found) {
      if (!known.has(taskId) || unlinked.has(`${taskId}|${session.sessionId}`)) {
        continue;
      }
      if (!links.has(taskId)) {
        links.set(taskId, []);
      }
      links.get(taskId).push({
        sessionId: session.sessionId,
        title: session.title || session.sessionId,
        role,
        via,
        agentEmoji: agent ? agent.emoji : null,
        statusGroup: session.statusGroup || null,
        needsAnswer: Boolean(session.needsAnswer),
        lastModified: session.lastModified || null
      });
    }
  }
  return links;
}
