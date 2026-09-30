// The terminals open when the app closes are offered back on the next start
// (electron/openTerminals.js): written on every change, never emptied by the
// hang-ups of quitting, and nothing is spawned for them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createOpenTerminalsStore,
  mergeOpenTerminalLists,
  openTerminalEntries,
  readOpenTerminals
} from "../electron/openTerminals.js";

function scratchFile() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-open-terminals-"));
  return path.join(folder, "open-terminals.json");
}

const terminal = (sessionId, extra = {}) => ({
  terminalId: `terminal-${sessionId}`,
  sessionId,
  workingDirectory: `/work/${sessionId}`,
  agentId: null,
  sessionExtraArguments: "",
  resumable: true,
  ...extra
});

test("only terminals with a conversation to resume are kept, with what they need", () => {
  const entries = openTerminalEntries(
    [
      terminal("one", { agentId: "builder", sessionExtraArguments: "--channels plugin:telegram@x" }),
      terminal("fresh", { resumable: false }),
      { terminalId: "linking", sessionId: null, resumable: false }
    ],
    "terminal-one"
  );
  assert.deepEqual(entries, [
    {
      sessionId: "one",
      workingDirectory: "/work/one",
      agentId: "builder",
      extraArguments: "--channels plugin:telegram@x",
      selected: true
    }
  ]);
});

test("the offer stays until it is opened; one selected entry at most", () => {
  const live = [{ sessionId: "b", selected: true }];
  const offered = [{ sessionId: "a", selected: true }, { sessionId: "b", selected: false }];
  const merged = mergeOpenTerminalLists({ live, offered });
  assert.deepEqual(merged.map((entry) => entry.sessionId), ["b", "a"]);
  assert.deepEqual(merged.map((entry) => entry.selected), [true, false]);
});

test("persist, restart, restore: the previous run's terminals come back as an offer", () => {
  const filePath = scratchFile();
  const firstRun = createOpenTerminalsStore({ filePath });
  firstRun.update([terminal("one"), terminal("two", { agentId: "builder" })], "terminal-two");
  // Quitting: written once more, then frozen, then every terminal hangs up.
  firstRun.update([terminal("one"), terminal("two", { agentId: "builder" })], "terminal-two");
  firstRun.freeze();
  firstRun.update([], null);
  assert.equal(readOpenTerminals(filePath).length, 2, "the hang-ups of quitting did not empty the file");

  const secondRun = createOpenTerminalsStore({ filePath });
  const offer = secondRun.restoreOffer();
  assert.deepEqual(offer.terminals.map((entry) => entry.sessionId), ["one", "two"]);
  assert.equal(offer.selectedSessionId, "two", "the one on screen is selected again");
  assert.equal(secondRun.offeredBySession().get("two").agentId, "builder");

  // The start itself (no terminals yet) keeps the offer on disk.
  secondRun.update([], null);
  assert.equal(readOpenTerminals(filePath).length, 2);
  // A click on "one" opens it: it moves out of the offer into the live part.
  secondRun.update([terminal("one")], "terminal-one");
  assert.deepEqual([...secondRun.offeredBySession().keys()], ["two"]);
  assert.deepEqual(readOpenTerminals(filePath).map((entry) => entry.sessionId), ["one", "two"]);
});

test("a missing or broken file is simply no offer", () => {
  const filePath = scratchFile();
  assert.deepEqual(createOpenTerminalsStore({ filePath }).restoreOffer(), { terminals: [], selectedSessionId: null });
  fs.writeFileSync(filePath, "{ not json");
  assert.deepEqual(readOpenTerminals(filePath), []);
  fs.writeFileSync(filePath, JSON.stringify({ terminals: [{ sessionId: 7 }, { sessionId: "ok", agentId: 3 }] }));
  assert.deepEqual(readOpenTerminals(filePath), [
    { sessionId: "ok", workingDirectory: null, agentId: null, extraArguments: "", selected: false }
  ]);
});
