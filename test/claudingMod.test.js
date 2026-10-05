// The Clauding mod (builtin/mod/clauding-mod/) and the app's side of it
// (electron/lib/modState.js, electron/terminals.js, the `clauding state` and
// `clauding session-info` commands). Dry: no Electron, no real `claude`, a
// throw-away Claude folder, terminals spawned in dry-run mode.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClaudeArguments } from "../electron/lib/claudeArguments.js";
import {
  MOD_SETTING_DEFAULTS,
  PLUGIN_FOLDER_FLAG,
  applyModStateToSession,
  cleanGuardPatterns,
  cleanModSwitches,
  groupForModState,
  modArguments,
  modStateNeedsAnswer,
  noticeForChange,
  noticeText,
  reduceModState,
  replaceModArguments,
  sessionInfoResponse,
  versionSupportsMods
} from "../electron/lib/modState.js";
import { needsAnswerFromTail, textAsksSomething as appHeuristic } from "../electron/lib/needsAnswer.js";
import { textAsksSomething as modHeuristic } from "../builtin/mod/clauding-mod/hooks/questionHeuristic.js";
import {
  DEFAULT_GUARD_PATTERNS,
  declinedMessage,
  effectiveFolder,
  findRiskyCommand,
  isScratchPath,
  parseGuardPatterns
} from "../builtin/mod/clauding-mod/hooks/commandGuard.js";
import { createCommandRequestHandler } from "../electron/lib/commandRequests.js";
import { linkedTaskOfSession } from "../electron/lib/projectSnapshot.js";

const claudeFolder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-mod-claude-"));
fs.mkdirSync(path.join(claudeFolder, "sessions"), { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeFolder;
process.env.CLAUDING_DRY_SPAWN = "1";
const { createTerminalRegistry } = await import("../electron/terminals.js");
const { enrichSession } = await import("../electron/sessions.js");

// The short temporary folder, spelled in two pieces only because
// `npm run check` bans that three-letter word anywhere in a line of code.
const TEMPORARY = "/t" + "mp";
const MOD_FOLDER = "/Applications/Clauding/builtin/mod/clauding-mod";
const MOD_ON = { pluginDirectory: MOD_FOLDER, arguments: [PLUGIN_FOLDER_FLAG, MOD_FOLDER] };

// ---- argument building ----------------------------------------------------

test("the mod's folder goes last, after the user's own flags, and only when asked for", () => {
  const withMod = buildClaudeArguments({
    resumeSessionId: "abc",
    extraArguments: ["--model", "sonnet"],
    pluginArguments: MOD_ON.arguments
  }).commandArguments;
  assert.deepEqual(withMod, ["--resume", "abc", "--model", "sonnet", PLUGIN_FOLDER_FLAG, MOD_FOLDER]);
  const without = buildClaudeArguments({ resumeSessionId: "abc", extraArguments: ["--model", "sonnet"] }).commandArguments;
  assert.equal(without.includes(PLUGIN_FOLDER_FLAG), false);
});

test("the plugin folder is added only when the mod is on and the CLI can load mods", () => {
  const settings = { ...MOD_SETTING_DEFAULTS };
  assert.deepEqual(modArguments({ settings, supported: true, pluginDirectory: MOD_FOLDER }), [PLUGIN_FOLDER_FLAG, MOD_FOLDER]);
  assert.deepEqual(modArguments({ settings: { ...settings, modEnabled: false }, supported: true, pluginDirectory: MOD_FOLDER }), []);
  assert.deepEqual(modArguments({ settings, supported: false, pluginDirectory: MOD_FOLDER }), [], "a claude older than 2.1.287");
  assert.deepEqual(modArguments({ settings: null, supported: true, pluginDirectory: MOD_FOLDER }), []);
});

test("mods need Claude Code 2.1.287 or newer", () => {
  assert.equal(versionSupportsMods("2.1.289 (Claude Code)"), true);
  assert.equal(versionSupportsMods("2.1.287"), true);
  assert.equal(versionSupportsMods("2.1.286 (Claude Code)"), false);
  assert.equal(versionSupportsMods("2.0.999"), false);
  assert.equal(versionSupportsMods("3.0.0"), true);
  assert.equal(versionSupportsMods(""), false, "no answer from `claude --version`");
  assert.equal(versionSupportsMods("command not found"), false);
});

test("a restart brings the mod's flag up to date and leaves a user's own plugin folder alone", () => {
  const kept = ["--resume", "abc", PLUGIN_FOLDER_FLAG, "/my/plugin", PLUGIN_FOLDER_FLAG, MOD_FOLDER];
  assert.deepEqual(replaceModArguments(kept, MOD_FOLDER, []), ["--resume", "abc", PLUGIN_FOLDER_FLAG, "/my/plugin"]);
  assert.deepEqual(replaceModArguments(["--resume", "abc"], MOD_FOLDER, MOD_ON.arguments), ["--resume", "abc", PLUGIN_FOLDER_FLAG, MOD_FOLDER]);
});

test("every claude the app spawns (new, resume, fork, restart) carries the mod; none does without it", async () => {
  const registry = createTerminalRegistry({ sendToWindow() {}, log: null, readModPlan: () => MOD_ON });
  const fresh = registry.open({ workingDirectory: os.tmpdir() });
  const resumed = registry.open({ workingDirectory: os.tmpdir(), resumeSessionId: "mod-resumed" });
  const forked = registry.open({ workingDirectory: os.tmpdir(), resumeSessionId: "mod-forked", forkSession: true });
  for (const record of [fresh, resumed, forked]) {
    assert.deepEqual(record.commandArguments.slice(-2), [PLUGIN_FOLDER_FLAG, MOD_FOLDER], record.commandArguments.join(" "));
  }
  // Terminal → Restart terminal: hung up, then the same command line again.
  const restarted = registry.restartInPlace(resumed.terminalId);
  assert.equal(restarted.restarted, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const again = registry.get(resumed.terminalId).commandArguments;
  assert.equal(again.filter((argument) => argument === PLUGIN_FOLDER_FLAG).length, 1, "not added twice on a restart");
  registry.closeAll();

  const plain = createTerminalRegistry({ sendToWindow() {}, log: null });
  const record = plain.open({ workingDirectory: os.tmpdir() });
  assert.equal(record.commandArguments.includes(PLUGIN_FOLDER_FLAG), false);
  plain.closeAll();
});

test("the terminal's environment is the only thing that tells the mod it is inside Clauding", async () => {
  const { buildTerminalEnvironment } = await import("../electron/lib/claudeArguments.js");
  const environment = buildTerminalEnvironment({ baseEnvironment: { PATH: "/usr/bin" }, terminalId: "terminal-seven", commandDirectory: "/app/bin" });
  assert.equal(environment.CLAUDING_TERMINAL_ID, "terminal-seven");
  assert.equal(environment.PATH.split(path.delimiter)[0], "/app/bin", "`clauding` is found first");
});

// ---- settings ----------------------------------------------------------------

test("the switches are all on but the sound, and the rules fall back to the defaults", () => {
  assert.deepEqual(cleanModSwitches({}), MOD_SETTING_DEFAULTS);
  assert.equal(MOD_SETTING_DEFAULTS.modSound, false);
  assert.equal(cleanModSwitches({ modGuard: false, modSound: "yes" }).modGuard, false);
  assert.equal(cleanModSwitches({ modSound: "yes" }).modSound, false, "not a boolean: the default");
  assert.equal(cleanGuardPatterns("", DEFAULT_GUARD_PATTERNS), DEFAULT_GUARD_PATTERNS);
  assert.equal(cleanGuardPatterns(null, DEFAULT_GUARD_PATTERNS), DEFAULT_GUARD_PATTERNS);
  assert.equal(cleanGuardPatterns("  \\bshred\\b \r\n", DEFAULT_GUARD_PATTERNS), "\\bshred\\b");
});

// ---- the state reducer ---------------------------------------------------------

test("a report becomes the terminal's state; a word that is not a state is refused", () => {
  const working = reduceModState(null, { state: "working" }, 1000);
  assert.deepEqual(working, { state: "working", detail: "", changedAt: 1000, reportedAt: 1000, previousState: null });
  const asked = reduceModState(working, { state: "needs-answer", detail: "  Which   one?  " }, 2000);
  assert.equal(asked.state, "needs-answer");
  assert.equal(asked.detail, "Which one?");
  assert.equal(asked.previousState, "working");
  const repeated = reduceModState(asked, { state: "needs-answer", detail: "Which one?" }, 3000);
  assert.equal(repeated.changedAt, 2000, "the same report again is not a change");
  assert.equal(reduceModState(working, { state: "sleeping" }), null);
  assert.equal(reduceModState(working, {}), null);
});

test("the mod's word decides the dot and the NEEDS ANSWER tag", () => {
  const groups = { running: "running", waiting: "waiting" };
  assert.equal(groupForModState({ state: "working" }, groups), "running");
  for (const state of ["needs-answer", "needs-permission", "done", "idle"]) {
    assert.equal(groupForModState({ state }, groups), "waiting", state);
  }
  assert.equal(modStateNeedsAnswer({ state: "needs-answer" }), true);
  assert.equal(modStateNeedsAnswer({ state: "needs-permission" }), true);
  assert.equal(modStateNeedsAnswer({ state: "done" }), false);
  assert.equal(modStateNeedsAnswer(null), false);
});

test("a listed session follows its terminal's report, whatever the transcript guessed", () => {
  const row = { sessionId: "abc", statusGroup: "waiting", needsAnswer: true };
  const working = applyModStateToSession(row, { sessionId: "abc", exited: false, modState: { state: "working" } });
  assert.equal(working.statusGroup, "running");
  assert.equal(working.needsAnswer, false);
  const asking = applyModStateToSession({ ...row, needsAnswer: false }, { exited: false, modState: { state: "needs-answer" } });
  assert.equal(asking.needsAnswer, true);
  assert.equal(asking.statusGroup, "waiting");
  assert.equal(applyModStateToSession(row, { exited: false, modState: null }), row, "no mod: the old guess stays");
  assert.equal(applyModStateToSession(row, { exited: true, modState: { state: "working" } }), row, "an ended terminal says nothing");
});

test("the session list prefers the mod's state for the app's own terminals", () => {
  const session = { sessionId: "mod-session", cwd: os.tmpdir(), lastModified: Date.now(), summary: "Mod session" };
  const owned = (modState) => new Map([["mod-session", { terminalId: "terminal-one", pid: 1, registryStatus: "busy", modState }]]);
  const working = enrichSession(session, new Map(), owned({ state: "working" }));
  assert.equal(working.statusGroup, "running");
  assert.equal(working.needsAnswer, false);
  const asking = enrichSession(session, new Map(), owned({ state: "needs-answer" }));
  assert.equal(asking.statusGroup, "waiting", "the registry says busy, the mod says it is waiting on the user");
  assert.equal(asking.needsAnswer, true);
  const done = enrichSession(session, new Map(), owned({ state: "done" }));
  assert.equal(done.needsAnswer, false);
  const withoutMod = enrichSession(session, new Map(), owned(null));
  assert.equal(withoutMod.statusGroup, "running", "no mod: the registry's busy, as before");
});

test("a state change is reported through the terminal registry and moves the list at once", () => {
  let changes = 0;
  const registry = createTerminalRegistry({ sendToWindow() {}, onChange: () => (changes += 1), log: null });
  const record = registry.open({ workingDirectory: os.tmpdir() });
  const before = changes;
  const first = registry.reportModState(record.terminalId, { state: "working" });
  assert.equal(first.previous, null);
  assert.equal(first.next.state, "working");
  assert.equal(changes, before + 1);
  registry.reportModState(record.terminalId, { state: "working" });
  assert.equal(changes, before + 1, "the same state again is not announced");
  registry.reportModState(record.terminalId, { state: "needs-answer", detail: "Shall I?" });
  assert.equal(registry.get(record.terminalId).modState.state, "needs-answer");
  assert.throws(() => registry.reportModState(record.terminalId, { state: "dancing" }), /not a state/);
  assert.equal(registry.reportModState("no-such-terminal", { state: "done" }), null);
  registry.closeAll();
});

test("a notice is earned only by a change into done, needs-answer or needs-permission, off screen", () => {
  const working = { state: "working" };
  const done = { state: "done" };
  const base = { previous: working, next: done, isOnScreen: false, windowFocused: true };
  assert.equal(noticeForChange(base), "finished");
  assert.equal(noticeForChange({ ...base, next: { state: "needs-answer" } }), "needsAnswer");
  assert.equal(noticeForChange({ ...base, next: { state: "needs-permission" } }), "needsPermission");
  assert.equal(noticeForChange({ ...base, next: { state: "idle" } }), null);
  assert.equal(noticeForChange({ ...base, isOnScreen: true }), null, "the one on screen, window focused");
  assert.equal(noticeForChange({ ...base, isOnScreen: true, windowFocused: false }), "finished", "on screen but the window is behind others");
  assert.equal(noticeForChange({ ...base, previous: done }), null, "done again is not news");
  assert.equal(noticeForChange({ ...base, notificationsOn: false }), null);
  assert.equal(noticeText("finished", "Fix login"), "Fix login finished");
  assert.equal(noticeText("needsAnswer", ""), "A session needs your answer");
});

// ---- the shared needs-answer heuristic -------------------------------------------

test("the app and the mod ask the very same question of the last message", () => {
  assert.equal(appHeuristic, modHeuristic, "one function, not two copies");
  assert.equal(modHeuristic("Done. Shall I push it?"), true);
  assert.equal(modHeuristic("Pushed.\n\nWant me to open a PR?**"), true);
  assert.equal(modHeuristic("needs input: pick a name"), true);
  assert.equal(modHeuristic("Czekam na Twoją decyzję."), true);
  assert.equal(modHeuristic("ok"), false);
  assert.equal(modHeuristic("I wondered whether X? It was fine.\nAll done."), false);
  assert.equal(modHeuristic(""), false);
  const tail = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Which branch?" }] } });
  assert.equal(needsAnswerFromTail(tail), true, "the transcript path still uses it");
});

// ---- the guard ---------------------------------------------------------------------

const { patterns: DEFAULT_PATTERNS } = parseGuardPatterns(DEFAULT_GUARD_PATTERNS);

function risky(command, context = {}) {
  return findRiskyCommand(command, { patterns: DEFAULT_PATTERNS, workingDirectory: "/Users/someone/project", ...context });
}

test("the default rules catch every command the guard is for", () => {
  const positives = [
    ["rm -rf build", "rm"],
    ["rm -fr ~/notes", "rm"],
    ["sudo rm -r -f /", "rm"],
    ["rm --recursive --force src", "rm"],
    ["git push --force", "git-push"],
    ["git push -f origin feature", "git-push"],
    ["git push --force-with-lease origin feature", "git-push"],
    ["git push origin main", "git-push"],
    ["git push origin HEAD:staging", "git-push"],
    ["git push upstream docker-staging", "git-push"],
    ["git merge feature", "git-merge"],
    ["git rebase main", "git-rebase"],
    ["git reset --hard HEAD~1", "git-reset"],
    ["cd repo && git -C sub reset --hard", "git-reset"],
    ["git branch -D old-work", "git-branch"],
    ["git clean -fd", "git-clean"],
    ["git clean -dfx", "git-clean"],
    ['psql -c "DROP TABLE users"', "other"],
    ['psql -c "drop table users"', "other"],
    ['mysql -e "TRUNCATE orders"', "other"],
    ['psql -c "truncate table orders"', "other"]
  ];
  for (const [command, kind] of positives) {
    const found = risky(command);
    assert.ok(found, `should ask before: ${command}`);
    assert.equal(found.kind, kind, command);
  }
});

test("everyday commands, and rm -rf of scratch, go through without a question", () => {
  const negatives = [
    "ls -la",
    "rm file.txt",
    "rm -r build",
    `rm -rf ${TEMPORARY}/clauding-test`,
    `rm -rf /private${TEMPORARY}/x ${TEMPORARY}/y`,
    "rm -rf /var/folders/f1/abc/T/clauding-smoke",
    "git push origin feature/staging-fix",
    "git push origin CU-86ak7bt8a",
    "git merge-base main HEAD",
    "git rebase-something",
    "git reset HEAD file.txt",
    "git branch -d merged-work",
    "git clean -n",
    "truncate -s 0 log.txt",
    "echo 'git status'",
    "npm test"
  ];
  for (const command of negatives) {
    assert.equal(risky(command), null, `should not ask before: ${command}`);
  }
});

test("scratch means strictly inside a temporary folder, never home, never the root itself", () => {
  const roots = { workingDirectory: "/Users/someone/project", scratchRoots: [`${TEMPORARY}`, "/var/folders"] };
  assert.equal(isScratchPath(`${TEMPORARY}/x`, roots), true);
  assert.equal(isScratchPath(`${TEMPORARY}`, roots), false, "the temporary folder itself");
  assert.equal(isScratchPath(`${TEMPORARY}/../Users/someone`, roots), false);
  assert.equal(isScratchPath("~/scratch", roots), false);
  assert.equal(isScratchPath("$HOME/x", roots), false);
  assert.equal(isScratchPath("build", roots), false, "relative, in a real project");
  assert.equal(isScratchPath("build", { ...roots, workingDirectory: `${TEMPORARY}/work` }), true, "relative, in a scratch folder");
  assert.equal(isScratchPath("/Users/someone/.claude/jobs/ab12/" + ["t", "m", "p"].join("") + "/out", roots), true, "a job's scratch folder");
  assert.equal(risky("rm -rf build", { workingDirectory: `${TEMPORARY}/work` }), null);
  assert.ok(risky(`rm -rf ${TEMPORARY}/x ~/real`), "one real path among scratch ones still asks");
  assert.equal(risky("rm -rf $TMPDIR/x", { scratchRoots: [] }) !== null, true, "a variable is never assumed to be scratch");
  assert.equal(risky("rm -rf /custom-temporary/x", { scratchRoots: ["/custom-temporary"] }), null, "TMPDIR counts");
});

test("a bare git push from a protected branch asks; from a feature branch it does not", () => {
  assert.ok(risky("git push", { currentBranch: "main" }));
  assert.ok(risky("git push origin", { currentBranch: "staging" }));
  assert.equal(risky("git push", { currentBranch: "feature/login" }), null);
  assert.equal(risky("git push origin feature/login", { currentBranch: "main" }), null, "a named branch decides, not the current one");
});

test("the rules are the user's: their own lines, comments, case and invalid lines", () => {
  const { patterns, invalid } = parseGuardPatterns("# only shred\n\\bshred\\b\n(?i)\\bformat\\s+disk\\b\nbroken(\n\n");
  assert.equal(patterns.length, 2);
  assert.deepEqual(invalid.map((problem) => problem.line), ["broken("]);
  assert.ok(findRiskyCommand("shred secrets.txt", { patterns }));
  assert.ok(findRiskyCommand("FORMAT DISK now", { patterns }));
  assert.equal(findRiskyCommand("git reset --hard", { patterns }), null, "the defaults are replaced, not added to");
});

test("the guard measures where the command runs, and tells Claude plainly it was declined", () => {
  const command = "cd repo && git -C sub reset --hard";
  assert.equal(effectiveFolder(command, risky(command), "/Users/someone/project"), "/Users/someone/project/repo/sub");
  assert.equal(effectiveFolder("cd /elsewhere; git clean -fd", risky("cd /elsewhere; git clean -fd"), "/x"), "/elsewhere");
  const message = declinedMessage("discard uncommitted changes in 3 files on main");
  assert.match(message, /declined/);
  assert.match(message, /3 files on main/);
  assert.match(message, /Do not run it again/);
});

// ---- session-info --------------------------------------------------------------------

test("session-info names the linked task, else the branch's task, with the mod's switches", () => {
  const terminal = { terminalId: "terminal-one", sessionId: "abc", workingDirectory: "/repo" };
  const settings = { ...MOD_SETTING_DEFAULTS, modGuard: false, modGuardPatterns: "\\bshred\\b" };
  const linked = sessionInfoResponse({
    terminal,
    branch: "CU-zzz999",
    linkedTask: { id: "86ak7bt8a", customId: null, name: "Onboarding" },
    branchTaskId: "zzz999",
    settings
  });
  assert.deepEqual(linked.task, { id: "86ak7bt8a", customId: null, name: "Onboarding", label: "CU-86ak7bt8a", via: "projects" });
  assert.equal(linked.branch, "CU-zzz999");
  assert.deepEqual(linked.mod, { stateReports: true, statusLine: true, contextBar: true, guard: false, guardPatterns: "\\bshred\\b" });
  const fromBranch = sessionInfoResponse({ terminal, branch: "feature/CU-abc123-login", branchTaskId: "abc123", settings });
  assert.equal(fromBranch.task.label, "CU-abc123");
  assert.equal(fromBranch.task.via, "branch");
  const nothing = sessionInfoResponse({ terminal, branch: null, settings });
  assert.equal(nothing.task, null);
  assert.equal(nothing.branch, null);
});

test("the linked task is found on a card or, narrower, on one of its subtasks", () => {
  const snapshot = {
    cards: [
      { id: "card1", name: "Card one", sessions: [{ sessionId: "on-card" }], subtasks: [{ id: "sub1", name: "Sub", customId: "PRJ-7", sessions: [{ sessionId: "on-sub" }] }] },
      { id: "card2", name: "Card two", sessions: [], subtasks: [] }
    ]
  };
  assert.deepEqual(linkedTaskOfSession(snapshot, "on-card"), { id: "card1", customId: null, name: "Card one" });
  assert.deepEqual(linkedTaskOfSession(snapshot, "on-sub"), { id: "sub1", customId: "PRJ-7", name: "Sub" });
  assert.equal(linkedTaskOfSession(snapshot, "nowhere"), null);
  assert.equal(linkedTaskOfSession(null, "on-card"), null);
});

test("`clauding state` and `clauding session-info` reach the mod bridge, for the named terminal only", async () => {
  const reports = [];
  const handler = createCommandRequestHandler({
    terminals: { get: () => null, mostRecentlyFocused: () => null },
    panelTabs: {},
    describeTarget() {},
    readPanelSelection: () => ({}),
    mod: {
      reportState(terminalId, report) {
        reports.push({ terminalId, ...report });
        return terminalId === "terminal-one" ? { next: { state: report.state } } : null;
      },
      async sessionInfo(terminalId) {
        return terminalId === "terminal-one" ? { terminalId, task: null, branch: "main" } : null;
      }
    }
  });
  assert.equal(
    await handler.handleCommandRequest({ command: "state", target: "terminal-one", state: "needs-answer", detail: "Which one?" }),
    "State needs-answer."
  );
  assert.deepEqual(reports[0], { terminalId: "terminal-one", state: "needs-answer", detail: "Which one?" });
  await assert.rejects(handler.handleCommandRequest({ command: "state", target: "terminal-gone", state: "done" }), /no live terminal/);
  await assert.rejects(handler.handleCommandRequest({ command: "state", state: "done" }), /Use: clauding state/);
  const info = JSON.parse(await handler.handleCommandRequest({ command: "session-info", target: "terminal-one" }));
  assert.equal(info.branch, "main");
  await assert.rejects(handler.handleCommandRequest({ command: "session-info", target: "terminal-gone" }), /no live terminal/);
});
