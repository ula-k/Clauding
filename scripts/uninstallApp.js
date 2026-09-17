// `npm run uninstall-app`: removes what `npm run install-app` put outside
// the checkout — the /Applications bundle on macOS, the launcher folder and
// the Start Menu shortcut on Windows.
//
// Only those go. The project folder stays, and so does everything the app
// stores in its own data folder (~/Library/Application Support/Clauding, or
// %APPDATA%\Clauding on Windows): the groups, the agents, the preamble, the
// panel tabs. Delete that folder by hand if you want those gone too.
import fs from "node:fs";
import os from "node:os";
import { isClaudingBundle } from "./lib/appBundle.js";
import { INSTALL_MARKER_NOTE, windowsUninstallPlan } from "./lib/windowsLauncher.js";
import { isWindows } from "../electron/lib/platformPaths.js";

const bundlePath = process.env.CLAUDING_APP_BUNDLE || "/Applications/Clauding.app";

function report(line) {
  console.log(`[uninstall-app] ${line}`);
}

// True only for a folder install-app wrote, so this can never delete
// somebody else's Clauding folder — the same rule isClaudingBundle follows.
export function isClaudingInstallFolder(markerPath) {
  try {
    return String(JSON.parse(fs.readFileSync(markerPath, "utf8")).note || "").includes(INSTALL_MARKER_NOTE);
  } catch (error) {
    return false;
  }
}

function uninstallOnWindows() {
  const plan = windowsUninstallPlan({ projectRoot: process.cwd(), environment: process.env, homeDirectory: os.homedir() });
  if (!fs.existsSync(plan.installFolder)) {
    report(`nothing to remove: there is no ${plan.installFolder}`);
  } else if (!isClaudingInstallFolder(plan.markerPath)) {
    report(`${plan.installFolder} was not written by install-app — left alone.`);
    process.exit(1);
  } else {
    fs.rmSync(plan.installFolder, { recursive: true, force: true });
    report(`removed ${plan.installFolder}`);
  }
  if (fs.existsSync(plan.shortcutPath)) {
    fs.rmSync(plan.shortcutPath, { force: true });
    report(`removed ${plan.shortcutPath}`);
  }
  report("the app's own data folder was kept.");
}

function uninstallOnMacOS() {
  if (!fs.existsSync(bundlePath)) {
    report(`nothing to remove: there is no ${bundlePath}`);
    return;
  }
  // Only ever remove our own bundle, never some other Clauding.app.
  if (!isClaudingBundle(bundlePath)) {
    report(`${bundlePath} was not written by install-app — left alone.`);
    process.exit(1);
  }
  fs.rmSync(bundlePath, { recursive: true, force: true });
  report(`removed ${bundlePath}`);
  report("~/Library/Application Support/Clauding was kept.");
}

function main() {
  if (isWindows()) {
    uninstallOnWindows();
    return;
  }
  uninstallOnMacOS();
}

main();
