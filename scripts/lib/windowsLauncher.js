// What `npm run install-app` puts on a Windows machine.
//
// There is no bundle to rename here. On macOS the whole trick is that the
// menu-bar title and the About panel are read out of Clauding.app, so
// Electron.app has to be copied and rewritten (scripts/lib/appBundle.js). On
// Windows nothing reads a bundle: `app.setName("Clauding")` in
// electron/main.js is what names the window and the task-bar entry, so the
// install is only three small things next to the checkout:
//
//   %LOCALAPPDATA%\Programs\Clauding\Clauding.vbs   double-click launcher,
//       started by wscript.exe so no console window flashes up
//   %LOCALAPPDATA%\Programs\Clauding\Clauding.cmd   the same from a terminal
//   %LOCALAPPDATA%\Programs\Clauding\Clauding.ico   the icon, written from
//       the PNG frames by scripts/lib/icoEncoder.js
//   %APPDATA%\…\Start Menu\Programs\Clauding.lnk    the Start Menu entry,
//       created through PowerShell's WScript.Shell, pointing straight at
//       this checkout's electron.exe so the running process is Electron's
//       own and the icon is ours
//
// All of it runs the checkout, exactly like the macOS bundle does: nothing
// is copied, and `git pull` + `npm run build` is enough for the next launch.
//
// Everything in this file is a plan — paths and file contents as values —
// so test/platform.test.js can read back what *would* be written, on a Mac,
// without running PowerShell and without touching %LOCALAPPDATA%.
import { pathFor } from "../../electron/lib/platformPaths.js";

export const APPLICATION_NAME = "Clauding";
export const WINDOWS_ICON_FILE_NAME = "Clauding.ico";
export const INSTALL_MARKER_FILE_NAME = "clauding-install.json";
export const INSTALL_MARKER_NOTE = "Written by `npm run install-app`.";

function windowsPath() {
  return pathFor("win32");
}

// %LOCALAPPDATA%, %APPDATA% — with the usual folders as a fallback, so a
// plan can be made for a machine whose environment was not handed in.
export function windowsFolders({ environment = process.env, homeDirectory = "C:\\Users\\you" } = {}) {
  const pathModule = windowsPath();
  const localAppData = environment.LOCALAPPDATA || pathModule.join(homeDirectory, "AppData", "Local");
  const roamingAppData = environment.APPDATA || pathModule.join(homeDirectory, "AppData", "Roaming");
  return { localAppData, roamingAppData };
}

// The VBScript launcher. WScript.Shell.Run with bWaitOnReturn False starts
// Electron and lets wscript.exe exit at once; because the script is run by
// wscript (not cscript) no console window is ever created.
export function vbScriptLauncher({ electronExecutablePath, projectRoot }) {
  const quote = (text) => String(text).replace(/"/g, '""');
  return [
    "' Written by `npm run install-app`. It carries no code of the app:",
    "' it starts this checkout with the Electron from its node_modules, so",
    "' the running app is always the project folder and its last build.",
    "Set windowsShell = CreateObject(\"WScript.Shell\")",
    `windowsShell.CurrentDirectory = "${quote(projectRoot)}"`,
    `windowsShell.Run """${quote(electronExecutablePath)}"" ""${quote(projectRoot)}""", 1, False`,
    ""
  ].join("\r\n");
}

// The same from a command prompt, for anyone who wants to see the log.
export function commandLauncher({ electronExecutablePath, projectRoot }) {
  return [
    "@echo off",
    "rem Written by `npm run install-app`. Starts this checkout with the",
    "rem Electron from its node_modules, and keeps the console so the app's",
    "rem own log can be read. Clauding.vbs next to it does the same silently.",
    `cd /d "${projectRoot}"`,
    `"${electronExecutablePath}" "${projectRoot}" %*`,
    ""
  ].join("\r\n");
}

// PowerShell quoting: single quotes, and a single quote inside is doubled.
function powerShellText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// The Start Menu entry. WScript.Shell is the COM object Windows itself uses
// for shortcuts, and PowerShell is the one interpreter guaranteed to be
// there — no extra dependency, no .lnk written byte by byte.
export function shortcutPowerShell({
  shortcutPath,
  electronExecutablePath,
  projectRoot,
  iconPath,
  description = "A desktop window around your Claude Code sessions"
}) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$shortcutFolder = Split-Path -Parent ${powerShellText(shortcutPath)}`,
    "if (-not (Test-Path $shortcutFolder)) { New-Item -ItemType Directory -Path $shortcutFolder -Force | Out-Null }",
    "$windowsShell = New-Object -ComObject WScript.Shell",
    `$shortcut = $windowsShell.CreateShortcut(${powerShellText(shortcutPath)})`,
    `$shortcut.TargetPath = ${powerShellText(electronExecutablePath)}`,
    `$shortcut.Arguments = ${powerShellText(`"${projectRoot}"`)}`,
    `$shortcut.WorkingDirectory = ${powerShellText(projectRoot)}`,
    `$shortcut.IconLocation = ${powerShellText(`${iconPath},0`)}`,
    `$shortcut.Description = ${powerShellText(description)}`,
    "$shortcut.Save()",
    ""
  ].join("\r\n");
}

// The whole install, as a value: every path that would be written and
// everything that would go into it.
export function windowsInstallPlan({
  projectRoot,
  version = "0.0.0",
  environment = process.env,
  homeDirectory = "C:\\Users\\you"
} = {}) {
  const pathModule = windowsPath();
  const { localAppData, roamingAppData } = windowsFolders({ environment, homeDirectory });
  const installFolder = pathModule.join(localAppData, "Programs", APPLICATION_NAME);
  const iconPath = pathModule.join(installFolder, WINDOWS_ICON_FILE_NAME);
  const electronExecutablePath = pathModule.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
  const shortcutPath = pathModule.join(
    roamingAppData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${APPLICATION_NAME}.lnk`
  );
  const markerPath = pathModule.join(installFolder, INSTALL_MARKER_FILE_NAME);
  return {
    installFolder,
    electronExecutablePath,
    iconPath,
    iconFramesFolder: pathModule.join(projectRoot, "build", "icon", `${APPLICATION_NAME}.iconset`),
    iconSourcePath: pathModule.join(projectRoot, "build", "icon", WINDOWS_ICON_FILE_NAME),
    shortcutPath,
    markerPath,
    markerContents: `${JSON.stringify(
      { note: INSTALL_MARKER_NOTE, application: APPLICATION_NAME, version, projectRoot },
      null,
      2
    )}\n`,
    files: [
      {
        path: pathModule.join(installFolder, `${APPLICATION_NAME}.vbs`),
        contents: vbScriptLauncher({ electronExecutablePath, projectRoot })
      },
      {
        path: pathModule.join(installFolder, `${APPLICATION_NAME}.cmd`),
        contents: commandLauncher({ electronExecutablePath, projectRoot })
      }
    ],
    shortcutScript: shortcutPowerShell({ shortcutPath, electronExecutablePath, projectRoot, iconPath })
  };
}

// What `npm run uninstall-app` would remove: the install folder and the
// Start Menu entry, and nothing else — the checkout and the app's own data
// folder are left exactly as they are.
export function windowsUninstallPlan(options = {}) {
  const plan = windowsInstallPlan(options);
  return {
    installFolder: plan.installFolder,
    shortcutPath: plan.shortcutPath,
    markerPath: plan.markerPath
  };
}
