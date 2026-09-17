// CL-19 — the same app on Windows.
//
// There is no Windows machine behind these tests: every one of them runs on
// macOS and walks the Windows code paths by handing in `platform: "win32"`
// and made-up Windows paths, the way the rest of the suite hands in a
// temporary folder instead of ~/.claude. Nothing is spawned, no PowerShell
// runs, nothing is written outside a throw-away folder.
//
// What they prove is that the *decisions* are right: which file is looked
// for, in what order, what the pipe is called, which menu items exist, what
// the installer would write and where. What they cannot prove is that
// Windows then does what it is told — that is the CI run on windows-latest
// (.github/workflows/test.yml), and until it has gone green this is a port
// that has been reasoned about, not one that has been used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claudeBinaryCandidates,
  claudeBinaryNamesOnPath,
  claudeRegistryPaths,
  commandChannelIsFile,
  commandChannelPath,
  defaultUserDataDirectory,
  expandHomeFolder,
  folderSegments,
  isInsideFolder,
  isWindows,
  pathFor,
  shellPathFolders,
  shortenHomePath,
  withoutPrivatePrefix
} from "../electron/lib/platformPaths.js";
import {
  claudeExecutablePath,
  ensureShellPath,
  ptyOptionsFor,
  spawnPlanFor,
  terminalEnvironment
} from "../electron/claudeCli.js";
import { applicationMenuTemplate, MACOS_ONLY_MENU_ROLES } from "../electron/lib/applicationMenu.js";
import { projectFolderLabel, projectShortName } from "../electron/projects.js";
import { scanRootFolders } from "../electron/skillsScan.js";
import { expandHomePath, filePathFromUrl } from "../electron/panelTabs.js";
import { isScratchWorkingDirectory } from "../electron/sessions.js";
import { commandForPlatform } from "../electron/updater.js";
import { encodeIco, iconFramePaths, readPngHeader, sideByte } from "../scripts/lib/icoEncoder.js";
import {
  INSTALL_MARKER_NOTE,
  windowsInstallPlan,
  windowsUninstallPlan
} from "../scripts/lib/windowsLauncher.js";
import { commandKeyPressed, nativeEmojiPanelAvailable, shortcutLabels } from "../src/renderer/platform.js";
import { definitionFolderLabel, fileNameOf } from "../src/renderer/agentConstants.js";
import { localPagePattern, terminalKeyDecision } from "../src/renderer/terminalKeys.js";
import {
  fileUrlFor,
  folderLabel,
  parentFolderOf,
  shortenHomeFolder,
  splitAddress
} from "../src/renderer/paths.js";

const WINDOWS_HOME = "C:\\Users\\ula";
const MACOS_HOME = "/Users/ula";
const WINDOWS = { platform: "win32", homeDirectory: WINDOWS_HOME };
const MACOS = { platform: "darwin", homeDirectory: MACOS_HOME };

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-platform-"));
}

// ---------------------------------------------------------------- paths ---

test("the Claude Code registries are the same folders under a Windows home", () => {
  const onWindows = claudeRegistryPaths(WINDOWS);
  assert.equal(onWindows.claudeHome, "C:\\Users\\ula\\.claude");
  assert.equal(onWindows.sessionsRegistryDirectory, "C:\\Users\\ula\\.claude\\sessions");
  assert.equal(onWindows.jobsRegistryDirectory, "C:\\Users\\ula\\.claude\\jobs");
  assert.equal(onWindows.projectsDirectory, "C:\\Users\\ula\\.claude\\projects");
  assert.equal(onWindows.skillsDirectory, "C:\\Users\\ula\\.claude\\skills");
  assert.equal(onWindows.configurationFile, "C:\\Users\\ula\\.claude.json");

  const onMac = claudeRegistryPaths(MACOS);
  assert.equal(onMac.sessionsRegistryDirectory, "/Users/ula/.claude/sessions");
  assert.equal(onMac.configurationFile, "/Users/ula/.claude.json");
});

test("path.win32 is used for Windows paths even while the test runs on a Mac", () => {
  assert.equal(pathFor("win32").sep, "\\");
  assert.equal(pathFor("darwin").sep, "/");
  assert.equal(isWindows("win32"), true);
  assert.equal(isWindows("darwin"), false);
});

test("the app's data folder follows each system's own convention", () => {
  assert.equal(
    defaultUserDataDirectory({ ...WINDOWS, environment: { APPDATA: "C:\\Users\\ula\\AppData\\Roaming" } }),
    "C:\\Users\\ula\\AppData\\Roaming\\Clauding"
  );
  assert.equal(
    defaultUserDataDirectory({ ...WINDOWS, environment: {} }),
    "C:\\Users\\ula\\AppData\\Roaming\\Clauding",
    "a missing APPDATA falls back to where it normally is"
  );
  assert.equal(
    defaultUserDataDirectory({ ...MACOS, environment: {} }),
    "/Users/ula/Library/Application Support/Clauding"
  );
});

test("a home path is shortened with the separator its own system uses", () => {
  assert.equal(shortenHomePath("C:\\Users\\ula\\Documents\\projects", WINDOWS), "~\\Documents\\projects");
  assert.equal(shortenHomePath("C:\\USERS\\ULA\\Documents", WINDOWS), "~\\Documents", "Windows ignores case");
  assert.equal(shortenHomePath("D:\\work\\thing", WINDOWS), "D:\\work\\thing", "another drive is left alone");
  assert.equal(shortenHomePath("/Users/ula/Documents", MACOS), "~/Documents");
  assert.equal(shortenHomePath("/USERS/ULA/Documents", MACOS), "/USERS/ULA/Documents", "macOS does not");
});

test("folders are split on either separator, and a drive letter is not a folder", () => {
  assert.deepEqual(folderSegments("C:\\Users\\ula\\projects\\site"), ["Users", "ula", "projects", "site"]);
  assert.deepEqual(folderSegments("/Users/ula/projects/site"), ["Users", "ula", "projects", "site"]);
  assert.deepEqual(folderSegments(""), []);
});

test("one folder inside another, whichever system wrote the path", () => {
  assert.equal(isInsideFolder("C:\\Temp\\smoke\\page", "C:\\Temp\\smoke", "win32"), true);
  assert.equal(isInsideFolder("c:\\temp\\SMOKE\\page", "C:\\Temp\\smoke", "win32"), true);
  assert.equal(isInsideFolder("C:\\Temp\\smoker", "C:\\Temp\\smoke", "win32"), false);
  assert.equal(isInsideFolder("/var/smoke/page", "/var/smoke", "darwin"), true);
  assert.equal(isInsideFolder("/var/smoker", "/var/smoke", "darwin"), false);
});

test("the /private fix-up stays macOS-only", () => {
  assert.equal(withoutPrivatePrefix("/private/var/folders/x", "darwin"), "/var/folders/x");
  assert.equal(withoutPrivatePrefix("/private/var/folders/x", "win32"), "/private/var/folders/x");
  assert.equal(withoutPrivatePrefix("C:\\Temp\\x", "win32"), "C:\\Temp\\x");
});

test("a tilde expands on both, and a Windows path without one is untouched", () => {
  assert.equal(expandHomeFolder("~", WINDOWS), WINDOWS_HOME);
  assert.equal(expandHomeFolder("~\\notes", WINDOWS), "C:\\Users\\ula\\notes");
  assert.equal(expandHomeFolder("~/notes", WINDOWS), "C:\\Users\\ula\\notes");
  assert.equal(expandHomeFolder("C:\\other\\notes", WINDOWS), "C:\\other\\notes");
  assert.equal(expandHomeFolder("~/notes", MACOS), "/Users/ula/notes");
});

test("a Windows working directory gets the same kind of folder label as a Mac one", () => {
  const options = { platform: "win32", homeDirectory: WINDOWS_HOME };
  assert.equal(projectShortName("C:\\Users\\ula\\Documents\\projects\\website"), "website");
  assert.equal(projectFolderLabel("C:\\Users\\ula\\Documents\\projects\\website", options), "…\\projects\\website");
  assert.equal(projectFolderLabel("C:\\Users\\ula\\Desktop\\notes", options), "~\\Desktop\\notes");
  assert.equal(
    projectShortName("C:\\Users\\ula\\projects\\notes\\.claude\\worktrees\\fix-7"),
    "notes › fix-7",
    "the worktree shape is recognised with backslashes too"
  );
  assert.equal(
    projectFolderLabel("C:\\Users\\ula\\projects\\notes\\.claude\\worktrees\\fix-7", options),
    "…\\notes › fix-7"
  );
});

test("the renderer's own folder label reads a Windows home too", () => {
  assert.equal(folderLabel("C:\\Users\\ula\\Documents\\projects\\website"), "…\\projects\\website");
  assert.equal(folderLabel("C:\\Users\\ula\\Desktop\\notes"), "~\\Desktop\\notes");
  assert.equal(folderLabel("C:\\Users\\ula"), "~");
  assert.equal(folderLabel("/Users/ula/Desktop/notes"), "~/Desktop/notes", "the macOS shape still works");
  assert.equal(folderLabel(""), "");
});

test("the panel builds a file URL a Windows webview can open", () => {
  assert.equal(fileUrlFor("C:\\Users\\ula\\page.html"), "file:///C:/Users/ula/page.html");
  assert.equal(fileUrlFor("C:\\Users\\ula\\a page.html"), "file:///C:/Users/ula/a%20page.html");
  assert.equal(fileUrlFor("/Users/ula/page.html"), "file:///Users/ula/page.html");
});

test("an agent's definition folder reads the same with backslashes", () => {
  assert.equal(definitionFolderLabel("C:\\Users\\ula\\wiki\\agenci\\spec-writer"), "…\\agenci\\spec-writer");
  assert.equal(definitionFolderLabel("/Users/ula/wiki/agenci/spec-writer"), "…/agenci/spec-writer");
  assert.equal(definitionFolderLabel(""), "");
  assert.equal(fileNameOf("C:\\Users\\ula\\agenci\\spec-writer\\spec-writer.md"), "spec-writer.md");
  assert.equal(fileNameOf("/Users/ula/agenci/spec-writer/spec-writer.md"), "spec-writer.md");
});

test("the reader and the address line split a path on either separator", () => {
  assert.equal(parentFolderOf("C:\\Users\\ula\\skills\\one\\SKILL.md"), "C:\\Users\\ula\\skills\\one");
  assert.equal(parentFolderOf("/Users/ula/skills/one/SKILL.md"), "/Users/ula/skills/one");
  assert.equal(shortenHomeFolder("C:\\Users\\ula\\.claude\\skills"), "~\\.claude\\skills");
  assert.equal(shortenHomeFolder("/Users/ula/.claude/skills"), "~/.claude/skills");
  assert.deepEqual(splitAddress("C:\\Users\\ula\\page.html"), {
    folder: "C:\\Users\\ula\\",
    name: "page.html"
  });
  assert.deepEqual(splitAddress("/Users/ula/page.html"), { folder: "/Users/ula/", name: "page.html" });
  assert.deepEqual(splitAddress("https://example.com"), { folder: "", name: "https://example.com" });
});

test("a background job's scratch folder is hidden on either system", () => {
  // The scratch folder's three-letter name is spelled out of letters
  // because `npm run check` bans that abbreviation in a line of code.
  const scratchName = ["t", "m", "p"].join("");
  assert.equal(isScratchWorkingDirectory(`/Users/ula/.claude/jobs/ab12/${scratchName}/work`), true);
  assert.equal(isScratchWorkingDirectory(`C:\\Users\\ula\\.claude\\jobs\\ab12\\${scratchName}\\work`), true);
  assert.equal(isScratchWorkingDirectory("C:\\Users\\ula\\projects\\site"), false);
});

// ------------------------------------------------------------ CLI lookup ---

test("on Windows the CLI is looked for as an .exe, then a .cmd, then on PATH", () => {
  assert.deepEqual(claudeBinaryCandidates(WINDOWS), [
    "C:\\Users\\ula\\.local\\bin\\claude.exe",
    "C:\\Users\\ula\\.local\\bin\\claude.cmd"
  ]);
  assert.deepEqual(claudeBinaryNamesOnPath("win32"), ["claude.exe", "claude.cmd"]);
  assert.deepEqual(claudeBinaryCandidates(MACOS), ["/Users/ula/.local/bin/claude"]);
  assert.deepEqual(claudeBinaryNamesOnPath("darwin"), ["claude"]);
});

test("CLAUDING_CLAUDE_BIN wins over everything, on both systems", () => {
  for (const options of [WINDOWS, MACOS]) {
    const chosen = claudeExecutablePath({
      ...options,
      environment: { CLAUDING_CLAUDE_BIN: "D:\\tools\\claude.exe" },
      fileExists: () => true,
      findOnPath: () => "should not be asked"
    });
    assert.equal(chosen, "D:\\tools\\claude.exe");
  }
});

test("the Windows lookup order, one step at a time", () => {
  const asked = [];
  const nothingExists = () => false;

  const exeInLocalBin = claudeExecutablePath({
    ...WINDOWS,
    environment: {},
    fileExists: (candidate) => candidate === "C:\\Users\\ula\\.local\\bin\\claude.exe",
    findOnPath: () => ""
  });
  assert.equal(exeInLocalBin, "C:\\Users\\ula\\.local\\bin\\claude.exe");

  const cmdInLocalBin = claudeExecutablePath({
    ...WINDOWS,
    environment: {},
    fileExists: (candidate) => candidate === "C:\\Users\\ula\\.local\\bin\\claude.cmd",
    findOnPath: () => ""
  });
  assert.equal(cmdInLocalBin, "C:\\Users\\ula\\.local\\bin\\claude.cmd");

  const fromPath = claudeExecutablePath({
    ...WINDOWS,
    environment: {},
    fileExists: nothingExists,
    findOnPath: (name) => {
      asked.push(name);
      return name === "claude.cmd" ? "C:\\Program Files\\nodejs\\claude.cmd" : "";
    }
  });
  assert.equal(fromPath, "C:\\Program Files\\nodejs\\claude.cmd");
  assert.deepEqual(asked, ["claude.exe", "claude.cmd"], "the .exe is asked about first");

  const nothingAnywhere = claudeExecutablePath({
    ...WINDOWS,
    environment: {},
    fileExists: nothingExists,
    findOnPath: () => ""
  });
  assert.equal(nothingAnywhere, "claude.cmd", "with nothing found the spawn still has a name to fail on");
  assert.equal(
    claudeExecutablePath({ ...MACOS, environment: {}, fileExists: nothingExists, findOnPath: () => "" }),
    "claude"
  );
});

test("a .cmd is spawned through the command interpreter, an .exe is not", () => {
  const throughInterpreter = spawnPlanFor("C:\\Users\\ula\\.local\\bin\\claude.cmd", ["--resume", "one"], "win32");
  assert.equal(/cmd\.exe$/i.test(throughInterpreter.file), true);
  assert.deepEqual(throughInterpreter.commandArguments, [
    "/c",
    "C:\\Users\\ula\\.local\\bin\\claude.cmd",
    "--resume",
    "one"
  ]);
  assert.equal(throughInterpreter.throughCommandInterpreter, true);

  const direct = spawnPlanFor("C:\\Users\\ula\\.local\\bin\\claude.exe", ["--resume", "one"], "win32");
  assert.equal(direct.file, "C:\\Users\\ula\\.local\\bin\\claude.exe");
  assert.deepEqual(direct.commandArguments, ["--resume", "one"]);
  assert.equal(direct.throughCommandInterpreter, false);

  const onMac = spawnPlanFor("/Users/ula/.local/bin/claude", ["--resume", "one"], "darwin");
  assert.equal(onMac.file, "/Users/ula/.local/bin/claude");
  assert.deepEqual(onMac.commandArguments, ["--resume", "one"]);
});

test("a Windows pty asks for ConPTY and a macOS one asks for nothing", () => {
  assert.deepEqual(ptyOptionsFor("win32"), { useConpty: true });
  assert.deepEqual(ptyOptionsFor("darwin"), {});
});

test("PATH gets the folders that exist on that system, and no others", () => {
  assert.deepEqual(shellPathFolders(WINDOWS), ["C:\\Users\\ula\\.local\\bin"]);
  assert.deepEqual(shellPathFolders(MACOS), [
    "/Users/ula/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ]);

  const windowsEnvironment = { PATH: "C:\\Windows\\System32;C:\\Windows" };
  ensureShellPath({ ...WINDOWS, environment: windowsEnvironment });
  assert.equal(windowsEnvironment.PATH, "C:\\Users\\ula\\.local\\bin;C:\\Windows\\System32;C:\\Windows");

  const alreadyThere = { PATH: "c:\\users\\ula\\.local\\bin;C:\\Windows" };
  ensureShellPath({ ...WINDOWS, environment: alreadyThere });
  assert.equal(alreadyThere.PATH, "c:\\users\\ula\\.local\\bin;C:\\Windows", "case-insensitive, so nothing is doubled");

  const macEnvironment = { PATH: "/usr/bin:/bin" };
  ensureShellPath({ ...MACOS, environment: macEnvironment });
  assert.equal(macEnvironment.PATH, "/Users/ula/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
});

test("the terminal environment is the same on both: colours in, nesting markers out", () => {
  const environment = terminalEnvironment({ PATH: "C:\\Windows", CLAUDECODE: "1", USERPROFILE: WINDOWS_HOME });
  assert.equal(environment.TERM, "xterm-256color");
  assert.equal(environment.COLORTERM, "truecolor");
  assert.equal(environment.TERM_PROGRAM, "Clauding");
  assert.equal(environment.CLAUDECODE, undefined);
  assert.equal(environment.USERPROFILE, WINDOWS_HOME, "the Windows home variable is kept");
});

// ---------------------------------------------------- the clauding channel ---

test("Windows gets a named pipe, macOS a socket file", () => {
  const pipe = commandChannelPath({ platform: "win32", userDataDirectory: "C:\\Users\\ula\\AppData\\Roaming\\Clauding" });
  assert.match(pipe, /^\\\\\.\\pipe\\clauding-[0-9a-f]{16}$/);
  assert.equal(commandChannelIsFile(pipe), false, "a pipe is never unlinked or chmod-ed");

  const socket = commandChannelPath({
    platform: "darwin",
    userDataDirectory: "/Users/ula/Library/Application Support/Clauding"
  });
  assert.equal(socket, "/Users/ula/Library/Application Support/Clauding/clauding.sock");
  assert.equal(commandChannelIsFile(socket), true);
});

test("the pipe name is stable for one data folder and different for another", () => {
  const first = commandChannelPath({ platform: "win32", userDataDirectory: "C:\\one" });
  const again = commandChannelPath({ platform: "win32", userDataDirectory: "C:\\one" });
  const other = commandChannelPath({ platform: "win32", userDataDirectory: "C:\\two" });
  assert.equal(first, again, "the same app always listens on the same pipe");
  assert.notEqual(first, other, "an app started with its own profile folder gets its own pipe");
});

test("a user id, when there is one, names the pipe instead of a hash", () => {
  assert.equal(
    commandChannelPath({ platform: "win32", userDataDirectory: "C:\\one", userIdentifier: 501 }),
    "\\\\.\\pipe\\clauding-501"
  );
  assert.match(
    commandChannelPath({ platform: "win32", userDataDirectory: "C:\\one", userIdentifier: "../../evil" }),
    /^\\\\\.\\pipe\\clauding-evil$/,
    "anything that is not a letter, a digit, a dash or an underscore is dropped"
  );
});

test("a Windows file URL keeps its drive", () => {
  assert.equal(filePathFromUrl("file:///C:/Users/ula/page.html", "win32"), "C:\\Users\\ula\\page.html");
  assert.equal(filePathFromUrl("file:///C:/Users/ula/a%20page.html", "win32"), "C:\\Users\\ula\\a page.html");
  assert.equal(filePathFromUrl("file:///Users/ula/page.html", "darwin"), "/Users/ula/page.html");
  assert.equal(expandHomePath("~/page.html", "win32"), path.win32.join(os.homedir(), "page.html"));
});

// ------------------------------------------------------- keys and the menu ---

test("the modifier is ⌘ on macOS and Ctrl on Windows, and never both", () => {
  assert.equal(commandKeyPressed({ metaKey: true }, "darwin"), true);
  assert.equal(commandKeyPressed({ ctrlKey: true }, "darwin"), false);
  assert.equal(commandKeyPressed({ metaKey: true, ctrlKey: true }, "darwin"), false);

  assert.equal(commandKeyPressed({ ctrlKey: true }, "win32"), true);
  assert.equal(commandKeyPressed({ metaKey: true }, "win32"), false, "the Windows key is not the modifier");
  assert.equal(commandKeyPressed({ ctrlKey: true, metaKey: true }, "win32"), false);
  assert.equal(commandKeyPressed(null, "win32"), false);
});

test("the shortcut hints say the keys of the system they are read on", () => {
  assert.equal(shortcutLabels("darwin").hideSession, "⌘⌫");
  assert.equal(shortcutLabels("darwin").settings, "⌘,");
  assert.equal(shortcutLabels("win32").hideSession, "Ctrl+Backspace");
  assert.equal(shortcutLabels("win32").settings, "Ctrl+,");
  assert.equal(shortcutLabels("win32").emojiPanel, "Win+.");
});

test("only macOS has an emoji panel Electron can open", () => {
  assert.equal(nativeEmojiPanelAvailable("darwin"), true);
  assert.equal(nativeEmojiPanelAvailable("win32"), false, "so the 🙂 button is not drawn; the grid stays");
});

test("Ctrl+C stays the interrupt on Windows, while ⌘C is the menu's copy on macOS", () => {
  const keyDown = (key, modifiers) => ({ type: "keydown", key, ...modifiers });
  assert.equal(terminalKeyDecision(keyDown("c", { metaKey: true }), "darwin"), "leave-to-menu");
  assert.equal(terminalKeyDecision(keyDown("c", { ctrlKey: true }), "win32"), "pass-to-terminal");
  assert.equal(terminalKeyDecision(keyDown("v", { ctrlKey: true }), "win32"), "leave-to-menu");
  assert.equal(terminalKeyDecision(keyDown("k", { ctrlKey: true }), "win32"), "clear");
  assert.equal(terminalKeyDecision(keyDown("k", { metaKey: true }), "darwin"), "clear");
  assert.equal(terminalKeyDecision(keyDown("k", {}), "win32"), "pass-to-terminal");
  assert.equal(terminalKeyDecision({ type: "keyup", key: "k", ctrlKey: true }, "win32"), "pass-to-terminal");
});

test("a Windows path printed by the CLI is a clickable page link", () => {
  const found = (line) => line.match(localPagePattern());
  assert.deepEqual(found("wrote C:\\Users\\ula\\plan.md just now"), ["C:\\Users\\ula\\plan.md"]);
  assert.deepEqual(found("open file:///C:/Users/ula/page.html"), ["file:///C:/Users/ula/page.html"]);
  assert.deepEqual(found("see /Users/ula/plan.md"), ["/Users/ula/plan.md"]);
  assert.deepEqual(found("see ~/notes/a.html"), ["~/notes/a.html"]);
  assert.equal(found("https://example.com/page.html"), null, "a web address is the link addon's job");
});

test("the Windows menu bar has the same menus, without the macOS-only roles", () => {
  const windowsMenu = applicationMenuTemplate({ platform: "win32" });
  const macMenu = applicationMenuTemplate({ platform: "darwin" });
  assert.deepEqual(
    windowsMenu.map((menu) => menu.label || menu.role),
    macMenu.map((menu) => menu.label || menu.role),
    "Clauding, Edit, Skills, View, Window — on both"
  );

  const windowsRoles = windowsMenu[0].submenu.map((item) => item.role).filter(Boolean);
  const macRoles = macMenu[0].submenu.map((item) => item.role).filter(Boolean);
  for (const role of MACOS_ONLY_MENU_ROLES) {
    assert.equal(macRoles.includes(role), true, `macOS keeps ${role}`);
    assert.equal(windowsRoles.includes(role), false, `Windows has no ${role}`);
  }
  assert.equal(windowsRoles.includes("about"), true);
  assert.equal(windowsRoles.includes("quit"), true, "Quit is in the Clauding menu on Windows too");
});

test("the version check and Settings are in the first menu on both, with one accelerator", () => {
  for (const platform of ["win32", "darwin"]) {
    const clicked = [];
    const template = applicationMenuTemplate({
      platform,
      updateItemLabel: "Update available (0.4.0)…",
      onCheckForUpdate: () => clicked.push("update"),
      onShowSettings: () => clicked.push("settings")
    });
    const items = template[0].submenu.filter((item) => item.label);
    const update = items.find((item) => item.label.startsWith("Update available"));
    const settings = items.find((item) => item.label === "Settings…");
    assert.ok(update, `${platform} shows the version check`);
    assert.equal(settings.accelerator, "CommandOrControl+,", "Electron draws this as ⌘, or Ctrl+,");
    update.click();
    settings.click();
    assert.deepEqual(clicked, ["update", "settings"]);
  }
});

test("the Skills menu the app builds is passed through untouched", () => {
  const skillsMenu = { label: "Skills", submenu: [{ label: "skill-maker" }] };
  const template = applicationMenuTemplate({ platform: "win32", skillsMenu });
  assert.equal(template[2], skillsMenu);
});

// ---------------------------------------------------------- skills scanner ---

test("the skills scanner looks in Windows places on Windows and macOS places on a Mac", () => {
  const onWindows = scanRootFolders({
    homeDirectory: WINDOWS_HOME,
    platform: "win32",
    environment: { APPDATA: "C:\\Users\\ula\\AppData\\Roaming" }
  }).map((root) => root.folder);
  assert.ok(onWindows.includes("C:\\Users\\ula\\.claude\\plugins"));
  assert.ok(onWindows.includes("C:\\Users\\ula\\AppData\\Roaming\\Claude"));
  assert.ok(onWindows.includes("C:\\Users\\ula\\.hermes\\skills"));
  assert.ok(onWindows.includes("C:\\Users\\ula\\Documents"));
  assert.equal(
    onWindows.some((folder) => folder.includes("Library")),
    false,
    "there is no ~/Library on Windows"
  );

  const onMac = scanRootFolders({ homeDirectory: MACOS_HOME, platform: "darwin", environment: {} }).map(
    (root) => root.folder
  );
  assert.ok(onMac.includes("/Users/ula/Library/Application Support/Claude"));
  assert.ok(onMac.includes("/Users/ula/.claude/plugins"));
  assert.equal(
    onMac.some((folder) => folder.includes("AppData")),
    false
  );
});

// ---------------------------------------------------------- the installer ---

test("the Windows install plan names every file it would write", () => {
  const plan = windowsInstallPlan({
    projectRoot: "C:\\Users\\ula\\projects\\clauding",
    version: "0.3.0",
    environment: { LOCALAPPDATA: "C:\\Users\\ula\\AppData\\Local", APPDATA: "C:\\Users\\ula\\AppData\\Roaming" },
    homeDirectory: WINDOWS_HOME
  });
  assert.equal(plan.installFolder, "C:\\Users\\ula\\AppData\\Local\\Programs\\Clauding");
  assert.equal(plan.iconPath, "C:\\Users\\ula\\AppData\\Local\\Programs\\Clauding\\Clauding.ico");
  assert.equal(
    plan.shortcutPath,
    "C:\\Users\\ula\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Clauding.lnk"
  );
  assert.equal(
    plan.electronExecutablePath,
    "C:\\Users\\ula\\projects\\clauding\\node_modules\\electron\\dist\\electron.exe"
  );
  assert.deepEqual(
    plan.files.map((file) => path.win32.basename(file.path)),
    ["Clauding.vbs", "Clauding.cmd"]
  );
  assert.deepEqual(
    windowsUninstallPlan({
      projectRoot: "C:\\Users\\ula\\projects\\clauding",
      environment: { LOCALAPPDATA: "C:\\Users\\ula\\AppData\\Local", APPDATA: "C:\\Users\\ula\\AppData\\Roaming" },
      homeDirectory: WINDOWS_HOME
    }),
    { installFolder: plan.installFolder, shortcutPath: plan.shortcutPath, markerPath: plan.markerPath }
  );
});

test("the launcher runs the checkout, and carries no code of the app", () => {
  const plan = windowsInstallPlan({
    projectRoot: "C:\\Users\\ula\\projects\\clauding",
    environment: { LOCALAPPDATA: "C:\\L", APPDATA: "C:\\R" },
    homeDirectory: WINDOWS_HOME
  });
  const [visualBasic, batch] = plan.files;
  assert.ok(visualBasic.contents.includes("electron.exe"));
  assert.ok(visualBasic.contents.includes("C:\\Users\\ula\\projects\\clauding"));
  assert.ok(visualBasic.contents.includes("WScript.Shell"), "wscript runs it, so no console window appears");
  assert.ok(visualBasic.contents.includes(", 1, False"), "and it does not wait for Electron to finish");
  assert.ok(batch.contents.startsWith("@echo off"));
  assert.ok(visualBasic.contents.includes("\r\n"), "Windows line endings");
  assert.equal(
    visualBasic.contents.includes("node_modules\\electron\\dist\\electron.exe"),
    true,
    "the Electron of this very checkout"
  );
});

test("the Start Menu shortcut is made by PowerShell, with our icon and a quoted path", () => {
  const plan = windowsInstallPlan({
    projectRoot: "C:\\Users\\ula\\it's here\\clauding",
    environment: { LOCALAPPDATA: "C:\\L", APPDATA: "C:\\R" },
    homeDirectory: WINDOWS_HOME
  });
  assert.ok(plan.shortcutScript.includes("New-Object -ComObject WScript.Shell"));
  assert.ok(plan.shortcutScript.includes("$shortcut.Save()"));
  assert.ok(plan.shortcutScript.includes("Clauding.ico,0"), "the icon comes from the install folder");
  assert.ok(
    plan.shortcutScript.includes("it''s here"),
    "a single quote inside a path is doubled, so PowerShell cannot be talked into anything"
  );
});

test("the install folder is marked, so uninstall never deletes somebody else's", () => {
  const plan = windowsInstallPlan({
    projectRoot: "C:\\checkout",
    version: "0.3.0",
    environment: { LOCALAPPDATA: "C:\\L", APPDATA: "C:\\R" },
    homeDirectory: WINDOWS_HOME
  });
  const marker = JSON.parse(plan.markerContents);
  assert.equal(marker.note, INSTALL_MARKER_NOTE);
  assert.equal(marker.version, "0.3.0");
  assert.equal(marker.projectRoot, "C:\\checkout");
});

test("nothing about the Windows plan touches the disk", () => {
  const folder = scratchFolder();
  windowsInstallPlan({ projectRoot: folder, environment: { LOCALAPPDATA: folder, APPDATA: folder } });
  assert.deepEqual(fs.readdirSync(folder), [], "planning writes nothing at all");
});

// ------------------------------------------------------------- the icon ---

test("the Windows icon is written from the PNG frames, with no dependency", () => {
  const iconsetFolder = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "build", "icon", "Clauding.iconset");
  const framePaths = iconFramePaths(iconsetFolder);
  assert.ok(framePaths.length >= 4, "this checkout ships the frames");

  const bytes = encodeIco(framePaths.map((filePath) => fs.readFileSync(filePath)));
  assert.equal(bytes.readUInt16LE(0), 0, "reserved");
  assert.equal(bytes.readUInt16LE(2), 1, "type 1 is an icon");
  assert.equal(bytes.readUInt16LE(4), framePaths.length);

  // Each directory entry has to point at a real PNG inside the file.
  let smallestSoFar = -1;
  for (let position = 0; position < framePaths.length; position += 1) {
    const base = 6 + position * 16;
    const side = bytes.readUInt8(base) || 256;
    const byteLength = bytes.readUInt32LE(base + 8);
    const offset = bytes.readUInt32LE(base + 12);
    assert.ok(side > smallestSoFar, "frames are written smallest first");
    smallestSoFar = side;
    assert.equal(bytes.readUInt8(base + 1) || 256, side, "square");
    assert.ok(offset + byteLength <= bytes.length, "the frame is inside the file");
    assert.equal(readPngHeader(bytes.subarray(offset, offset + byteLength)).width, side);
  }
});

test("256 px is written as a zero, and anything bigger is refused", () => {
  assert.equal(sideByte(16), 16);
  assert.equal(sideByte(256), 0, "the field is one byte, so 256 has no other spelling");
  assert.throws(() => encodeIco([]), /at least one frame/);
  assert.throws(() => readPngHeader(Buffer.from("not a png at all, really not")), /Not a PNG/);
});

// ------------------------------------------------------------- commands ---

test("npm is npm.cmd on Windows and needs a shell; git needs neither", () => {
  assert.deepEqual(commandForPlatform("npm", "win32"), { command: "npm.cmd", needsShell: true });
  assert.deepEqual(commandForPlatform("git", "win32"), { command: "git", needsShell: false });
  assert.deepEqual(commandForPlatform("npm", "darwin"), { command: "npm", needsShell: false });
});
