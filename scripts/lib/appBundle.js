// What `npm run install-app` puts in /Applications: a real macOS application
// bundle, not a shell script any more.
//
// The bundle is Electron's own `Electron.app` from this checkout, copied and
// then renamed: the property list says Clauding, the executable is called
// Clauding, the icon is ours. That rename is the whole point — macOS reads
// the name of the leftmost menu-bar menu and of the standard About panel
// from the bundle, never from `app.setName()`, so a launcher that only
// started the stock Electron.app could never be called anything but
// "Electron".
//
// It still holds no code of its own: `Contents/Resources/app/main.js` is two
// lines that import this checkout's `electron/main.js` by its absolute path,
// so the bundle keeps running the project folder and the last
// `npm run build`. Nothing is copied except Electron itself, and everything
// the app loads (the renderer, the icon, `builtin/`, `bin/`, node_modules)
// is resolved from where `electron/main.js` lives.
//
// Kept apart from installApp.js so the bundle can be written into a
// throw-away folder from a fake Electron.app and read back (see
// test/installApp.test.js) without building the renderer, without signing
// and without going anywhere near /Applications.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const APPLICATION_NAME = "Clauding";
export const BUNDLE_IDENTIFIER = "com.clauding.app";
export const ICON_FILE_NAME = "Clauding.icns";

export function packageVersion(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version || "0.0.0";
  } catch (error) {
    return "0.0.0";
  }
}

// The app folder inside the bundle. Electron prefers Contents/Resources/app
// over the default app that ships with it, and an ES module entry needs the
// "module" type, exactly like the project's own package.json.
export function bundlePackageManifest(version) {
  return `${JSON.stringify({ name: "clauding", version, main: "main.js", type: "module" }, null, 2)}\n`;
}

// The two-line entry. A static import (not a dynamic one) so Electron has
// finished evaluating the real main process file — `app.setName`, the single
// instance lock, the menu — before it emits "ready".
export function bundleEntryScript(projectRoot) {
  const entryUrl = pathToFileURL(path.join(projectRoot, "electron", "main.js")).href;
  return `// Written by \`npm run install-app\`. The bundle carries no code: it runs the
// checked-out project below, with the renderer from its last \`npm run build\`.
// Re-run \`npm run install-app\` after moving the checkout.
import ${JSON.stringify(entryUrl)};
`;
}

// The property list keys that turn a copy of Electron.app into Clauding.app.
// CFBundleName is the one macOS shows as the leftmost menu-bar title.
export function informationPropertyEdits(version) {
  return [
    ["CFBundleName", APPLICATION_NAME],
    ["CFBundleDisplayName", APPLICATION_NAME],
    ["CFBundleIdentifier", BUNDLE_IDENTIFIER],
    ["CFBundleExecutable", APPLICATION_NAME],
    ["CFBundleIconFile", ICON_FILE_NAME],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
    ["LSApplicationCategoryType", "public.app-category.developer-tools"]
  ];
}

function readStringProperty(informationPath, key) {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", informationPath], {
      encoding: "utf8"
    }).trim();
  } catch (error) {
    return "";
  }
}

function writeStringProperty(informationPath, key, value) {
  execFileSync("plutil", ["-replace", key, "-string", value, informationPath], { stdio: "pipe" });
}

function copyFolder(sourcePath, targetPath) {
  if (process.platform === "darwin") {
    // `ditto` is the copy that keeps a bundle intact: symlinks inside the
    // frameworks, permissions and extended attributes.
    execFileSync("ditto", [sourcePath, targetPath]);
    return;
  }
  fs.cpSync(sourcePath, targetPath, { recursive: true, verbatimSymlinks: true });
}

// True only for a bundle this script wrote, so `npm run uninstall-app` can
// never delete somebody else's Clauding.app.
export function isClaudingBundle(bundlePath) {
  const entryPath = path.join(bundlePath, "Contents", "Resources", "app", "main.js");
  try {
    return fs.readFileSync(entryPath, "utf8").includes("npm run install-app");
  } catch (error) {
    return false;
  }
}

// Writes the whole bundle at `bundlePath`, replacing anything that was there.
// `electronBundlePath` is the Electron.app to copy (the one in this
// checkout's node_modules; the tests hand in a skeleton instead).
// `signIdentity` is "-" for the ad-hoc signature macOS needs after the
// property list has been rewritten, or null to skip signing (the tests do).
export function buildApplicationBundle({
  bundlePath,
  projectRoot,
  electronBundlePath,
  iconSourcePath,
  signIdentity = null,
  report
}) {
  const version = packageVersion(projectRoot);
  const contentsFolder = path.join(bundlePath, "Contents");
  const executableFolder = path.join(contentsFolder, "MacOS");
  const resourcesFolder = path.join(contentsFolder, "Resources");
  const informationPath = path.join(contentsFolder, "Info.plist");
  const applicationFolder = path.join(resourcesFolder, "app");
  const entryPath = path.join(applicationFolder, "main.js");
  const manifestPath = path.join(applicationFolder, "package.json");
  const iconPath = path.join(resourcesFolder, ICON_FILE_NAME);

  fs.rmSync(bundlePath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  copyFolder(electronBundlePath, bundlePath);

  // The stock binary is Contents/MacOS/Electron; a packaged app names it
  // after itself, and so does this one — `ps` and Activity Monitor then say
  // Clauding instead of Electron.
  const stockExecutableName = readStringProperty(informationPath, "CFBundleExecutable") || "Electron";
  const stockExecutablePath = path.join(executableFolder, stockExecutableName);
  const executablePath = path.join(executableFolder, APPLICATION_NAME);
  if (stockExecutablePath !== executablePath && fs.existsSync(stockExecutablePath)) {
    fs.renameSync(stockExecutablePath, executablePath);
  }

  for (const [key, value] of informationPropertyEdits(version)) {
    writeStringProperty(informationPath, key, value);
  }

  const hasIcon = Boolean(iconSourcePath) && fs.existsSync(iconSourcePath);
  if (hasIcon) {
    fs.copyFileSync(iconSourcePath, iconPath);
    fs.rmSync(path.join(resourcesFolder, "electron.icns"), { force: true });
  } else if (report) {
    report(`no icon at ${iconSourcePath}; the app gets the generic one`);
  }

  fs.mkdirSync(applicationFolder, { recursive: true });
  fs.writeFileSync(manifestPath, bundlePackageManifest(version));
  fs.writeFileSync(entryPath, bundleEntryScript(projectRoot));

  // Electron came out of a downloaded archive, so it may still be marked as
  // quarantined; a fresh copy in /Applications would meet Gatekeeper.
  let signed = false;
  if (process.platform === "darwin") {
    try {
      execFileSync("xattr", ["-cr", bundlePath], { stdio: "pipe" });
    } catch (error) {
      if (report) {
        report(`could not clear the quarantine flag: ${error.message}`);
      }
    }
  }
  if (signIdentity) {
    // Rewriting the property list breaks Electron's own signature, and macOS
    // refuses to start a bundle whose signature no longer matches.
    execFileSync("codesign", ["--force", "--deep", "--sign", signIdentity, bundlePath], { stdio: "pipe" });
    signed = true;
  }

  return { bundlePath, informationPath, executablePath, entryPath, manifestPath, iconPath, hasIcon, signed, version };
}
