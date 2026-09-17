// Proves node-pty really works on this machine: the module loads, a pty is
// opened, a command runs inside it and its output comes back.
//
// It is the one part of the Windows port that cannot be reasoned about from
// a Mac — ConPTY either attaches or it does not — so CI runs this on
// windows-latest (and on macos-latest, where it has always worked) as a
// plain Node script, with no Electron and no window.
//
//   node scripts/checkNodePty.js
//
// Exits 0 after printing "node-pty ok: <what the pty echoed>", or 1 with the
// reason.
import nodePty from "node-pty";

const onWindows = process.platform === "win32";
const command = onWindows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
const commandArguments = onWindows ? ["/c", "echo ok"] : ["-c", "echo ok"];
const TIMEOUT_MILLISECONDS = 20000;

function fail(reason) {
  console.error(`node-pty check failed: ${reason}`);
  process.exit(1);
}

let child = null;
try {
  child = nodePty.spawn(command, commandArguments, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
    ...(onWindows ? { useConpty: true } : {})
  });
} catch (error) {
  fail(`the pty could not be opened (${error && error.message ? error.message : error})`);
}

let seen = "";
const giveUp = setTimeout(() => {
  fail(`nothing came back within ${TIMEOUT_MILLISECONDS} ms (saw ${JSON.stringify(seen)})`);
}, TIMEOUT_MILLISECONDS);

child.onData((data) => {
  seen += data;
});

child.onExit(({ exitCode }) => {
  clearTimeout(giveUp);
  const plain = seen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\s+/g, " ").trim();
  if (!plain.includes("ok")) {
    fail(`the pty printed ${JSON.stringify(plain)} instead of "ok" (exit ${exitCode})`);
  }
  console.log(`node-pty ok: ${plain} (exit ${exitCode}, ${onWindows ? "ConPTY" : "posix pty"})`);
  process.exit(0);
});
