// `postinstall`: makes sure node-pty works inside Electron.
//
// node-pty 1.1 ships prebuilt N-API binaries (prebuilds/<platform>-<arch>/),
// so no compile step is needed for Electron — but the npm tarball stores its
// `spawn-helper` without the execute bit, and npm 11 no longer runs the
// package's own install scripts, so every spawn fails with "posix_spawnp
// failed" until the bit is set. This script sets it and then loads the
// module inside Electron (run as plain Node) to prove the binary matches.
// If that load fails, it falls back to `electron-rebuild` for node-pty.
//
// On Windows there is no spawn-helper and no execute bit: node-pty drives
// ConPTY through conpty.node / conpty_console_list.node in the same
// prebuilds folder. So the chmod step is skipped there and only the load
// check runs — which is the part that actually matters, and the part CI
// repeats with a real `cmd.exe /c echo ok` through a pty.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// fileURLToPath, not `new URL(...).pathname`: a checkout under a path with
// a space or a non-ASCII character comes back percent-encoded from the URL
// and `npm install` then fails on a folder that does not exist.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodePtyRoot = path.join(projectRoot, "node_modules", "node-pty");
const prebuildFolder = path.join(nodePtyRoot, "prebuilds", `${process.platform}-${process.arch}`);
const releaseFolder = path.join(nodePtyRoot, "build", "Release");

const onWindows = process.platform === "win32";

function makeExecutable(filePath) {
  if (onWindows) {
    return;
  }
  if (fs.existsSync(filePath)) {
    fs.chmodSync(filePath, 0o755);
    console.log(`node-pty: execute bit set on ${path.relative(projectRoot, filePath)}`);
  }
}

function loadsInsideElectron() {
  let electronBinary;
  try {
    electronBinary = require("electron");
  } catch (error) {
    console.log("node-pty: Electron is not installed, skipping the load check.");
    return true;
  }
  const check = "require('node-pty'); process.stdout.write('node-pty loads in Electron ' + process.versions.electron)";
  const result = spawnSync(electronBinary, ["-e", check], {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8"
  });
  if (result.status === 0) {
    console.log(`node-pty: ${result.stdout.trim()}`);
    return true;
  }
  console.log(`node-pty: load check failed:\n${result.stderr || result.stdout}`);
  return false;
}

if (!fs.existsSync(nodePtyRoot)) {
  console.log("node-pty: not installed, nothing to prepare.");
  process.exit(0);
}

if (onWindows) {
  console.log("node-pty: Windows uses ConPTY, there is no spawn-helper to make executable.");
} else {
  makeExecutable(path.join(prebuildFolder, "spawn-helper"));
  makeExecutable(path.join(releaseFolder, "spawn-helper"));
}

if (!loadsInsideElectron()) {
  console.log("node-pty: rebuilding against Electron with electron-rebuild…");
  // The npm bin shim is `electron-rebuild.cmd` on Windows, a batch file that
  // execFile cannot start on its own — hence the shell there.
  const rebuildCommand = path.join(projectRoot, "node_modules", ".bin", onWindows ? "electron-rebuild.cmd" : "electron-rebuild");
  execFileSync(rebuildCommand, ["--force", "--only", "node-pty"], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: onWindows
  });
  makeExecutable(path.join(releaseFolder, "spawn-helper"));
  if (!loadsInsideElectron()) {
    console.log("node-pty: still does not load inside Electron.");
    process.exit(1);
  }
}
