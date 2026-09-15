// The files `npm run install-app` puts inside Clauding.app: the property
// list, the zsh launcher and the icon. Kept apart from installApp.js so the
// bundle can be written into a throw-away folder and read back (see
// test/installApp.test.js) without building the renderer or going anywhere
// near /Applications.
import fs from "node:fs";
import path from "node:path";

export function informationPropertyList(version) {
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
export function launcherScript(projectFolder) {
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

export function packageVersion(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version || "0.0.0";
  } catch (error) {
    return "0.0.0";
  }
}

// Writes the whole bundle, replacing anything that was there before.
// Returns the paths it wrote, and whether the icon was found.
export function writeLauncherBundle({ bundlePath, projectRoot, iconSourcePath, report }) {
  const contentsFolder = path.join(bundlePath, "Contents");
  const executableFolder = path.join(contentsFolder, "MacOS");
  const resourcesFolder = path.join(contentsFolder, "Resources");
  const informationPath = path.join(contentsFolder, "Info.plist");
  const launcherPath = path.join(executableFolder, "Clauding");
  const iconPath = path.join(resourcesFolder, "Clauding.icns");

  fs.rmSync(bundlePath, { recursive: true, force: true });
  fs.mkdirSync(executableFolder, { recursive: true });
  fs.mkdirSync(resourcesFolder, { recursive: true });

  fs.writeFileSync(informationPath, informationPropertyList(packageVersion(projectRoot)));
  fs.writeFileSync(launcherPath, launcherScript(projectRoot));
  fs.chmodSync(launcherPath, 0o755);

  const hasIcon = Boolean(iconSourcePath) && fs.existsSync(iconSourcePath);
  if (hasIcon) {
    fs.copyFileSync(iconSourcePath, iconPath);
  } else if (report) {
    report(`no icon at ${iconSourcePath}; the app gets the generic one`);
  }

  return { informationPath, launcherPath, iconPath, hasIcon };
}
