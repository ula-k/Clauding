// Agent-first onboarding: the `clauding` commands the setup agent changes the
// app with, the settings that used to be baked in, the built-in setup agent,
// and projects that have no ClickUp at all. Dry: fake app calls, throw-away
// folders under the system temporary folder, no pty, no `claude`, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCommandRequestHandler } from "../electron/lib/commandRequests.js";
import { describeOneSetting, describeSettings, parseSettingValue, SETTABLE_KEYS } from "../electron/lib/settingCommands.js";
import { createSettingsStore } from "../electron/settings.js";
import { claudeHomeFolder, claudeRegistryPaths } from "../electron/lib/platformPaths.js";
import { applyConfiguredClaudeHome } from "../electron/claudeHome.js";
import { claudeExecutablePath } from "../electron/claudeCli.js";
import {
  describeRepository,
  gitTaskKey,
  githubSlugFromRemote,
  parseBranchRefs,
  parseCommitDates,
  suggestBranches
} from "../electron/lib/gitInspector.js";
import { pullRequestsByTask } from "../electron/lib/pullRequests.js";
import { branchTaskMap, MERGED_BRANCH_DAYS, tasksFromBranches, usesClickup } from "../electron/lib/gitTasks.js";
import { buildProjectSnapshot } from "../electron/lib/projectSnapshot.js";
import { findRepositories } from "../electron/lib/repositoryFinder.js";
import { createAgentStore } from "../electron/agents.js";
import { BUILTIN_SETUP_AGENT, restoreBuiltinAgents, seedBuiltinAgent, SETUP_AGENT } from "../electron/builtins.js";
import { applicationMenuTemplate } from "../electron/lib/applicationMenu.js";
import { startCommandSocket } from "../electron/commandSocket.js";
import { cardLinks, emptyDeadlineReason, filterChips, taskKickoffMessage } from "../src/renderer/projectsView.js";
import { projectSetupKickoffMessage, setupKickoffMessage } from "../src/renderer/metaPrompts.js";
import { cleanBoard } from "../electron/projectBoards.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60 * 1000;

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-setup-"));
}

const HOME = "/home/someone";
const fileChecks = {
  homeDirectory: HOME,
  isDirectory: (folder) => folder.startsWith("/exists"),
  isExecutableFile: (filePath) => filePath === "/exists/bin/claude"
};

// ---- settings set: the whitelist and its rules -------------------------------

test("only the whitelisted settings can be set, and the refusal lists them", () => {
  assert.deepEqual(SETTABLE_KEYS, [
    "language",
    "agentsRoot",
    "skillsRoot",
    "preambleExtra",
    "claudeBinary",
    "claudeHome",
    "skillScanRoots",
    "extraClaudeArguments"
  ]);
  assert.throws(() => parseSettingValue("onboarding", "done", fileChecks), /not a setting this command changes.*language, agentsRoot/);
  assert.throws(() => parseSettingValue("skillMakerSeeding", "installed", fileChecks), /not a setting/);
});

test("language takes the window's codes in any case, and system/auto clears it", () => {
  assert.deepEqual(parseSettingValue("language", "PL", fileChecks).draft, { language: "pl" });
  assert.deepEqual(parseSettingValue("language", "zh-cn", fileChecks).draft, { language: "zh-CN" });
  assert.deepEqual(parseSettingValue("language", "system", fileChecks).draft, { language: "" });
  assert.throws(() => parseSettingValue("language", "klingon", fileChecks), /not one of the window's languages/);
});

test("folders must be absolute; ~ is the home folder", () => {
  assert.deepEqual(parseSettingValue("agentsRoot", "~/Agents", fileChecks).draft, { agentsRoot: path.join(HOME, "Agents") });
  assert.deepEqual(parseSettingValue("skillsRoot", "/x/skills/", fileChecks).draft, { skillsRoot: "/x/skills/" });
  assert.throws(() => parseSettingValue("agentsRoot", "agents", fileChecks), /not an absolute path/);
});

test("claudeHome must exist, claudeBinary must be executable, and auto resets both", () => {
  assert.deepEqual(parseSettingValue("claudeHome", "/exists/claude-data", fileChecks).draft, { claudeHome: "/exists/claude-data" });
  assert.throws(() => parseSettingValue("claudeHome", "/missing", fileChecks), /no folder at \/missing/);
  assert.deepEqual(parseSettingValue("claudeHome", "auto", fileChecks).draft, { claudeHome: "" });
  assert.deepEqual(parseSettingValue("claudeBinary", "/exists/bin/claude", fileChecks).draft, { claudeBinary: "/exists/bin/claude" });
  assert.throws(() => parseSettingValue("claudeBinary", "/exists/bin/other", fileChecks), /not an executable file/);
  assert.deepEqual(parseSettingValue("claudeBinary", "default", fileChecks).draft, { claudeBinary: "" });
});

test("skillScanRoots takes a comma list or JSON, every folder must exist", () => {
  assert.deepEqual(parseSettingValue("skillScanRoots", "/exists/one, /exists/two", fileChecks).draft, { skillScanRoots: ["/exists/one", "/exists/two"] });
  assert.deepEqual(parseSettingValue("skillScanRoots", '["/exists/three"]', fileChecks).draft, { skillScanRoots: ["/exists/three"] });
  assert.deepEqual(parseSettingValue("skillScanRoots", "none", fileChecks).draft, { skillScanRoots: [] });
  assert.throws(() => parseSettingValue("skillScanRoots", "/exists/one,/gone", fileChecks), /no folder at \/gone/);
});

test("preambleExtra keeps its words and refuses a novel; extra flags refuse the app's own", () => {
  assert.deepEqual(parseSettingValue("preambleExtra", "  Answer in Polish.  ", fileChecks).draft, { preambleExtra: "Answer in Polish." });
  assert.throws(() => parseSettingValue("preambleExtra", "x".repeat(4001), fileChecks), /most is 4000/);
  assert.deepEqual(parseSettingValue("extraClaudeArguments", "--model   sonnet", fileChecks).draft, { extraClaudeArguments: "--model sonnet" });
  assert.throws(() => parseSettingValue("extraClaudeArguments", "--resume abc", fileChecks), /--resume/);
});

test("settings get describes the stored values and what is in use", () => {
  const stored = { language: "", agentsRoot: "/a", skillsRoot: "/s", preambleExtra: "", claudeBinary: "", claudeHome: "", skillScanRoots: ["/r"], extraClaudeArguments: "", onboarding: "" };
  const effective = { claudeBinary: "/usr/local/bin/claude", claudeHome: `${HOME}/.claude`, claudeHomeOrigin: "default" };
  const described = describeSettings(stored, effective);
  assert.equal(described.inUse.claudeBinary, "/usr/local/bin/claude");
  assert.equal(described.inUse.language, "system");
  assert.equal(describeOneSetting(stored, "claudeHome", effective), `${HOME}/.claude (automatic)`);
  assert.equal(describeOneSetting(stored, "skillScanRoots", effective), '["/r"]');
  assert.equal(describeOneSetting(stored, "language", effective), "system");
  assert.throws(() => describeOneSetting(stored, "secret", effective), /not a setting/);
});

// ---- the settings store keeps the new keys -----------------------------------

test("settings.json keeps language, preambleExtra, claudeBinary, claudeHome and onboarding, and drops nonsense", async () => {
  const folder = scratchFolder();
  const storagePath = path.join(folder, "settings.json");
  fs.writeFileSync(
    storagePath,
    JSON.stringify({ language: "fr", preambleExtra: 7, claudeBinary: "relative/claude", claudeHome: "not/absolute", onboarding: "maybe" })
  );
  const store = createSettingsStore({ storagePath });
  const loaded = store.get();
  assert.equal(loaded.language, "");
  assert.equal(loaded.preambleExtra, "7");
  assert.equal(loaded.claudeBinary, "");
  assert.equal(loaded.claudeHome, "");
  assert.equal(loaded.onboarding, "");
  const updated = store.update({ language: "es", onboarding: "done", preambleExtra: "Plans go in the panel." });
  assert.equal(updated.language, "es");
  assert.equal(updated.onboarding, "done");
  assert.equal(updated.preambleExtra, "Plans go in the panel.");
});

test("moving the Claude folder moves a default skills folder along, but not a chosen one", () => {
  const folder = scratchFolder();
  const store = createSettingsStore({ storagePath: path.join(folder, "settings.json") });
  const claudeData = path.join(folder, "claude-data");
  const moved = store.update({ claudeHome: claudeData });
  assert.equal(moved.skillsRoot, path.join(claudeData, "skills"));
  const chosen = store.update({ skillsRoot: path.join(folder, "my-skills") });
  const movedAgain = store.update({ claudeHome: path.join(folder, "elsewhere") });
  assert.equal(movedAgain.skillsRoot, chosen.skillsRoot);
});

// ---- the Claude folder and the binary are settings; the variables still win --

test("CLAUDE_CONFIG_DIR wins over the setting, which wins over ~/.claude", () => {
  assert.equal(claudeHomeFolder({ homeDirectory: HOME, environment: {} }), path.join(HOME, ".claude"));
  assert.equal(claudeHomeFolder({ homeDirectory: HOME, environment: {}, configuredHome: "/data/claude" }), "/data/claude");
  assert.equal(claudeHomeFolder({ homeDirectory: HOME, environment: { CLAUDE_CONFIG_DIR: "/env/claude" }, configuredHome: "/data/claude" }), "/env/claude");
});

test(".claude.json sits next to ~/.claude by default and inside any other Claude folder", () => {
  assert.equal(claudeRegistryPaths({ platform: "darwin", homeDirectory: HOME }).configurationFile, path.join(HOME, ".claude.json"));
  const moved = claudeRegistryPaths({ platform: "darwin", homeDirectory: HOME, claudeHome: "/data/claude" });
  assert.equal(moved.configurationFile, "/data/claude/.claude.json");
  assert.equal(moved.sessionsRegistryDirectory, "/data/claude/sessions");
});

test("a Claude folder from the settings is exported as CLAUDE_CONFIG_DIR, unless the app inherited one", () => {
  const environment = {};
  applyConfiguredClaudeHome("/data/claude", { environment, inherited: "", homeDirectory: HOME });
  assert.equal(environment.CLAUDE_CONFIG_DIR, "/data/claude");
  applyConfiguredClaudeHome("", { environment, inherited: "", homeDirectory: HOME });
  assert.equal("CLAUDE_CONFIG_DIR" in environment, false);
  const inheritedEnvironment = { CLAUDE_CONFIG_DIR: "/env/claude" };
  applyConfiguredClaudeHome("/data/claude", { environment: inheritedEnvironment, inherited: "/env/claude", homeDirectory: HOME });
  assert.equal(inheritedEnvironment.CLAUDE_CONFIG_DIR, "/env/claude");
  applyConfiguredClaudeHome("", { environment: {}, inherited: "", homeDirectory: HOME });
});

test("claudeBinary from the settings comes after CLAUDING_CLAUDE_BIN and before the usual places", () => {
  const common = { platform: "darwin", homeDirectory: HOME, fileExists: () => true, findOnPath: () => "/usr/bin/claude" };
  assert.equal(claudeExecutablePath({ ...common, environment: {}, configuredBinary: "/opt/claude" }), "/opt/claude");
  assert.equal(claudeExecutablePath({ ...common, environment: { CLAUDING_CLAUDE_BIN: "/wrapper" }, configuredBinary: "/opt/claude" }), "/wrapper");
  assert.equal(claudeExecutablePath({ ...common, environment: {}, configuredBinary: "" }), path.join(HOME, ".local", "bin", "claude"));
});

// ---- the command handler, against a fake app ----------------------------------

function fakeSetupApp(overrides = {}) {
  const calls = [];
  let stored = { language: "", agentsRoot: "/a", skillsRoot: "/s", preambleExtra: "", claudeBinary: "", claudeHome: "", skillScanRoots: [], extraClaudeArguments: "", onboarding: "", skillMakerSeeding: "unanswered" };
  const boards = [];
  const setup = {
    getSettings: () => ({ ...stored }),
    updateSettings(draft) {
      calls.push(["update", draft]);
      stored = { ...stored, ...draft };
      return stored;
    },
    effectiveSettings: () => ({ claudeBinary: "/bin/claude", claudeHome: "/h/.claude", claudeHomeOrigin: "default" }),
    fileChecks,
    ensureFolder(folder) {
      calls.push(["mkdir", folder]);
    },
    countSessions: async () => ({ count: 42, more: false, claudeHome: "/h/.claude" }),
    installBuiltinSkills: () => ({
      skillsRoot: "/s",
      results: [
        { skillName: "skill-maker", status: "created" },
        { skillName: "clauding-agents", status: "kept" }
      ]
    }),
    clickupStatus: async () => ({ connected: true, user: { id: "7", name: "Sam Doe", email: "sam@example.com" }, workspaces: [{ id: "1", name: "Acme" }], source: "keychain" }),
    inspectProjectLink: async (link) => ({ link, lists: [] }),
    async addProject(draft) {
      calls.push(["add", draft]);
      const board = cleanBoard({ ...draft, clickup: draft.projectLink ? { buildListId: "901", buildListName: "Build" } : {} });
      boards.push(board);
      return { board };
    },
    listProjects: () => boards,
    findRepositories: (roots) => (roots.length > 0 ? [] : [{ path: "/code/website", name: "website" }]),
    describeRepository: async (folder) => (folder === "/code/website" ? { isRepository: true, path: folder, suggestedBaseBranch: "main" } : { isRepository: false }),
    ...overrides
  };
  const handler = createCommandRequestHandler({
    terminals: { get: () => null, mostRecentlyFocused: () => null },
    panelTabs: { open() {}, get: () => ({ tabs: [] }), setVisible() {} },
    describeTarget: () => ({}),
    setup
  });
  return { handler, calls, getStored: () => stored };
}

test("settings set validates, writes through the app and answers in one line; agentsRoot is created", async () => {
  const { handler, calls, getStored } = fakeSetupApp();
  assert.equal(await handler.handleCommandRequest({ command: "settings", action: "set", key: "language", value: "pl" }), "Set language to pl.");
  assert.equal(getStored().language, "pl");
  assert.equal(await handler.handleCommandRequest({ command: "settings", action: "set", key: "agentsRoot", value: "~/Agents" }), `Set agentsRoot to ${path.join(HOME, "Agents")}.`);
  assert.deepEqual(calls.find((call) => call[0] === "mkdir"), ["mkdir", path.join(HOME, "Agents")]);
  await assert.rejects(handler.handleCommandRequest({ command: "settings", action: "set", key: "language", value: "xx" }), /not one of/);
  assert.equal(await handler.handleCommandRequest({ command: "settings", action: "get", key: "language" }), "pl");
  const all = JSON.parse(await handler.handleCommandRequest({ command: "settings", action: "get" }));
  assert.equal(all.inUse.claudeBinary, "/bin/claude");
});

test("sessions count, skills install-builtin and onboarding done say what happened", async () => {
  const { handler, getStored } = fakeSetupApp();
  assert.equal(await handler.handleCommandRequest({ command: "sessions", action: "count" }), "42 sessions are visible to Clauding (read from /h/.claude).");
  assert.equal(
    await handler.handleCommandRequest({ command: "skills", action: "install-builtin" }),
    "Built-in skills in /s: skill-maker (installed), clauding-agents (kept your edited copy)."
  );
  assert.match(await handler.handleCommandRequest({ command: "onboarding", action: "done" }), /marked as done/);
  assert.equal(getStored().onboarding, "done");
});

test("clickup status names the token's owner, never the token, and a missing one fails with the fix", async () => {
  const connected = fakeSetupApp();
  const line = await connected.handler.handleCommandRequest({ command: "integrations", service: "clickup", action: "status" });
  assert.equal(line, "ClickUp: connected as Sam Doe <sam@example.com> (id 7); token from the Keychain; workspaces: Acme (1).");
  const missing = fakeSetupApp({ clickupStatus: async () => ({ connected: false, reason: "no-token" }) });
  await assert.rejects(missing.handler.handleCommandRequest({ command: "integrations", service: "clickup", action: "status" }), /no token.*security add-generic-password/);
});

test("project add refuses a nameless or duplicate project and reports what it added", async () => {
  const { handler } = fakeSetupApp();
  await assert.rejects(handler.handleCommandRequest({ command: "project", action: "add", board: {} }), /needs a name/);
  const added = await handler.handleCommandRequest({ command: "project", action: "add", board: { name: "Website", repositories: [{ name: "website", localPath: "/code/website" }] } });
  assert.equal(added, 'Added project "Website" to Clauding (no ClickUp, 1 repository).');
  await assert.rejects(handler.handleCommandRequest({ command: "project", action: "add", board: { name: "website" } }), /already a project called "Website"/);
  const withList = await handler.handleCommandRequest({ command: "project", action: "add", board: { name: "Shop", projectLink: "https://app.clickup.com/1/v/li/901" } });
  assert.equal(withList, 'Added project "Shop" to Clauding (ClickUp list "Build", 0 repositories).');
  assert.equal(await handler.handleCommandRequest({ command: "project", action: "list" }), 'Website — no ClickUp, 1 repository\nShop — ClickUp list "Build", 0 repositories');
});

test("project add passes a link with several candidate lists back as a question", async () => {
  const { handler } = fakeSetupApp({ addProject: async () => ({ candidates: [{ id: "1", name: "Build" }, { id: "2", name: "Specs" }] }) });
  await assert.rejects(handler.handleCommandRequest({ command: "project", action: "add", board: { name: "X" } }), /buildListId.*Build \(1\), Specs \(2\)/);
});

test("project inspect and repo inspect answer with JSON; repos find with one path per line", async () => {
  const { handler } = fakeSetupApp();
  assert.deepEqual(JSON.parse(await handler.handleCommandRequest({ command: "project", action: "inspect", link: "L" })), { link: "L", lists: [] });
  assert.equal(await handler.handleCommandRequest({ command: "repos", action: "find", roots: [] }), "/code/website");
  assert.equal(await handler.handleCommandRequest({ command: "repos", action: "find", roots: ["/empty"] }), "No git repositories found there.");
  assert.equal(JSON.parse(await handler.handleCommandRequest({ command: "repo", action: "inspect", path: "/code/website" })).suggestedBaseBranch, "main");
  await assert.rejects(handler.handleCommandRequest({ command: "repo", action: "inspect", path: "/var/empty" }), /not inside a git repository/);
});

test("a window without the setup calls refuses the setup commands", async () => {
  const handler = createCommandRequestHandler({
    terminals: { get: () => null, mostRecentlyFocused: () => null },
    panelTabs: { open() {}, get: () => ({ tabs: [] }), setVisible() {} },
    describeTarget: () => ({})
  });
  await assert.rejects(handler.handleCommandRequest({ command: "settings", action: "get" }), /cannot be set up/);
  const { handler: withSetup } = fakeSetupApp();
  await assert.rejects(withSetup.handleCommandRequest({ command: "sessions", action: "list" }), /Use: clauding sessions count/);
  await assert.rejects(withSetup.handleCommandRequest({ command: "integrations", service: "jira", action: "status" }), /Use: clauding integrations clickup status/);
});

// ---- bin/clauding builds the requests (through a real socket) ----------------

function runClauding(socketPath, commandArguments, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(projectRoot, "bin", "clauding"), ...commandArguments],
      { cwd, env: { ...process.env, CLAUDING_SOCKET: socketPath, CLAUDING_TERMINAL_ID: "" } },
      (error, standardOutput, standardError) => resolve({ code: error ? error.code : 0, standardOutput, standardError })
    );
  });
}

test("bin/clauding sends the setup commands as the handler expects them and prints the one line", async () => {
  const folder = scratchFolder();
  const socketPath = path.join(folder, "clauding.sock");
  const received = [];
  const stop = startCommandSocket({
    socketPath,
    async handleRequest(request) {
      received.push(request);
      if (request.command === "onboarding") {
        throw new Error("no");
      }
      return "fine";
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(path.join(folder, "project.json"), JSON.stringify({ name: "Site", repositories: [{ localPath: "site" }] }));
  try {
    const setting = await runClauding(socketPath, ["settings", "set", "preambleExtra", "Answer", "in", "Polish."], folder);
    assert.equal(setting.standardOutput, "fine\n");
    assert.equal(setting.code, 0);
    await runClauding(socketPath, ["project", "add", "--json", "project.json"], folder);
    await runClauding(socketPath, ["project", "add", "--name", "Other", "--repo", "code/other", "--list", "901"], folder);
    await runClauding(socketPath, ["integrations", "clickup", "status"], folder);
    await runClauding(socketPath, ["repos", "find", "code"], folder);
    const failed = await runClauding(socketPath, ["onboarding", "done"], folder);
    assert.equal(failed.code, 1);
    assert.equal(failed.standardError, "clauding: could not mark setup as done — no\n");
    const wrong = await runClauding(socketPath, ["settings", "set"], folder);
    assert.equal(wrong.code, 1);
    assert.match(wrong.standardError, /usage: clauding open/);
  } finally {
    stop();
  }
  const realFolder = fs.realpathSync(folder);
  const [setting, fromFile, fromFlags, clickup, repositories] = received;
  assert.deepEqual([setting.command, setting.action, setting.key, setting.value], ["settings", "set", "preambleExtra", "Answer in Polish."]);
  assert.equal(fromFile.board.name, "Site");
  assert.equal(fromFile.board.repositories[0].localPath, path.join(realFolder, "site"));
  assert.deepEqual(fromFlags.board, { name: "Other", projectLink: "901", repositories: [{ localPath: path.join(realFolder, "code", "other") }] });
  assert.deepEqual([clickup.command, clickup.service, clickup.action], ["integrations", "clickup", "status"]);
  assert.deepEqual(repositories.roots, [path.join(realFolder, "code")]);
});

// ---- the built-in setup agent --------------------------------------------------

test("the setup agent is seeded above the Agent Maker, cannot be deleted, and Restore brings it back as shipped", () => {
  const folder = scratchFolder();
  const store = createAgentStore({ storagePath: path.join(folder, "agents.json") });
  seedBuiltinAgent(store);
  const [first, second] = store.get().agents;
  assert.equal(first.builtin, BUILTIN_SETUP_AGENT);
  assert.equal(second.builtin, "agent-maker");
  assert.ok(fs.existsSync(first.definitionFile), "the definition ships in builtin/agents/setup");
  assert.match(first.extraClaudeArguments, /Bash\(clauding:\*\)/);
  store.deleteAgent(first.id);
  assert.equal(store.get().agents[0].id, first.id, "a delete request for a built-in is ignored");
  store.updateAgent(first.id, { ...first, name: "Renamed" });
  restoreBuiltinAgents(store);
  assert.equal(store.get().agents[0].name, SETUP_AGENT.name);
  seedBuiltinAgent(store);
  assert.equal(store.get().agents.length, 2, "seeding twice adds nothing");
});

test("the setup definition covers both jobs and only changes the app through clauding", () => {
  const definition = fs.readFileSync(SETUP_AGENT.definitionFile, "utf8");
  assert.match(definition, /^# Agent: Setup/);
  for (const phrase of ["## Setting up Clauding", "## Setting up a project", "clauding onboarding done", "clauding project inspect", "clauding project add --json", "clauding skills install-builtin", "clauding sessions count", "clauding integrations clickup status"]) {
    assert.ok(definition.includes(phrase), phrase);
  }
  assert.equal(setupKickoffMessage().startsWith("Set up Clauding"), true);
  assert.equal(projectSetupKickoffMessage("  https://app.clickup.com/1/v/li/2 "), "Set up a project: https://app.clickup.com/1/v/li/2");
  assert.equal(projectSetupKickoffMessage(""), "Set up a project:");
});

test("the menu bar has Run setup agent… and keeps the old form as Manual setup…", () => {
  const events = [];
  const template = applicationMenuTemplate({
    platform: "darwin",
    onRunSetupAgent: () => events.push("setup"),
    onAddProject: () => events.push("agent"),
    onManualProject: () => events.push("manual")
  });
  const application = template[0].submenu.find((item) => item.label === "Run setup agent…");
  application.click();
  const projects = template.find((menu) => menu.label === "Projects").submenu;
  projects.find((item) => item.label === "Set up a Project…").click();
  projects.find((item) => item.label === "Manual setup…").click();
  assert.deepEqual(events, ["setup", "agent", "manual"]);
});

// ---- projects without ClickUp ----------------------------------------------------

test("every feature branch is read when asked for all of them, keyed by CU- id or a short hash", () => {
  const output = ["refs/heads/main", "refs/heads/feature/login", "refs/remotes/origin/feature/login", "refs/remotes/origin/HEAD", "refs/remotes/origin/staging", "refs/heads/someone/CU-86ab12cd-x", "refs/heads/release"].join("\n");
  const onlyClickup = parseBranchRefs(output);
  assert.deepEqual(onlyClickup.map((branch) => branch.name), ["someone/CU-86ab12cd-x"]);
  const all = parseBranchRefs(output, "origin", { allBranches: true, excluded: ["release"] });
  assert.deepEqual(all.map((branch) => branch.name), ["feature/login", "someone/CU-86ab12cd-x"]);
  assert.deepEqual([all[0].local, all[0].remote], [true, true]);
  assert.equal(all[1].taskId, "86ab12cd");
  assert.match(gitTaskKey("feature/login"), /^git-[0-9a-f]{12}$/);
  assert.equal(gitTaskKey("feature/login"), gitTaskKey("feature/login"));
});

test("base and staging branches are suggested from the remote, and the GitHub slug from its address", () => {
  assert.deepEqual(suggestBranches(["main", "develop", "x"]), { baseBranch: "main", stagingBranch: "develop" });
  assert.deepEqual(suggestBranches(["master", "staging", "develop"]), { baseBranch: "master", stagingBranch: "staging" });
  assert.deepEqual(suggestBranches(["trunk-ish"]), { baseBranch: null, stagingBranch: null });
  assert.deepEqual(suggestBranches(["master", "docker-staging", "feature/x"]), { baseBranch: "master", stagingBranch: "docker-staging" });
  assert.equal(githubSlugFromRemote("git@github.com:acme/web-site.git"), "acme/web-site");
  assert.equal(githubSlugFromRemote("https://github.com/acme/web/"), "acme/web");
  assert.equal(githubSlugFromRemote("https://gitlab.com/acme/web"), null);
  assert.deepEqual([...parseCommitDates("refs/heads/a 1700000000\nrefs/heads/b 0\n")], [["refs/heads/a", 1700000000000]]);
});

test("pull requests of any branch are keyed like their branch in a project without ClickUp", () => {
  const pulls = [{ number: 3, headRefName: "feature/login", state: "OPEN", url: "u", updatedAt: "2026-09-01" }];
  assert.deepEqual(Object.keys(pullRequestsByTask("web", pulls)), []);
  assert.deepEqual(Object.keys(pullRequestsByTask("web", pulls, { allBranches: true })), [gitTaskKey("feature/login")]);
});

function branchInfo(name, extra = {}) {
  return { repository: "web", name, local: true, remote: true, pushed: true, aheadOfBase: 2, inStaging: false, mergedIntoBase: false, lastCommitAt: null, ...extra };
}

test("branches become tasks: no PR is my queue, an open PR is waiting, merged is closed, old merged ones are gone", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const repositoryResults = [
    {
      branchesByTask: {
        [gitTaskKey("feature/a")]: [branchInfo("feature/a", { lastCommitAt: now - DAY })],
        [gitTaskKey("feature/b")]: [branchInfo("feature/b", { lastCommitAt: now - 2 * DAY })],
        [gitTaskKey("feature/c")]: [branchInfo("feature/c", { aheadOfBase: 0, mergedIntoBase: true, lastCommitAt: now - 3 * DAY })],
        [gitTaskKey("feature/old")]: [branchInfo("feature/old", { aheadOfBase: 0, mergedIntoBase: true, lastCommitAt: now - (MERGED_BRANCH_DAYS + 5) * DAY })],
        [gitTaskKey("feature/s")]: [branchInfo("feature/s", { inStaging: true, lastCommitAt: now - 4 * DAY })]
      }
    }
  ];
  const pullRequestResults = [{ byTask: { [gitTaskKey("feature/b")]: [{ state: "open", title: "Add the B page", url: "https://github.com/acme/web/pull/9", updatedAt: "2026-09-27T00:00:00Z" }] } }];
  const tasks = tasksFromBranches({ repositoryResults, pullRequestResults, now });
  const byBranch = new Map(tasks.map((task) => [task.branchName, task]));
  assert.equal(byBranch.has("feature/old"), false);
  assert.equal(byBranch.get("feature/a").status, "in progress");
  assert.equal(byBranch.get("feature/b").status, "in review");
  assert.equal(byBranch.get("feature/b").name, "Add the B page");
  assert.equal(byBranch.get("feature/c").status, "merged");
  assert.equal(byBranch.get("feature/s").status, "in staging");
  const snapshot = buildProjectSnapshot({
    board: cleanBoard({ name: "Site", repositories: [{ name: "web", localPath: "/code/web" }] }),
    buildTasks: tasks,
    repositoryResults,
    pullRequestResults,
    sessions: [{ sessionId: "s1", title: "Working on A", gitBranch: "feature/a", lastModified: now }],
    mode: "git",
    branchTasks: branchTaskMap(tasks, repositoryResults),
    now
  });
  assert.equal(snapshot.mode, "git");
  const cardA = snapshot.cards.find((card) => card.branchName === "feature/a");
  assert.equal(cardA.source, "git");
  assert.equal(cardA.perspective, "myQueue");
  assert.deepEqual(cardA.builderSessions.map((session) => session.sessionId), ["s1"]);
  assert.equal(snapshot.cards.find((card) => card.branchName === "feature/b").perspective, "waiting");
  assert.equal(snapshot.cards.find((card) => card.branchName === "feature/c").perspective, "closed");
  assert.deepEqual(snapshot.filters.specs, []);
  assert.equal(snapshot.stats.inQueue, 1);
  // The window: no Specs chip, no ClickUp chip, no spec to ask for.
  assert.equal(filterChips(snapshot).some((chip) => chip.id === "specs"), false);
  const links = cardLinks(cardA);
  assert.equal(links.some((link) => link.kind === "clickup" || link.kind === "missing" && /spec/i.test(link.reason)), false);
  assert.ok(links.some((link) => link.kind === "branch" && link.name === "feature/a"));
  assert.match(taskKickoffMessage(cardA), /^Branch feature\/a \(web: feature\/a\)/);
  assert.equal(emptyDeadlineReason(snapshot).key, "projects.noDatesGitOnly");
});

test("a project follows ClickUp only when it was given a link, a list or a task", () => {
  assert.equal(usesClickup(cleanBoard({ name: "A" })), false);
  assert.equal(usesClickup(cleanBoard({ name: "B", clickup: { projectLink: "https://app.clickup.com/1/v/li/2" } })), true);
  assert.equal(usesClickup(cleanBoard({ name: "C", clickup: { buildListId: "2" } })), true);
  assert.equal(cleanBoard({ name: "D", repositories: [{ name: "x", stagingBranch: "" }] }).repositories[0].stagingBranch, "", "no staging branch is kept");
  assert.equal(cleanBoard({ name: "E", repositories: [{ name: "x" }] }).repositories[0].stagingBranch, "staging");
});

test("repos find walks the usual places three levels deep and stops at a repository", () => {
  const home = scratchFolder();
  for (const folder of ["Documents/projects/site/.git", "Documents/projects/site/nested/.git", "Developer/tool/.git", "Documents/a/b/c/deep/.git", "Documents/projects/node_modules/lib/.git"]) {
    fs.mkdirSync(path.join(home, folder), { recursive: true });
  }
  const found = findRepositories({ homeDirectory: home }).map((repository) => path.relative(fs.realpathSync(home), repository.path));
  assert.deepEqual(found, ["Developer/tool", "Documents/projects/site"]);
  const inFolder = findRepositories({ roots: [path.join(home, "Documents", "a")] }).map((repository) => repository.name);
  assert.deepEqual(inFolder, ["deep"]);
});

test("repo inspect reads a real checkout: its name, remote, branches and suggestions", async () => {
  const folder = scratchFolder();
  const run = (commandArguments) =>
    new Promise((resolve, reject) => execFile("git", ["-C", folder, ...commandArguments], (error) => (error ? reject(error) : resolve())));
  await run(["init", "-q", "-b", "main"]);
  await run(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "first"]);
  await run(["branch", "feature/x"]);
  await run(["remote", "add", "origin", "git@github.com:acme/example.git"]);
  const described = await describeRepository(folder);
  assert.equal(described.isRepository, true);
  assert.equal(described.githubSlug, "acme/example");
  assert.equal(described.suggestedBaseBranch, "main");
  assert.equal(described.suggestedStagingBranch, null);
  assert.equal(described.otherFeatureBranchCount, 1);
  assert.equal((await describeRepository(os.tmpdir())).isRepository, false);
});
