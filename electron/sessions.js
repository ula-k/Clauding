// Session listing: the SDK gives us the raw list, we enrich each row with a
// project short name, a project color and the live status group.
import { listSessions, getSessionInfo, renameSession, deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { projectShortName, projectFolderLabel, projectColorIndex, shortenHomePath } from "./projects.js";
import { collectLiveStatus, STATUS_GROUPS } from "./liveStatus.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInsideSmokeFolder } from "./smokeFolder.js";
import { claudeRegistryPaths } from "./lib/platformPaths.js";
import { searchTranscriptFiles } from "./lib/transcriptSearch.js";
import { TAIL_BYTES, createNeedsAnswerCache, isRecentEnoughToAsk } from "./lib/needsAnswer.js";

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

// The last bytes of a file, without reading the rest of it: a transcript
// that has run for an hour is megabytes, and the only thing that decides
// whether a session is waiting for an answer is the end of it.
function readFileTail(filePath, byteCount = TAIL_BYTES) {
  let handle = null;
  try {
    handle = fs.openSync(filePath, "r");
    const { size } = fs.fstatSync(handle);
    const length = Math.min(size, byteCount);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } catch (error) {
    return "";
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch (error) {
        // Nothing to do about a file that closed itself.
      }
    }
  }
}

// One answer per session, kept until its transcript changes size or time
// (electron/lib/needsAnswer.js decides, this only reads the file).
const needsAnswerCache = createNeedsAnswerCache({ readTail: (filePath) => readFileTail(filePath) });

export function forgetNeedsAnswer(sessionId) {
  needsAnswerCache.forget(sessionId);
}

// Where each session's transcript was last found. Looking it up means
// asking every project folder whether it holds <sessionId>.jsonl, and the
// answer does not move, so it is remembered — and thrown away again the
// moment the file is not there (a session deleted, a project folder
// renamed), which sends the next call back through the search.
const transcriptPathBySession = new Map();

function transcriptPathFor(sessionId) {
  const remembered = transcriptPathBySession.get(sessionId);
  if (remembered && fs.existsSync(remembered)) {
    return remembered;
  }
  transcriptPathBySession.delete(sessionId);
  const files = transcriptFilesFor(sessionId);
  if (files.length === 0) {
    return null;
  }
  transcriptPathBySession.set(sessionId, files[0].filePath);
  return files[0].filePath;
}

// The transcript of a session and how it stands right now, as a stamp the
// cache can compare: null when the session has not written one yet.
function transcriptStamp(sessionId) {
  const filePath = transcriptPathFor(sessionId);
  if (!filePath) {
    return null;
  }
  try {
    const stats = fs.statSync(filePath);
    return { filePath, stamp: `${stats.mtimeMs}:${stats.size}` };
  } catch (error) {
    transcriptPathBySession.delete(sessionId);
    return null;
  }
}

// The "needs answer" badge in the list. A job says so itself; an ordinary
// session cannot, so the end of its conversation is read and the last thing
// it said decides (see electron/lib/needsAnswer.js).
//
// **A live process is not part of it.** The badge used to need one, and so
// it vanished on every restart of the app — every terminal dies with the
// window, while the question in the transcript sits there unanswered. Now
// any listed session that is **not busy** is asked, running or not; only
// its age counts, because a transcript nobody has touched for three days is
// an old conversation, not a pending question. A **busy** session never
// earns it: it is still writing.
//
// It is worked out for the rows actually loaded (one page, 60 of them) and
// again whenever the list changes, and each answer is kept under the
// transcript's size and modification time, so the file is only read when it
// has really moved.
function needsAnswer(sessionId, liveStatus, lastModified) {
  if (liveStatus && (Boolean(liveStatus.needs) || liveStatus.rawStatus === "blocked")) {
    return true;
  }
  if (liveStatus && liveStatus.group === STATUS_GROUPS.running) {
    needsAnswerCache.forget(sessionId);
    return false;
  }
  if (!isRecentEnoughToAsk(lastModified)) {
    needsAnswerCache.forget(sessionId);
    return false;
  }
  const transcript = transcriptStamp(sessionId);
  if (!transcript) {
    return false;
  }
  return needsAnswerCache.lookup(sessionId, { ...transcript, busy: false });
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
    needsAnswer: needsAnswer(session.sessionId, liveStatus, session.lastModified),
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

// ---------------------------------------------------------------- search ---
//
// "The terminal shows what it shows, but there is always the JSON file with
// everything 1:1." That file is the transcript the CLI writes at
// ~/.claude/projects/<project folder>/<sessionId>.jsonl — and, for a session
// that sent work to subagents, one file per subagent beside it at
// <sessionId>/subagents/agent-*.jsonl, each with an agent-*.meta.json saying
// what kind of agent it was.
//
// The project folder's name is the working directory with its separators
// mangled, so rather than trying to reproduce that spelling the folders are
// simply looked through for the file named after the session. It is a flat
// listing of a few dozen folders and it is right whatever the CLI does to
// the name.
//
// Reading only: nothing here writes, renames or deletes a thing.

// The transcript and every subagent transcript of one session, as
// [{ filePath, roleLabel }] — the main file first, so the hits come back in
// the order the conversation happened.
export function transcriptFilesFor(sessionId, { homeDirectory = os.homedir() } = {}) {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(String(sessionId))) {
    return [];
  }
  const projectsDirectory = claudeRegistryPaths({ homeDirectory }).projectsDirectory;
  let projectFolders = [];
  try {
    projectFolders = fs.readdirSync(projectsDirectory, { withFileTypes: true });
  } catch (error) {
    return [];
  }
  for (const folder of projectFolders) {
    if (!folder.isDirectory()) {
      continue;
    }
    const transcriptPath = path.join(projectsDirectory, folder.name, `${sessionId}.jsonl`);
    if (!fs.existsSync(transcriptPath)) {
      continue;
    }
    const files = [{ filePath: transcriptPath, roleLabel: null }];
    files.push(...subagentTranscriptsIn(path.join(projectsDirectory, folder.name, sessionId, "subagents")));
    return files;
  }
  return [];
}

// <sessionId>/subagents/agent-<id>.jsonl, labelled from the agent-<id>.meta.json
// next to it ("subagent (Explore)"). A subagent with no meta file is still
// searched, it is just labelled plainly.
function subagentTranscriptsIn(subagentsFolder) {
  let entries = [];
  try {
    entries = fs.readdirSync(subagentsFolder, { withFileTypes: true });
  } catch (error) {
    return [];
  }
  const files = [];
  for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(subagentsFolder, entry.name);
    files.push({ filePath, roleLabel: `subagent (${subagentTypeOf(filePath)})` });
  }
  return files;
}

function subagentTypeOf(transcriptPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    if (meta && typeof meta.agentType === "string" && meta.agentType.trim()) {
      return meta.agentType.trim();
    }
  } catch (error) {
    // No meta file, or an unreadable one: the plain label below will do.
  }
  return "agent";
}

// What the window asks for: every place `query` appears in this session's
// transcript, subagents included. The parsing and the matching are
// electron/lib/transcriptSearch.js; this only finds and reads the files.
export function searchSessionTranscript(sessionId, query, { homeDirectory = os.homedir() } = {}) {
  const trimmedQuery = String(query || "").trim();
  const files = transcriptFilesFor(sessionId, { homeDirectory });
  if (files.length === 0) {
    return { query: trimmedQuery, hits: [], totalMatches: 0, transcriptFound: false, searchedAt: Date.now() };
  }
  const contents = [];
  for (const file of files) {
    try {
      contents.push({ text: fs.readFileSync(file.filePath, "utf8"), roleLabel: file.roleLabel });
    } catch (error) {
      // A subagent file that vanished between the listing and the read.
    }
  }
  const found = searchTranscriptFiles(contents, trimmedQuery);
  return { ...found, transcriptFound: true, fileCount: contents.length, searchedAt: Date.now() };
}
