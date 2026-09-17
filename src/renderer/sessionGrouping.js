// Turns the flat session list plus the user's groups.json into what the left
// column draws: one bucket per group, in the stored order, hidden sessions kept
// aside for the "Hidden (N)" line at the bottom.
//
// Nothing here looks at the live status to decide a group — the status is
// only a color and a sort key. The grouping is hers alone.
import { DEFAULT_GROUP_ID } from "./groupConstants.js";

// The search box matches what is on screen (the name, the agent behind the
// badge and the tag pills) and what is not (the folder and the first
// prompt), so typing "blueprint" finds a session in that folder even though
// the row no longer prints the folder, and typing "spec" finds everything
// the Spec Writer ran. Tags are matched by their label, which is why there
// is no filter of their own: typing the tag is the filter.
export function matchesSearch(session, query, tagLabels = []) {
  if (!query) {
    return true;
  }
  const haystack = [
    ...(tagLabels || []),
    session.title,
    session.agent ? session.agent.name : null,
    session.projectName,
    session.projectLabel,
    session.workingDirectoryShort,
    session.firstPrompt,
    session.summary
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function compareSessions(first, second) {
  const firstIsRunning = first.statusGroup === "running" ? 0 : 1;
  const secondIsRunning = second.statusGroup === "running" ? 0 : 1;
  if (firstIsRunning !== secondIsRunning) {
    return firstIsRunning - secondIsRunning;
  }
  return (second.lastModified || 0) - (first.lastModified || 0);
}

export function groupIdForSession(sessionId, membership, groups) {
  const wanted = membership[sessionId];
  if (wanted && groups.some((group) => group.id === wanted)) {
    return wanted;
  }
  return DEFAULT_GROUP_ID;
}

// Returns { buckets, hiddenSessions, visibleCount }, where a bucket is
// { group, sessions, collapsed, hasRunning, hasNeedsAnswer }.
//
// A collapsed group keeps its sessions in the bucket — the column simply does
// not draw the rows — so the count and the two summary flags stay honest:
// `hasRunning` and `hasNeedsAnswer` are what the header shows in place of the
// rows, so nothing important disappears when a group is folded shut.
// While a search query is typed every group is shown open, so a match is
// never hidden behind a chevron; that is not written back to groups.json.
export function buildGroupedList({ sessions, groups, membership, hidden, collapsed, searchText, tagLabels = {} }) {
  const query = String(searchText || "").trim().toLowerCase();
  const hiddenIds = new Set(hidden);
  const collapsedIds = new Set(collapsed || []);
  const buckets = groups
    .slice()
    .sort((first, second) => first.order - second.order)
    .map((group) => ({
      group,
      sessions: [],
      collapsed: collapsedIds.has(group.id) && !query,
      hasRunning: false,
      hasNeedsAnswer: false
    }));
  const bucketById = new Map(buckets.map((bucket) => [bucket.group.id, bucket]));
  const hiddenSessions = [];

  for (const session of sessions) {
    if (hiddenIds.has(session.sessionId)) {
      hiddenSessions.push(session);
      continue;
    }
    if (!matchesSearch(session, query, tagLabels[session.sessionId])) {
      continue;
    }
    const bucket = bucketById.get(groupIdForSession(session.sessionId, membership, groups));
    if (bucket) {
      bucket.sessions.push(session);
      if (session.statusGroup === "running") {
        bucket.hasRunning = true;
      }
      if (session.needsAnswer) {
        bucket.hasNeedsAnswer = true;
      }
    }
  }

  for (const bucket of buckets) {
    bucket.sessions.sort(compareSessions);
  }
  hiddenSessions.sort(compareSessions);

  return {
    buckets,
    hiddenSessions,
    visibleCount: buckets.reduce((total, bucket) => total + bucket.sessions.length, 0)
  };
}

// What the Agents tab draws under one agent row: every session that agent
// started, newest work first, and how many of them the user has hidden in their
// groups (those are left out of the list and counted on one faint line).
//
// A session counts as this agent's when agents.json links it (`sessionAgents`)
// or when the terminal it runs in was started as that agent — `session.agent`
// already carries both, see App.jsx.
//
// Scratch sessions never get here: ~/.claude/jobs/*/t?p conversations are
// dropped from the session list itself (electron/sessions.js), so a smoke
// run's sessions do not show up under an agent either.
export function buildAgentSessionList({ sessions, agentId, sessionAgents, hidden }) {
  const hiddenIds = new Set(hidden || []);
  const links = sessionAgents || {};
  const belongs = (session) =>
    (session.agent && session.agent.id === agentId) || links[session.sessionId] === agentId;
  const visible = [];
  let hiddenCount = 0;
  for (const session of sessions) {
    if (!belongs(session)) {
      continue;
    }
    if (hiddenIds.has(session.sessionId)) {
      hiddenCount += 1;
      continue;
    }
    visible.push(session);
  }
  visible.sort(compareSessions);
  return { sessions: visible, hiddenCount };
}
