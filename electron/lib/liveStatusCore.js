// The pure part of electron/liveStatus.js: reading the two Claude Code
// registries from a folder given to it, and mapping what they say onto the
// three status groups the list draws. Nothing here knows where the real
// registries live or how a pid is checked — liveStatus.js passes both in, and
// the dry tests (test/liveStatus.test.js) pass a temporary folder and their
// own `isProcessAlive` instead.
import fs from "node:fs";
import path from "node:path";

export const STATUS_GROUPS = {
  running: "running",
  waiting: "waiting",
  recent: "recent"
};

const PROCESS_STATUSES_MEANING_RUNNING = new Set(["busy", "working", "running"]);
const JOB_STATES_MEANING_RUNNING = new Set(["working", "active", "running"]);
const JOB_STATES_MEANING_WAITING = new Set(["idle", "blocked", "waiting"]);

function readJsonQuietly(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

export function listDirectoryQuietly(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    return [];
  }
}

export function groupForProcess(rawStatus) {
  if (PROCESS_STATUSES_MEANING_RUNNING.has(rawStatus)) {
    return STATUS_GROUPS.running;
  }
  return STATUS_GROUPS.waiting;
}

export function groupForJob(rawState) {
  if (JOB_STATES_MEANING_RUNNING.has(rawState)) {
    return STATUS_GROUPS.running;
  }
  if (JOB_STATES_MEANING_WAITING.has(rawState)) {
    return STATUS_GROUPS.waiting;
  }
  return STATUS_GROUPS.recent;
}

// One entry per <pid>.json whose process is still alive.
export function readProcessRegistry({ sessionsRegistryDirectory, isProcessAlive }) {
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

// One entry per jobs/<shortId>/state.json.
export function readJobRegistry({ jobsRegistryDirectory }) {
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

// sessionId -> { group, source, rawStatus, name, jobId, pid, needs }.
// Jobs first, so a verified live process wins over the job state.
export function collectLiveStatusFrom({ jobEntries = [], processEntries = [] } = {}) {
  const statusBySession = new Map();

  for (const job of jobEntries) {
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

  for (const processEntry of processEntries) {
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
