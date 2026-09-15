// `npm run install-app`: builds the renderer, then puts a small launcher
// bundle at /Applications/Clauding.app.
//
// The bundle holds no code of its own — it is a zsh script that starts the
// Electron binary from this project folder with the last `npm run build`
// output. That keeps one copy of the app (this checkout) and makes the Dock
// icon, Spotlight and `open -a Clauding` work like any other Mac app. The
// project folder is written into the script at install time, resolved from
// where this file lives, so a clone anywhere works.
//
// Running it again simply overwrites the bundle.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeLauncherBundle } from "./lib/launcherBundle.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = process.env.CLAUDING_APP_BUNDLE || "/Applications/Clauding.app";
const iconSourcePath = path.join(projectRoot, "build", "icon", "Clauding.icns");

function buildRenderer() {
  console.log("[install-app] npm run build");
  execFileSync("npm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
}

function writeBundle() {
  writeLauncherBundle({
    bundlePath,
    projectRoot,
    iconSourcePath,
    report(line) {
      console.log(`[install-app] ${line}`);
    }
  });
}

// Finder and the Dock cache a bundle by its modification time, so the new
// icon and name only show after the bundle is touched.
function refreshFinder() {
  try {
    execFileSync("touch", [bundlePath]);
  } catch (error) {
    console.log(`[install-app] could not touch ${bundlePath}: ${error.message}`);
  }
}

function main() {
  if (process.platform !== "darwin") {
    console.log("[install-app] this launcher bundle only makes sense on macOS.");
    process.exit(1);
  }
  const electronBinary = path.join(
    projectRoot,
    "node_modules",
    "electron",
    "dist",
    "Electron.app",
    "Contents",
    "MacOS",
    "Electron"
  );
  if (!fs.existsSync(electronBinary)) {
    console.log("[install-app] Electron is not installed yet — run `npm install` first.");
    process.exit(1);
  }
  buildRenderer();
  writeBundle();
  refreshFinder();
  console.log(`[install-app] ${bundlePath} now starts Clauding from ${projectRoot}`);
  console.log("[install-app] open it from Launchpad, Spotlight, or with: open -a Clauding");
}

main();
