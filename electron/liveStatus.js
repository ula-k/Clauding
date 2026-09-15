// Live status of Claude Code sessions, derived READ-ONLY from the two
// registries the CLI keeps under ~/.claude:
//
//   ~/.claude/sessions/<pid>.json   one file per running CLI process
//   ~/.claude/jobs/<shortId>/state.json   one file per background job
//
// Observed values on this Mac (CLI 2.1.270), see README for the mapping:
//   sessions/<pid>.json  status: "busy" | "idle"
//   jobs/*/state.json    state:  "working" | "blocked" | "done" | "stopped"
//                        tempo:  "active" | "idle" | "blocked"
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const STATUS_GROUPS = {
  running: "running",
  waiting: "waiting",
  recent: "recent"
};

const PROCESS_STATUSES_MEANING_RUNNING = new Set(["busy", "working", "running"]);
const JOB_STATES_MEANING_RUNNING = new Set(["working", "active", "running"]);
const JOB_STATES_MEANING_WAITING = new Set(["idle", "blocked", "waiting"]);

const claudeHome = path.join(os.homedir(), ".claude");
const sessionsRegistryDirectory = path.join(claudeHome, "sessions");
const jobsRegistryDirectory = path.join(claudeHome, "jobs");

function readJsonQuietly(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function listDirectoryQuietly(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    return [];
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error && error.code === "EPERM";
  }
}

function readProcessRegistry() {
  const entries = [];
  for (const entry of listDirectoryQuietly(sessionsRegistryDirectory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const record = readJsonQuietly(path.join(sessionsRegistryDirectory, entry.name));
    if (!record || typeof record.sessionId !== "string") {
      continue;
    }
    const pid = Number(record.pid || path.basename(entry.name, ".json"));
    if (!isProcessAlive(pid)) {
      continue;
    }
    entries.push({
      sessionId: record.sessionId,
      pid,
      workingDirectory: record.cwd,
      name: record.name,
      jobId: record.jobId,
      kind: record.kind,
      rawStatus: record.status,
      updatedAt: record.statusUpdatedAt || record.updatedAt
    });
  }
  return entries;
}

function readJobRegistry() {
  const entries = [];
  for (const entry of listDirectoryQuietly(jobsRegistryDirectory)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const record = readJsonQuietly(path.join(jobsRegistryDirectory, entry.name, "state.json"));
    if (!record) {
      continue;
    }
    entries.push({
      jobId: entry.name,
      sessionIds: [record.sessionId, record.resumeSessionId].filter(
        (value) => typeof value === "string"
      ),
      workingDirectory: record.cwd,
      name: record.name,
      intent: record.displayIntent || record.intent,
      rawState: record.state,
      tempo: record.tempo,
      needs: record.needs,
      detail: record.detail,
      updatedAt: record.updatedAt
    });
  }
  return entries;
}

function groupForProcess(rawStatus) {
  if (PROCESS_STATUSES_MEANING_RUNNING.has(rawStatus)) {
    return STATUS_GROUPS.running;
  }
  return STATUS_GROUPS.waiting;
}

function groupForJob(rawState) {
  if (JOB_STATES_MEANING_RUNNING.has(rawState)) {
    return STATUS_GROUPS.running;
  }
  if (JOB_STATES_MEANING_WAITING.has(rawState)) {
    return STATUS_GROUPS.waiting;
  }
  return STATUS_GROUPS.recent;
}

// Returns a map: sessionId -> { group, source, rawStatus, name, jobId, pid, needs }
export function collectLiveStatus() {
  const statusBySession = new Map();

  // Jobs first, so a verified live process can override them below.
  for (const job of readJobRegistry()) {
    const group = groupForJob(job.rawState);
    if (group === STATUS_GROUPS.recent) {
      continue;
    }
    for (const sessionId of job.sessionIds) {
      statusBySession.set(sessionId, {
        group,
        source: "job",
        rawStatus: job.rawState,
        name: job.name,
        jobId: job.jobId,
        needs: job.needs || null,
        workingDirectory: job.workingDirectory,
        updatedAt: job.updatedAt
      });
    }
  }

  for (const processEntry of readProcessRegistry()) {
    statusBySession.set(processEntry.sessionId, {
      group: groupForProcess(processEntry.rawStatus),
      source: "process",
      rawStatus: processEntry.rawStatus,
      name: processEntry.name,
      jobId: processEntry.jobId || null,
      pid: processEntry.pid,
      needs: null,
      workingDirectory: processEntry.workingDirectory,
      updatedAt: processEntry.updatedAt
    });
  }

  return statusBySession;
}

export function liveStatusAsObject() {
  return Object.fromEntries(collectLiveStatus());
}

// Watches both registries and calls `onChange` (debounced) whenever anything
// inside them moves. Returns a function that stops watching.
export function watchLiveStatus(onChange, debounceMilliseconds = 300) {
  const watchers = [];
  let debounceTimer = null;

  function scheduleChange() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange();
    }, debounceMilliseconds);
  }

  function watchDirectory(directoryPath) {
    try {
      const watcher = fs.watch(directoryPath, { persistent: false }, scheduleChange);
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch (error) {
      // The directory may not exist yet; nothing to watch.
    }
  }

  watchDirectory(sessionsRegistryDirectory);
  watchDirectory(jobsRegistryDirectory);
  // Each job keeps its state.json inside its own folder, so watch those
  // folders one by one (a recursive watch would also cover tmp/ scratch
  // folders, which can be huge).
  for (const entry of listDirectoryQuietly(jobsRegistryDirectory)) {
    if (entry.isDirectory()) {
      watchDirectory(path.join(jobsRegistryDirectory, entry.name));
    }
  }

  // Processes can die without touching any file; poll the pids gently.
  const heartbeat = setInterval(scheduleChange, 15000);

  return function stopWatching() {
    clearInterval(heartbeat);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}
