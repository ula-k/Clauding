// `npm run install-app`: builds the renderer, then makes the app startable
// like any other — from Launchpad and Spotlight on macOS, from the Start
// Menu on Windows.
//
// **macOS.** A real application bundle at /Applications/Clauding.app: a
// renamed copy of the Electron.app in this checkout's node_modules (see
// scripts/lib/appBundle.js for why a copy and not a launcher script). It
// holds no code of the app: its entry imports this checkout's
// electron/main.js by absolute path.
//
// **Windows.** No bundle: `app.setName()` is what names the window there, so
// the install is a launcher and an icon in
// %LOCALAPPDATA%\Programs\Clauding\ plus a Start Menu shortcut — all of them
// pointing at this checkout (see scripts/lib/windowsLauncher.js).
//
// Either way the running app is always the project folder and the last
// `npm run build`; after `git pull` run this again.
//
// CLAUDING_APP_BUNDLE=<path> writes the macOS bundle somewhere else instead,
// which is how it can be inspected without touching /Applications.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildApplicationBundle, packageVersion } from "./lib/appBundle.js";
import { writeIcoFromIconset } from "./lib/icoEncoder.js";
import { windowsInstallPlan } from "./lib/windowsLauncher.js";
import { isMacOS, isWindows } from "../electron/lib/platformPaths.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = process.env.CLAUDING_APP_BUNDLE || "/Applications/Clauding.app";
const iconSourcePath = path.join(projectRoot, "build", "icon", "Clauding.icns");
const electronBundlePath = path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app");

function report(line) {
  console.log(`[install-app] ${line}`);
}

function buildRenderer() {
  report("npm run build");
  // npm on Windows is npm.cmd, a batch file, and execFile needs a shell for
  // one; git and node do not.
  const npmCommand = isWindows() ? "npm.cmd" : "npm";
  execFileSync(npmCommand, ["run", "build"], { cwd: projectRoot, stdio: "inherit", shell: isWindows() });
}

// The bundle is assembled outside its final home and only then moved into
// place, so a half-written Clauding.app is never what the Dock picks up.
function buildStagedBundle() {
  const stagingFolder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-install-"));
  const stagedBundlePath = path.join(stagingFolder, "Clauding.app");
  report(`assembling the bundle in ${stagingFolder}`);
  const written = buildApplicationBundle({
    bundlePath: stagedBundlePath,
    projectRoot,
    electronBundlePath,
    iconSourcePath,
    signIdentity: "-",
    report
  });
  return { stagingFolder, written };
}

function moveIntoPlace(stagedBundlePath) {
  fs.rmSync(bundlePath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  try {
    fs.renameSync(stagedBundlePath, bundlePath);
  } catch (error) {
    // A different volume: copy it over and drop the staged one.
    execFileSync("ditto", [stagedBundlePath, bundlePath]);
    fs.rmSync(stagedBundlePath, { recursive: true, force: true });
  }
}

// Finder and the Dock cache a bundle by its modification time, so the new
// icon and name only show after the bundle is touched.
function refreshFinder() {
  try {
    execFileSync("touch", [bundlePath]);
  } catch (error) {
    report(`could not touch ${bundlePath}: ${error.message}`);
  }
}

function installOnMacOS() {
  if (!fs.existsSync(path.join(electronBundlePath, "Contents", "MacOS", "Electron"))) {
    report("Electron is not installed yet — run `npm install` first.");
    process.exit(1);
  }
  buildRenderer();
  const { stagingFolder, written } = buildStagedBundle();
  report(`version ${written.version}, icon ${written.hasIcon ? "ours" : "generic"}, signed ${written.signed}`);
  moveIntoPlace(written.bundlePath);
  fs.rmSync(stagingFolder, { recursive: true, force: true });
  refreshFinder();
  report(`${bundlePath} now runs Clauding from ${projectRoot}`);
  report("open it from Launchpad, Spotlight, or with: open -a Clauding");
}

// The icon the shortcut points at. build/icon/Clauding.ico is generated from
// the PNG frames — by this script when it is missing, so a fresh checkout
// needs nothing extra.
function ensureWindowsIcon(plan) {
  if (fs.existsSync(plan.iconSourcePath)) {
    return plan.iconSourcePath;
  }
  try {
    const written = writeIcoFromIconset({
      iconsetFolder: plan.iconFramesFolder,
      targetPath: plan.iconSourcePath
    });
    report(`wrote ${plan.iconSourcePath} from ${written.framePaths.length} PNG frames`);
    return plan.iconSourcePath;
  } catch (error) {
    report(`no icon: ${error.message}`);
    return "";
  }
}

function installOnWindows() {
  const plan = windowsInstallPlan({
    projectRoot,
    version: packageVersion(projectRoot),
    environment: process.env,
    homeDirectory: os.homedir()
  });
  if (!fs.existsSync(plan.electronExecutablePath)) {
    report("Electron is not installed yet — run `npm install` first.");
    process.exit(1);
  }
  buildRenderer();
  fs.mkdirSync(plan.installFolder, { recursive: true });
  for (const file of plan.files) {
    fs.writeFileSync(file.path, file.contents);
    report(`wrote ${file.path}`);
  }
  const iconSource = ensureWindowsIcon(plan);
  if (iconSource) {
    fs.copyFileSync(iconSource, plan.iconPath);
  }
  fs.writeFileSync(plan.markerPath, plan.markerContents);
  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", plan.shortcutScript],
      { stdio: "pipe" }
    );
    report(`Start Menu shortcut at ${plan.shortcutPath}`);
  } catch (error) {
    report(`could not create the Start Menu shortcut: ${error.message}`);
    report(`start it from ${plan.files[0].path} instead`);
  }
  report(`${plan.installFolder} now runs Clauding from ${projectRoot}`);
  report("open it from the Start Menu, or by double-clicking Clauding.vbs in that folder.");
}

function main() {
  if (isMacOS()) {
    installOnMacOS();
    return;
  }
  if (isWindows()) {
    installOnWindows();
    return;
  }
  report("only macOS and Windows have an install step; elsewhere start the app with `npm start`.");
  process.exit(1);
}

main();
