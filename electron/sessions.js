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
import { currentClaudeHome } from "./claudeHome.js";
import { searchTranscriptFiles } from "./lib/transcriptSearch.js";
import { TAIL_BYTES, createNeedsAnswerCache, isRecentEnoughToAsk } from "./lib/needsAnswer.js";
import { OPENING_BYTES, openingTextFromTranscript } from "./lib/transcriptOpening.js";
import { cwdValuesInText, decodeProjectFolderName, resolveSessionFolder } from "./lib/sessionFolder.js";

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

// ------------------------------------------------------------ folders ---
//
// The folder a row resumes in. The SDK's `cwd` is read from the first 64 KiB
// of the transcript only, and a renamed or forked long conversation can
// carry more than that before its first `cwd` line — the row then had no
// folder and a click opened nothing. The chain (the transcript's project
// folder, the SDK's `cwd`, the transcript's own `cwd` lines) is
// electron/lib/sessionFolder.js; this does the reading.

const HEAD_CHUNK_BYTES = 256 * 1024;
const HEAD_MAXIMUM_BYTES = 4 * 1024 * 1024;
const FOLDER_TAIL_BYTES = 64 * 1024;

function readFileRange(handle, start, length) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(handle, buffer, 0, length, start);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

// The first `cwd` values of a transcript (reading on, a chunk at a time,
// until one turns up or 4 MiB have gone by) and the ones in its last 64 KiB.
// Kept per transcript stamp, so a file is read again only when it changed.
const transcriptFoldersCache = new Map();

export function readTranscriptFolders(filePath) {
  let handle = null;
  try {
    handle = fs.openSync(filePath, "r");
    const { size, mtimeMs } = fs.fstatSync(handle);
    const stamp = `${mtimeMs}:${size}`;
    const cached = transcriptFoldersCache.get(filePath);
    if (cached && cached.stamp === stamp) {
      return cached.folders;
    }
    let headFolders = [];
    let carried = "";
    for (let start = 0; start < Math.min(size, HEAD_MAXIMUM_BYTES) && headFolders.length === 0; start += HEAD_CHUNK_BYTES) {
      // The last partial line of one chunk is carried into the next, so a
      // `cwd` cut by the chunk edge is still found.
      const text = carried + readFileRange(handle, start, Math.min(HEAD_CHUNK_BYTES, size - start));
      const lastNewline = text.lastIndexOf("\n");
      headFolders = cwdValuesInText(lastNewline >= 0 ? text.slice(0, lastNewline) : text);
      carried = lastNewline >= 0 ? text.slice(lastNewline + 1) : "";
    }
    const tailStart = Math.max(0, size - FOLDER_TAIL_BYTES);
    const tailFolders = cwdValuesInText(readFileRange(handle, tailStart, size - tailStart));
    const folders = { headFolders, tailFolders };
    transcriptFoldersCache.set(filePath, { stamp, folders });
    return folders;
  } catch (error) {
    return { headFolders: [], tailFolders: [] };
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch (error) {
        // Already closed.
      }
    }
  }
}

function listSubfolders(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

const decodedProjectFolders = new Map();

function decodeProjectFolder(encodedName) {
  if (!decodedProjectFolders.has(encodedName)) {
    decodedProjectFolders.set(encodedName, decodeProjectFolderName(encodedName, listSubfolders, path.sep));
  }
  return decodedProjectFolders.get(encodedName);
}

function folderExists(folder) {
  try {
    return fs.statSync(folder).isDirectory();
  } catch (error) {
    return false;
  }
}

// { folder, source, exists } for one session. The transcript itself is only
// read when neither its project folder nor the SDK gives a folder that is
// there — the rows the SDK got right cost one stat each.
export function resolveFolderForSession(sessionId, sdkFolder = null) {
  const transcriptPath = transcriptPathFor(sessionId);
  const projectFolderName = transcriptPath ? path.basename(path.dirname(transcriptPath)) : null;
  const quick = resolveSessionFolder({ projectFolderName, decodeProjectFolder, sdkFolder, folderExists });
  if (quick.exists || !transcriptPath) {
    return quick;
  }
  const { headFolders, tailFolders } = readTranscriptFolders(transcriptPath);
  return resolveSessionFolder({ projectFolderName, decodeProjectFolder, sdkFolder, headFolders, tailFolders, folderExists });
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

// The opening of a conversation (its first user messages), for the Projects
// view's task linking: { stamp, text } or null. The head of the file only.
export function readSessionOpening(sessionId) {
  const transcript = transcriptStamp(sessionId);
  if (!transcript) {
    return null;
  }
  let handle = null;
  try {
    handle = fs.openSync(transcript.filePath, "r");
    const buffer = Buffer.alloc(OPENING_BYTES);
    const length = fs.readSync(handle, buffer, 0, OPENING_BYTES, 0);
    return { stamp: transcript.stamp, text: openingTextFromTranscript(buffer.subarray(0, length).toString("utf8")) };
  } catch (error) {
    return null;
  } finally {
    if (handle !== null) {
      fs.closeSync(handle);
    }
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

// `offeredSessions` (sessionId -> entry) are the sessions that were open in
// the app when it last closed and have not been opened again since
// (electron/openTerminals.js): their rows say "was open".
export function enrichSession(session, statusBySession, ownedStates = new Map(), offeredSessions = new Map()) {
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
  // The folder the row resumes in: the SDK's, or — when it has none, or one
  // that is gone — the next answer along the chain (resolveFolderForSession).
  const resolved = resolveFolderForSession(session.sessionId, session.cwd || null);
  const folder = resolved.folder;
  return {
    sessionId: session.sessionId,
    title: pickTitle(session),
    customTitle: session.customTitle || null,
    summary: session.summary || null,
    firstPrompt: session.firstPrompt || null,
    workingDirectory: folder,
    workingDirectoryShort: shortenHomePath(folder || ""),
    // Where the folder came from ("sdk", "stored", "transcript", "parent",
    // "project", "none"), and whether it is still on disk. A row whose
    // folder is unknown or gone is not resumed on a click: the middle column
    // asks for a folder instead.
    folderSource: resolved.source,
    folderMissing: !folder || !resolved.exists,
    projectName: projectShortName(folder),
    projectLabel: projectFolderLabel(folder),
    projectColorIndex: projectColorIndex(folder),
    gitBranch: session.gitBranch || null,
    lastModified: session.lastModified,
    createdAt: session.createdAt || null,
    fileSize: session.fileSize || null,
    tag: session.tag || null,
    statusGroup,
    needsAnswer: needsAnswer(session.sessionId, liveStatus, session.lastModified),
    ownedByApp: Boolean(ownedState),
    wasOpen: !ownedState && offeredSessions.has(session.sessionId) ? offeredSessions.get(session.sessionId) : null,
    liveStatus
  };
}

// One page of sessions across all projects, newest first.
export async function listSessionsPage({
  offset = 0,
  limit = DEFAULT_PAGE_SIZE,
  ownedStates = new Map(),
  offeredSessions = new Map()
} = {}) {
  const statusBySession = collectLiveStatus();
  // We ask for one extra row to know whether another page exists.
  const rows = await listSessions({ offset, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const pageRows = (hasMore ? rows.slice(0, limit) : rows).filter(
    (session) => !isScratchWorkingDirectory(session.cwd)
  );
  return {
    sessions: pageRows
      .map((session) => enrichSession(session, statusBySession, ownedStates, offeredSessions))
      .filter((session) => !isScratchWorkingDirectory(session.workingDirectory)),
    offset,
    limit,
    hasMore,
    liveStatus: Object.fromEntries(statusBySession)
  };
}

export async function getSession(sessionId, ownedStates = new Map(), offeredSessions = new Map()) {
  const session = await getSessionInfo(sessionId);
  if (!session) {
    return null;
  }
  return enrichSession(session, collectLiveStatus(), ownedStates, offeredSessions);
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
export function transcriptFilesFor(sessionId, { homeDirectory = os.homedir(), claudeHome = null } = {}) {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(String(sessionId))) {
    return [];
  }
  // The real home reads the Claude folder the app is set to; a made-up home
  // (the tests) reads its own .claude.
  const folder = claudeHome || (homeDirectory === os.homedir() ? currentClaudeHome() : null);
  const projectsDirectory = claudeRegistryPaths({ homeDirectory, claudeHome: folder }).projectsDirectory;
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
