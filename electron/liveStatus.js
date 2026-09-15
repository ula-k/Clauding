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
import {
  STATUS_GROUPS,
  collectLiveStatusFrom,
  listDirectoryQuietly,
  readJobRegistry,
  readProcessRegistry
} from "./lib/liveStatusCore.js";

// The mapping itself, the two registry readers and the merge live in
// lib/liveStatusCore.js, so they can be exercised against a temporary folder
// and an injected pid check; this file only names the real folders.
export { STATUS_GROUPS };

const claudeHome = path.join(os.homedir(), ".claude");
const sessionsRegistryDirectory = path.join(claudeHome, "sessions");
const jobsRegistryDirectory = path.join(claudeHome, "jobs");

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

// Returns a map: sessionId -> { group, source, rawStatus, name, jobId, pid, needs }
export function collectLiveStatus() {
  return collectLiveStatusFrom({
    jobEntries: readJobRegistry({ jobsRegistryDirectory }),
    processEntries: readProcessRegistry({ sessionsRegistryDirectory, isProcessAlive })
  });
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
