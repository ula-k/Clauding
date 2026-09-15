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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = process.env.CLAUDING_APP_BUNDLE || "/Applications/Clauding.app";
const contentsFolder = path.join(bundlePath, "Contents");
const executableFolder = path.join(contentsFolder, "MacOS");
const resourcesFolder = path.join(contentsFolder, "Resources");
const iconSourcePath = path.join(projectRoot, "build", "icon", "Clauding.icns");

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version || "0.0.0";
  } catch (error) {
    return "0.0.0";
  }
}

function informationPropertyList(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Clauding</string>
  <key>CFBundleDisplayName</key><string>Clauding</string>
  <key>CFBundleIdentifier</key><string>com.clauding.app</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Clauding</string>
  <key>CFBundleIconFile</key><string>Clauding</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}

// A Dock-launched app inherits a minimal PATH, so the usual shell folders are
// put back before Electron starts: the `claude` CLI and the tools it spawns
// (git, node, brew-installed binaries) have to be findable from inside a
// terminal of the app.
function launcherScript(projectFolder) {
  return `#!/bin/zsh
# Launches Clauding from its project folder with the Electron binary installed there.
# The renderer is the last \`npm run build\` output (dist/renderer).
# Written by \`npm run install-app\`; re-run it after moving the project folder.
PROJECT_DIRECTORY=${JSON.stringify(projectFolder)}
ELECTRON_BINARY="$PROJECT_DIRECTORY/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$PROJECT_DIRECTORY" || exit 1
exec "$ELECTRON_BINARY" "$PROJECT_DIRECTORY"
`;
}

function buildRenderer() {
  console.log("[install-app] npm run build");
  execFileSync("npm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
}

function writeBundle() {
  fs.rmSync(bundlePath, { recursive: true, force: true });
  fs.mkdirSync(executableFolder, { recursive: true });
  fs.mkdirSync(resourcesFolder, { recursive: true });

  fs.writeFileSync(path.join(contentsFolder, "Info.plist"), informationPropertyList(packageVersion()));

  const launcherPath = path.join(executableFolder, "Clauding");
  fs.writeFileSync(launcherPath, launcherScript(projectRoot));
  fs.chmodSync(launcherPath, 0o755);

  if (fs.existsSync(iconSourcePath)) {
    fs.copyFileSync(iconSourcePath, path.join(resourcesFolder, "Clauding.icns"));
  } else {
    console.log(`[install-app] no icon at ${iconSourcePath}; the app gets the generic one`);
  }
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
