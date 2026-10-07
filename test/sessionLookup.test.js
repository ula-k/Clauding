// Opening a session by its id when the loaded list does not hold its row
// (src/renderer/sessionLookup.js), the sessions the first page always
// carries (mergePinnedSessions) and the main-process reading by id
// (lookupSessionForOpen) in electron/sessions.js.
//
// Dry: no window, no Electron, no SDK call, no `claude`. The reading by id
// is handed a stand-in for the SDK's getSessionInfo.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collidingTitleSuffixes,
  findKnownSession,
  lookupFailureKey,
  mergeSessionPages,
  openPlanForSession,
  rememberFetchedSession,
  selectionRoute,
  shortSessionId
} from "../src/renderer/sessionLookup.js";
import { lookupSessionForOpen, mergePinnedSessions } from "../electron/sessions.js";

const LINKED_ID = "11111111-2222-4333-8444-555555555555";
const CONTINUATION_ID = "66666666-7777-4888-8999-000000000000";

function row(sessionId, extra = {}) {
  return { sessionId, title: "row", workingDirectory: "/Users/someone/projects/claude", folderMissing: false, ...extra };
}

test("a click on a session the loaded pages do not hold asks for it by id, never gives up", () => {
  const loaded = [[row(CONTINUATION_ID, { title: "research" })], []];
  assert.deepEqual(selectionRoute(LINKED_ID, { terminals: [], loaded, linked: [] }), { kind: "lookup" });
});

test("an agent's sub-row whose session is only in the Agents tab opens from that row", () => {
  const linkedRow = row(LINKED_ID, { title: "research" });
  const route = selectionRoute(LINKED_ID, { terminals: [], loaded: [[], []], linked: [linkedRow] });
  assert.equal(route.kind, "linked");
  assert.equal(route.session, linkedRow);
});

test("a terminal that holds the session wins over any row, a loaded row over a linked one", () => {
  const terminal = { terminalId: "terminal-1", sessionId: LINKED_ID };
  const loadedRow = row(LINKED_ID);
  assert.equal(selectionRoute(LINKED_ID, { terminals: [terminal], loaded: [[loadedRow]] }).kind, "terminal");
  const route = selectionRoute(LINKED_ID, { loaded: [[], [loadedRow]], linked: [row(LINKED_ID)] });
  assert.equal(route.kind, "known");
  assert.equal(route.session, loadedRow);
});

test("two sessions with one title are never confused: the id decides", () => {
  const builder = row(LINKED_ID, { title: "research" });
  const background = row(CONTINUATION_ID, { title: "research" });
  assert.equal(findKnownSession(LINKED_ID, [[background, builder]]), builder);
  assert.equal(findKnownSession(CONTINUATION_ID, [[builder], [background]]), background);
  assert.equal(findKnownSession(null, [[builder]]), null);
});

test("what a click does with the row it found", () => {
  assert.equal(openPlanForSession(row(LINKED_ID)), "resume");
  assert.equal(openPlanForSession(row(LINKED_ID, { workingDirectory: null })), "folder");
  assert.equal(openPlanForSession(row(LINKED_ID, { folderMissing: true })), "folder");
  assert.equal(openPlanForSession(null), "folder");
  // Resumed in Terminal.app: the open guard's "running elsewhere" note.
  assert.equal(openPlanForSession(row(LINKED_ID, { liveStatus: { source: "registry", group: "running" } })), "elsewhere");
  assert.equal(openPlanForSession(row(LINKED_ID, { liveStatus: { source: "app", group: "running" } })), "resume");
});

test("a lookup that found nothing says why, in a locale key", () => {
  assert.equal(lookupFailureKey("not-found"), "middle.sessionNotFound");
  assert.equal(lookupFailureKey("invalid-id"), "middle.sessionInvalidId");
  assert.equal(lookupFailureKey("unreadable"), "middle.sessionUnreadable");
  assert.equal(lookupFailureKey(undefined), "middle.sessionUnreadable");
});

test("a row read by id is kept once, the newest reading wins", () => {
  const first = row(LINKED_ID, { title: "old" });
  const second = row(LINKED_ID, { title: "new" });
  const kept = rememberFetchedSession(rememberFetchedSession([], first), second);
  assert.deepEqual(kept, [second]);
  assert.equal(rememberFetchedSession(kept, null), kept);
});

test("a later page never draws a row twice", () => {
  const firstPage = [row("a"), row(LINKED_ID)];
  const merged = mergeSessionPages(firstPage, [row("b"), row(LINKED_ID)]);
  assert.deepEqual(merged.map((session) => session.sessionId), ["a", LINKED_ID, "b"]);
  assert.equal(mergeSessionPages(firstPage, [row("a")]), firstPage);
});

test("same-named sessions get a short id on hover, others do not", () => {
  const suffixes = collidingTitleSuffixes([
    row(LINKED_ID, { title: "research" }),
    row(CONTINUATION_ID, { title: "Research " }),
    row("1234abcd-0000", { title: "logging" })
  ]);
  assert.equal(suffixes.get(LINKED_ID), "11111111");
  assert.equal(suffixes.get(CONTINUATION_ID), "66666666");
  assert.equal(suffixes.has("1234abcd-0000"), false);
  assert.equal(shortSessionId(LINKED_ID), "11111111");
});

test("the first page carries a pinned session the SDK left out, in date order", () => {
  const page = [
    { sessionId: "newest", lastModified: 300 },
    { sessionId: CONTINUATION_ID, lastModified: 200 }
  ];
  const pinned = [{ sessionId: LINKED_ID, lastModified: 250 }];
  const merged = mergePinnedSessions(page, pinned, { firstPage: true });
  assert.deepEqual(merged.map((session) => session.sessionId), ["newest", LINKED_ID, CONTINUATION_ID]);
  // Already on the page: nothing added.
  assert.equal(mergePinnedSessions(page, [{ sessionId: "newest", lastModified: 300 }]), page);
});

test("a later page leaves the pinned sessions out, the first page had them", () => {
  const page = [{ sessionId: "older" }, { sessionId: LINKED_ID }];
  const merged = mergePinnedSessions(page, [{ sessionId: LINKED_ID }], { firstPage: false });
  assert.deepEqual(merged.map((session) => session.sessionId), ["older"]);
});

test("reading a session by id answers with its row, or with the reason it could not", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-lookup-"));
  try {
    // An id no transcript on this machine carries, so the folder comes from
    // the stand-in alone.
    const madeUpId = "00000000-dry0-4000-8000-lookup000001";
    const found = await lookupSessionForOpen(madeUpId, {
      readSessionInfo: async (sessionId) => ({
        sessionId,
        customTitle: "research",
        summary: "research",
        cwd: folder,
        lastModified: 1791395401785
      })
    });
    assert.equal(found.reason, null);
    assert.equal(found.session.sessionId, madeUpId);
    assert.equal(found.session.title, "research");
    assert.equal(found.session.workingDirectory, folder);
    assert.equal(found.session.folderMissing, false);

    const missing = await lookupSessionForOpen(LINKED_ID, { readSessionInfo: async () => undefined });
    assert.deepEqual(missing, { session: null, reason: "not-found" });

    const broken = await lookupSessionForOpen(LINKED_ID, {
      readSessionInfo: async () => {
        throw new Error("disk said no");
      }
    });
    assert.equal(broken.reason, "unreadable");
    assert.match(broken.detail, /disk said no/);

    const invalid = await lookupSessionForOpen("../etc/passwd", { readSessionInfo: async () => ({}) });
    assert.equal(invalid.reason, "invalid-id");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
