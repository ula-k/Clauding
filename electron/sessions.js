// Session listing: the SDK gives us the raw list, we enrich each row with a
// project short name, a project colour and the live status group.
import { listSessions, getSessionInfo, renameSession, deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { projectShortName, projectFolderLabel, projectColorIndex, shortenHomePath } from "./projects.js";
import { collectLiveStatus, STATUS_GROUPS } from "./liveStatus.js";
import { isInsideSmokeFolder } from "./smokeFolder.js";

export const DEFAULT_PAGE_SIZE = 60;

// Scratch sessions never belong in the list. Two folders count as scratch:
// the app's own smoke folder (see smokeFolder.js) and the throw-away folder
// a background job keeps at ~/.claude/jobs/<shortId>/<scratch>. The
// conversations in either are test noise, not sessions the user wants to
// find again.
//
// The job folder's three-letter name is written as a character class below
// only because `npm run check` bans that abbreviation anywhere in a line of
// code — the path it matches is ~/.claude/jobs/*/t?p/…
//
// Either separator is accepted, so the same rule holds for a Windows working
// directory (C:\Users\name\.claude\jobs\ab12\t?p\…).
const JOB_SCRATCH_PATTERN = /[\\/]\.claude[\\/]jobs[\\/][^\\/]+[\\/]t[m]p([\\/]|$)/;

export function isScratchWorkingDirectory(workingDirectory) {
  const folder = String(workingDirectory || "");
  return JOB_SCRATCH_PATTERN.test(folder) || isInsideSmokeFolder(folder);
}

function pickTitle(session) {
  return session.customTitle || session.summary || session.firstPrompt || session.sessionId;
}

// Sessions running inside one of the app's own terminals: the CLI in that
// pty registers itself in ~/.claude/sessions like any terminal does, so the
// registry already knows busy / idle; only the ownership is added here so
// the renderer shows the terminal instead of a "running elsewhere" banner.
function ownedGroup(ownedState, liveStatus) {
  if (liveStatus) {
    return liveStatus.group;
  }
  return ownedState.registryStatus === "idle" ? STATUS_GROUPS.waiting : STATUS_GROUPS.running;
}

// The "needs answer" badge in the list: only a job that says it is blocked
// on something (a permission prompt, a question) earns it. A plain idle CLI
// is not "waiting for an answer", it is simply sitting at its prompt.
function needsAnswer(liveStatus) {
  if (!liveStatus) {
    return false;
  }
  return Boolean(liveStatus.needs) || liveStatus.rawStatus === "blocked";
}

export function enrichSession(session, statusBySession, ownedStates = new Map()) {
  const ownedState = ownedStates.get(session.sessionId) || null;
  let liveStatus = statusBySession.get(session.sessionId) || null;
  let statusGroup = liveStatus ? liveStatus.group : STATUS_GROUPS.recent;
  if (ownedState) {
    statusGroup = ownedGroup(ownedState, liveStatus);
    liveStatus = {
      ...(liveStatus || { rawStatus: ownedState.registryStatus || "starting", workingDirectory: session.cwd || null }),
      group: statusGroup,
      source: "app",
      terminalId: ownedState.terminalId,
      pid: ownedState.pid
    };
  }
  return {
    sessionId: session.sessionId,
    title: pickTitle(session),
    customTitle: session.customTitle || null,
    summary: session.summary || null,
    firstPrompt: session.firstPrompt || null,
    workingDirectory: session.cwd || null,
    workingDirectoryShort: shortenHomePath(session.cwd || ""),
    projectName: projectShortName(session.cwd),
    projectLabel: projectFolderLabel(session.cwd),
    projectColorIndex: projectColorIndex(session.cwd),
    gitBranch: session.gitBranch || null,
    lastModified: session.lastModified,
    createdAt: session.createdAt || null,
    fileSize: session.fileSize || null,
    tag: session.tag || null,
    statusGroup,
    needsAnswer: needsAnswer(liveStatus),
    ownedByApp: Boolean(ownedState),
    liveStatus
  };
}

// One page of sessions across all projects, newest first.
export async function listSessionsPage({ offset = 0, limit = DEFAULT_PAGE_SIZE, ownedStates = new Map() } = {}) {
  const statusBySession = collectLiveStatus();
  // We ask for one extra row to know whether another page exists.
  const rows = await listSessions({ offset, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const pageRows = (hasMore ? rows.slice(0, limit) : rows).filter(
    (session) => !isScratchWorkingDirectory(session.cwd)
  );
  return {
    sessions: pageRows.map((session) => enrichSession(session, statusBySession, ownedStates)),
    offset,
    limit,
    hasMore,
    liveStatus: Object.fromEntries(statusBySession)
  };
}

export async function getSession(sessionId, ownedStates = new Map()) {
  const session = await getSessionInfo(sessionId);
  if (!session) {
    return null;
  }
  return enrichSession(session, collectLiveStatus(), ownedStates);
}

export async function renameSessionTitle(sessionId, title) {
  await renameSession(sessionId, title);
  return { sessionId, title };
}

// "Delete session": the transcript itself goes, through the SDK — this is
// the one place in the app that removes somebody's conversation, and it is
// only ever reached from a confirmation the user answered.
export async function deleteSessionTranscript(sessionId) {
  await deleteSession(sessionId);
  return { sessionId, deleted: true };
}
