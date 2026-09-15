// CL-01, CL-02 — what the two Claude Code registries mean for a row: the
// colour group, the "needs answer" badge, and which entry wins when a job and
// a process disagree (electron/lib/liveStatusCore.js, electron/sessions.js).
//
// The registries are faked inside a throw-away folder under the system
// temporary folder and the pid check is handed in, so nothing here reads the
// real ~/.claude and no process is signalled.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STATUS_GROUPS,
  collectLiveStatusFrom,
  groupForJob,
  groupForProcess,
  readJobRegistry,
  readProcessRegistry
} from "../electron/lib/liveStatusCore.js";
import { enrichSession } from "../electron/sessions.js";

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-status-"));
}

function writeProcessEntry(folder, pid, record) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${pid}.json`), JSON.stringify(record));
}

function writeJobEntry(folder, jobId, record) {
  fs.mkdirSync(path.join(folder, jobId), { recursive: true });
  fs.writeFileSync(path.join(folder, jobId, "state.json"), JSON.stringify(record));
}

test("a live CLI process is working when busy and waiting otherwise", () => {
  assert.equal(groupForProcess("busy"), STATUS_GROUPS.running);
  assert.equal(groupForProcess("working"), STATUS_GROUPS.running);
  assert.equal(groupForProcess("running"), STATUS_GROUPS.running);
  assert.equal(groupForProcess("idle"), STATUS_GROUPS.waiting);
  assert.equal(groupForProcess(undefined), STATUS_GROUPS.waiting);
  assert.equal(groupForProcess("something new"), STATUS_GROUPS.waiting);
});

test("a job is working, waiting or finished, by its state", () => {
  assert.equal(groupForJob("working"), STATUS_GROUPS.running);
  assert.equal(groupForJob("active"), STATUS_GROUPS.running);
  assert.equal(groupForJob("blocked"), STATUS_GROUPS.waiting);
  assert.equal(groupForJob("idle"), STATUS_GROUPS.waiting);
  assert.equal(groupForJob("done"), STATUS_GROUPS.recent);
  assert.equal(groupForJob("stopped"), STATUS_GROUPS.recent);
  assert.equal(groupForJob("anything else"), STATUS_GROUPS.recent);
});

test("registry files whose process is gone are ignored", () => {
  const folder = scratchFolder();
  writeProcessEntry(folder, 111, { pid: 111, sessionId: "alive-session", status: "busy", cwd: "/somewhere" });
  writeProcessEntry(folder, 222, { pid: 222, sessionId: "dead-session", status: "busy", cwd: "/somewhere" });
  writeProcessEntry(folder, 333, { pid: 333, cwd: "/no-session-id" });
  fs.writeFileSync(path.join(folder, "notes.txt"), "not a registry file");
  fs.writeFileSync(path.join(folder, "broken.json"), "{ not json");

  const entries = readProcessRegistry({
    sessionsRegistryDirectory: folder,
    isProcessAlive(pid) {
      return pid === 111;
    }
  });
  assert.deepEqual(entries.map((entry) => entry.sessionId), ["alive-session"]);
  assert.equal(entries[0].pid, 111);
});

test("a registry file with no pid field falls back to its own file name", () => {
  const folder = scratchFolder();
  writeProcessEntry(folder, 4242, { sessionId: "named-after-the-file", status: "idle" });
  const seen = [];
  const entries = readProcessRegistry({
    sessionsRegistryDirectory: folder,
    isProcessAlive(pid) {
      seen.push(pid);
      return true;
    }
  });
  assert.deepEqual(seen, [4242]);
  assert.equal(entries[0].pid, 4242);
});

test("a missing registry folder is simply empty, not an error", () => {
  const missing = path.join(scratchFolder(), "never-created");
  assert.deepEqual(readProcessRegistry({ sessionsRegistryDirectory: missing, isProcessAlive: () => true }), []);
  assert.deepEqual(readJobRegistry({ jobsRegistryDirectory: missing }), []);
});

test("a job is matched to both its session ids", () => {
  const folder = scratchFolder();
  writeJobEntry(folder, "job-one", {
    state: "blocked",
    needs: "permission",
    sessionId: "new-transcript",
    resumeSessionId: "old-transcript",
    cwd: "/somewhere"
  });
  const jobEntries = readJobRegistry({ jobsRegistryDirectory: folder });
  assert.deepEqual(jobEntries[0].sessionIds, ["new-transcript", "old-transcript"]);

  const statusBySession = collectLiveStatusFrom({ jobEntries });
  assert.equal(statusBySession.get("new-transcript").group, STATUS_GROUPS.waiting);
  assert.equal(statusBySession.get("old-transcript").needs, "permission");
});

test("a finished job leaves no status at all, so the row is just recent", () => {
  const statusBySession = collectLiveStatusFrom({
    jobEntries: [{ jobId: "job-one", sessionIds: ["done-session"], rawState: "done" }]
  });
  assert.equal(statusBySession.has("done-session"), false);
});

test("a live process wins over the job state for the same session", () => {
  const statusBySession = collectLiveStatusFrom({
    jobEntries: [{ jobId: "job-one", sessionIds: ["shared-session"], rawState: "blocked", needs: "permission" }],
    processEntries: [{ sessionId: "shared-session", pid: 111, rawStatus: "idle" }]
  });
  const status = statusBySession.get("shared-session");
  assert.equal(status.source, "process");
  assert.equal(status.group, STATUS_GROUPS.waiting);
  assert.equal(status.needs, null, "the process entry carries no needs, so the badge goes");
});

test("the needs-answer badge is only for a job that says it is stuck", () => {
  function badgeFor(liveStatus) {
    const statusBySession = new Map(liveStatus ? [["session-one", liveStatus]] : []);
    return enrichSession({ sessionId: "session-one", cwd: "/somewhere" }, statusBySession).needsAnswer;
  }
  assert.equal(badgeFor({ group: STATUS_GROUPS.waiting, source: "job", rawStatus: "blocked", needs: null }), true);
  assert.equal(badgeFor({ group: STATUS_GROUPS.waiting, source: "job", rawStatus: "idle", needs: "an answer" }), true);
  assert.equal(badgeFor({ group: STATUS_GROUPS.waiting, source: "job", rawStatus: "idle", needs: null }), false);
  assert.equal(
    badgeFor({ group: STATUS_GROUPS.waiting, source: "process", rawStatus: "idle", needs: null }),
    false,
    "a CLI sitting at its prompt is not waiting for an answer"
  );
  assert.equal(badgeFor(null), false);
});

test("a session with no live entry at all is recent and unowned", () => {
  const row = enrichSession({ sessionId: "session-one", cwd: "/somewhere" }, new Map());
  assert.equal(row.statusGroup, STATUS_GROUPS.recent);
  assert.equal(row.ownedByApp, false);
  assert.equal(row.liveStatus, null);
});

test("a session running in one of the app's own terminals is marked as ours", () => {
  const ownedStates = new Map([["session-one", { terminalId: "terminal-one", pid: 999, registryStatus: "busy" }]]);
  const row = enrichSession({ sessionId: "session-one", cwd: "/somewhere" }, new Map(), ownedStates);
  assert.equal(row.ownedByApp, true);
  assert.equal(row.statusGroup, STATUS_GROUPS.running);
  assert.equal(row.liveStatus.source, "app");
  assert.equal(row.liveStatus.terminalId, "terminal-one");

  const idle = enrichSession(
    { sessionId: "session-one", cwd: "/somewhere" },
    new Map(),
    new Map([["session-one", { terminalId: "terminal-one", pid: 999, registryStatus: "idle" }]])
  );
  assert.equal(idle.statusGroup, STATUS_GROUPS.waiting);
});

test("what the registry says about our own terminal still decides its colour", () => {
  const statusBySession = new Map([
    ["session-one", { group: STATUS_GROUPS.running, source: "process", rawStatus: "busy", needs: null }]
  ]);
  const ownedStates = new Map([["session-one", { terminalId: "terminal-one", pid: 999, registryStatus: "idle" }]]);
  const row = enrichSession({ sessionId: "session-one", cwd: "/somewhere" }, statusBySession, ownedStates);
  assert.equal(row.statusGroup, STATUS_GROUPS.running);
  assert.equal(row.liveStatus.source, "app");
});
