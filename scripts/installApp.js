// `npm run install-app`: builds the renderer, then puts a real macOS
// application bundle at /Applications/Clauding.app.
//
// The bundle is a renamed copy of the Electron.app in this checkout's
// node_modules (see scripts/lib/appBundle.js for why a copy and not a
// launcher script). It holds no code of the app: its entry imports this
// checkout's electron/main.js by absolute path, so the running app is always
// the project folder and the last `npm run build`. After `git pull` run this
// again — the Electron version, the version number and the icon in the
// bundle are the ones that were current when it was written.
//
// CLAUDING_APP_BUNDLE=<path> writes the bundle somewhere else instead, which
// is how it can be inspected without touching /Applications.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildApplicationBundle } from "./lib/appBundle.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = process.env.CLAUDING_APP_BUNDLE || "/Applications/Clauding.app";
const iconSourcePath = path.join(projectRoot, "build", "icon", "Clauding.icns");
const electronBundlePath = path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app");

function report(line) {
  console.log(`[install-app] ${line}`);
}

function buildRenderer() {
  report("npm run build");
  execFileSync("npm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
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

function main() {
  if (process.platform !== "darwin") {
    report("this application bundle only makes sense on macOS.");
    process.exit(1);
  }
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

main();
