// CL-17 — what `npm run install-app` puts inside Clauding.app
// (scripts/lib/launcherBundle.js). The bundle is written into a throw-away
// folder under the system temporary folder: /Applications is never touched,
// the renderer is not built and nothing is launched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  informationPropertyList,
  launcherScript,
  packageVersion,
  writeLauncherBundle
} from "../scripts/lib/launcherBundle.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-install-"));
}

function writeBundleInto(folder, iconSourcePath) {
  const bundlePath = path.join(folder, "Clauding.app");
  const written = writeLauncherBundle({ bundlePath, projectRoot, iconSourcePath });
  return { bundlePath, written };
}

test("the bundle is a property list, an executable script and an icon", () => {
  const folder = scratchFolder();
  const iconSourcePath = path.join(projectRoot, "build", "icon", "Clauding.icns");
  const { bundlePath, written } = writeBundleInto(folder, iconSourcePath);

  assert.equal(fs.existsSync(path.join(bundlePath, "Contents", "Info.plist")), true);
  assert.equal(fs.existsSync(path.join(bundlePath, "Contents", "MacOS", "Clauding")), true);
  assert.equal(written.hasIcon, true, "this checkout has build/icon/Clauding.icns");
  assert.equal(fs.existsSync(path.join(bundlePath, "Contents", "Resources", "Clauding.icns")), true);

  const mode = fs.statSync(written.launcherPath).mode & 0o777;
  assert.equal(mode, 0o755, "the launcher can be run by the Dock");
});

test("the property list carries the version from package.json", () => {
  const folder = scratchFolder();
  const { bundlePath } = writeBundleInto(folder, null);
  const text = fs.readFileSync(path.join(bundlePath, "Contents", "Info.plist"), "utf8");
  const version = packageVersion(projectRoot);
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.ok(text.includes(`<key>CFBundleVersion</key><string>${version}</string>`));
  assert.ok(text.includes("<key>CFBundleExecutable</key><string>Clauding</string>"));
  assert.ok(text.includes("<key>CFBundleIdentifier</key><string>com.clauding.app</string>"));
  assert.ok(text.startsWith("<?xml"), "it is a property list, not a fragment");
});

test("a checkout with no package.json still gets a version", () => {
  assert.equal(packageVersion(scratchFolder()), "0.0.0");
});

test("the launcher starts this checkout, with the usual shell folders on PATH", () => {
  const folder = scratchFolder();
  const { written } = writeBundleInto(folder, null);
  const script = fs.readFileSync(written.launcherPath, "utf8");
  assert.ok(script.startsWith("#!/bin/zsh"));
  assert.ok(script.includes(`PROJECT_DIRECTORY=${JSON.stringify(projectRoot)}`), "the project folder is written in");
  assert.ok(script.includes("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"));
  // A Dock-launched app has almost nothing on PATH; `claude` and `clauding`
  // have to be findable from a terminal of the app.
  assert.ok(script.includes('export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'));
});

test("the project folder is the one this script lives in, whatever the folder is called", () => {
  const madeUpCheckout = "/Users/someone/some where/clauding";
  const script = launcherScript(madeUpCheckout);
  assert.ok(script.includes('PROJECT_DIRECTORY="/Users/someone/some where/clauding"'), "a space in the path survives");
  assert.equal(fs.existsSync(path.join(projectRoot, "package.json")), true, "the resolved root is the checkout");
  assert.equal(path.basename(projectRoot), path.basename(path.resolve(projectRoot)));
});

test("a missing icon is reported and does not stop the bundle", () => {
  const folder = scratchFolder();
  const reported = [];
  const bundlePath = path.join(folder, "Clauding.app");
  const written = writeLauncherBundle({
    bundlePath,
    projectRoot,
    iconSourcePath: path.join(folder, "no-icon-here.icns"),
    report(line) {
      reported.push(line);
    }
  });
  assert.equal(written.hasIcon, false);
  assert.equal(fs.existsSync(written.launcherPath), true);
  assert.equal(reported.length, 1);
  assert.match(reported[0], /icon/i);
});

test("installing again replaces what was there before", () => {
  const folder = scratchFolder();
  const bundlePath = path.join(folder, "Clauding.app");
  writeLauncherBundle({ bundlePath, projectRoot, iconSourcePath: null });
  const leftover = path.join(bundlePath, "Contents", "MacOS", "left-over-file");
  fs.writeFileSync(leftover, "from an older install");
  writeLauncherBundle({ bundlePath, projectRoot, iconSourcePath: null });
  assert.equal(fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(path.join(bundlePath, "Contents", "MacOS", "Clauding")), true);
});

test("writing a bundle touches nothing outside the folder it was given", () => {
  const folder = scratchFolder();
  writeBundleInto(folder, null);
  assert.deepEqual(fs.readdirSync(folder), ["Clauding.app"]);
  const insideBundle = fs.readdirSync(path.join(folder, "Clauding.app", "Contents")).sort();
  assert.deepEqual(insideBundle, ["Info.plist", "MacOS", "Resources"]);
});

test("the property list is the same text for the same version", () => {
  assert.equal(informationPropertyList("1.2.3"), informationPropertyList("1.2.3"));
  assert.ok(informationPropertyList("1.2.3").includes("<string>1.2.3</string>"));
});
