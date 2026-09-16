// CL-17 — what `npm run install-app` puts inside Clauding.app
// (scripts/lib/appBundle.js). Everything happens in a throw-away folder
// under the system temporary folder, from a fake Electron.app skeleton:
// /Applications is never touched, the real 300 MB Electron is never copied,
// the renderer is not built, nothing is signed and nothing is launched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_NAME,
  BUNDLE_IDENTIFIER,
  bundleEntryScript,
  bundlePackageManifest,
  buildApplicationBundle,
  informationPropertyEdits,
  isClaudingBundle,
  packageVersion
} from "../scripts/lib/appBundle.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratchFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clauding-test-install-"));
}

// A stand-in for node_modules/electron/dist/Electron.app: the same shape,
// none of the weight.
function fakeElectronBundle(folder) {
  const bundlePath = path.join(folder, "Electron.app");
  const contentsFolder = path.join(bundlePath, "Contents");
  fs.mkdirSync(path.join(contentsFolder, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contentsFolder, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(contentsFolder, "MacOS", "Electron"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(contentsFolder, "MacOS", "Electron"), 0o755);
  fs.writeFileSync(path.join(contentsFolder, "Resources", "electron.icns"), "not really an icon");
  fs.writeFileSync(path.join(contentsFolder, "Resources", "default_app.asar"), "not really an archive");
  fs.writeFileSync(
    path.join(contentsFolder, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Electron</string>
  <key>CFBundleDisplayName</key><string>Electron</string>
  <key>CFBundleIdentifier</key><string>com.github.Electron</string>
  <key>CFBundleExecutable</key><string>Electron</string>
  <key>CFBundleIconFile</key><string>electron.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>44.3.0</string>
  <key>CFBundleVersion</key><string>44.3.0</string>
  <key>NSMainNibFile</key><string>MainMenu</string>
  <key>NSPrincipalClass</key><string>AtomApplication</string>
</dict></plist>
`
  );
  return bundlePath;
}

function buildInto(folder, iconSourcePath) {
  const bundlePath = path.join(folder, "Clauding.app");
  const written = buildApplicationBundle({
    bundlePath,
    projectRoot,
    electronBundlePath: fakeElectronBundle(folder),
    iconSourcePath,
    signIdentity: null
  });
  return { bundlePath, written };
}

function readPropertyList(bundlePath) {
  const informationPath = path.join(bundlePath, "Contents", "Info.plist");
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", informationPath], { encoding: "utf8" }));
}

test("the bundle is Electron's own, renamed to Clauding", () => {
  const folder = scratchFolder();
  const { bundlePath } = buildInto(folder, null);
  const properties = readPropertyList(bundlePath);

  assert.equal(properties.CFBundleName, APPLICATION_NAME, "the leftmost menu-bar title comes from this");
  assert.equal(properties.CFBundleDisplayName, APPLICATION_NAME);
  assert.equal(properties.CFBundleIdentifier, BUNDLE_IDENTIFIER);
  assert.equal(properties.CFBundleExecutable, APPLICATION_NAME);
  assert.equal(properties.LSApplicationCategoryType, "public.app-category.developer-tools");
  // Everything Electron's own property list said that we did not rewrite is
  // still there: the bundle is a copy, not a hand-written stub.
  assert.equal(properties.NSPrincipalClass, "AtomApplication");
  assert.equal(properties.NSMainNibFile, "MainMenu");
});

test("the executable is renamed too, and stays runnable", () => {
  const folder = scratchFolder();
  const { bundlePath, written } = buildInto(folder, null);
  const executablePath = path.join(bundlePath, "Contents", "MacOS", "Clauding");

  assert.equal(written.executablePath, executablePath);
  assert.equal(fs.existsSync(executablePath), true);
  assert.equal(fs.existsSync(path.join(bundlePath, "Contents", "MacOS", "Electron")), false);
  assert.equal(fs.statSync(executablePath).mode & 0o777, 0o755);
});

test("the property list carries the version from package.json", () => {
  const folder = scratchFolder();
  const { bundlePath, written } = buildInto(folder, null);
  const version = packageVersion(projectRoot);
  const properties = readPropertyList(bundlePath);

  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.equal(written.version, version);
  assert.equal(properties.CFBundleShortVersionString, version);
  assert.equal(properties.CFBundleVersion, version);
});

test("a checkout with no package.json still gets a version", () => {
  assert.equal(packageVersion(scratchFolder()), "0.0.0");
});

test("our icon replaces Electron's", () => {
  const folder = scratchFolder();
  const iconSourcePath = path.join(projectRoot, "build", "icon", "Clauding.icns");
  const { bundlePath, written } = buildInto(folder, iconSourcePath);

  assert.equal(written.hasIcon, true, "this checkout has build/icon/Clauding.icns");
  assert.equal(readPropertyList(bundlePath).CFBundleIconFile, "Clauding.icns");
  assert.equal(fs.existsSync(path.join(bundlePath, "Contents", "Resources", "Clauding.icns")), true);
  assert.equal(fs.existsSync(path.join(bundlePath, "Contents", "Resources", "electron.icns")), false);
});

test("a missing icon is reported and does not stop the bundle", () => {
  const folder = scratchFolder();
  const reported = [];
  const bundlePath = path.join(folder, "Clauding.app");
  const written = buildApplicationBundle({
    bundlePath,
    projectRoot,
    electronBundlePath: fakeElectronBundle(folder),
    iconSourcePath: path.join(folder, "no-icon-here.icns"),
    signIdentity: null,
    report(line) {
      reported.push(line);
    }
  });

  assert.equal(written.hasIcon, false);
  assert.equal(fs.existsSync(written.executablePath), true);
  assert.equal(reported.length, 1);
  assert.match(reported[0], /icon/i);
});

test("the app inside the bundle is two lines pointing at this checkout", () => {
  const folder = scratchFolder();
  const { written } = buildInto(folder, null);
  const entry = fs.readFileSync(written.entryPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(written.manifestPath, "utf8"));

  assert.ok(entry.includes(`import "file://${projectRoot}/electron/main.js"`), "the real main process, by absolute path");
  assert.ok(!entry.includes("import("), "a static import, so Electron is ready only after main.js has run");
  assert.equal(manifest.main, "main.js");
  assert.equal(manifest.type, "module", "electron/main.js is an ES module");
  // No copy of the app: the bundle brings Electron and nothing else of ours.
  assert.equal(fs.readdirSync(path.dirname(written.entryPath)).sort().join(","), "main.js,package.json");
});

test("a checkout path with a space in it survives into the entry", () => {
  const entry = bundleEntryScript("/Users/someone/some where/clauding");
  assert.ok(entry.includes("/Users/someone/some%20where/clauding/electron/main.js"), "it is a file URL");
  assert.equal(fs.existsSync(path.join(projectRoot, "package.json")), true, "the resolved root is the checkout");
});

test("installing again replaces what was there before", () => {
  const folder = scratchFolder();
  const { bundlePath } = buildInto(folder, null);
  const leftover = path.join(bundlePath, "Contents", "MacOS", "left-over-file");
  fs.writeFileSync(leftover, "from an older install");
  buildInto(folder, null);

  assert.equal(fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(path.join(bundlePath, "Contents", "MacOS", "Clauding")), true);
});

test("writing a bundle touches nothing outside the folder it was given", () => {
  const folder = scratchFolder();
  buildInto(folder, null);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["Clauding.app", "Electron.app"]);
});

test("uninstalling only ever removes a bundle install-app wrote", () => {
  const folder = scratchFolder();
  const { bundlePath } = buildInto(folder, null);
  assert.equal(isClaudingBundle(bundlePath), true);

  const strangerPath = path.join(folder, "Someone-elses-Clauding.app");
  fs.mkdirSync(path.join(strangerPath, "Contents", "Resources", "app"), { recursive: true });
  fs.writeFileSync(path.join(strangerPath, "Contents", "Resources", "app", "main.js"), "console.log('mine');\n");
  assert.equal(isClaudingBundle(strangerPath), false);
  assert.equal(isClaudingBundle(path.join(folder, "not-there.app")), false);
});

test("the same version gives the same property list edits and manifest", () => {
  assert.deepEqual(informationPropertyEdits("1.2.3"), informationPropertyEdits("1.2.3"));
  assert.ok(informationPropertyEdits("1.2.3").some(([key, value]) => key === "CFBundleVersion" && value === "1.2.3"));
  assert.equal(bundlePackageManifest("1.2.3"), bundlePackageManifest("1.2.3"));
  assert.ok(bundlePackageManifest("1.2.3").includes('"version": "1.2.3"'));
});
