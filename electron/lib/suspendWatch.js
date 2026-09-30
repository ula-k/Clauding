// A `claude` that was suspended (Ctrl+Z) and how it is brought back.
//
// Why this exists: Claude Code binds Ctrl+Z to "suspend" — it prints
// "Claude Code has been suspended. Run `fg` to bring Claude Code back." and
// stops itself. In a shell that is fine, `fg` continues it. In Clauding there
// is no shell between the pty and `claude`, so there is nobody to type `fg`
// to: the pane froze until the whole app was restarted.
//
// What really happens (checked with CLI 2.1.x under node-pty): the process
// never gets to state T at all. The pty's child leads a session of its own
// whose process group has no parent in it — an orphaned group — and the
// kernel throws SIGTSTP away for those. The CLI has already printed its
// message and let go of the screen, though, and sits waiting for the SIGCONT
// that `fg` would have sent. So "suspended" is recognised two ways: the
// CLI's own sentence in the output, and `ps` saying T (a real stop, e.g.
// `kill -STOP` from outside). A SIGCONT brings it back from either.
//
// The renderer no longer sends Ctrl+Z at all (src/renderer/terminalKeys.js
// turns it into the CLI's own undo, Ctrl+_). This is the second belt: once a
// second the main process looks at every live terminal, and one that is
// suspended gets SIGCONT — plus one dim line in its pane saying what
// happened. Windows has neither Ctrl+Z suspend nor signals, so none of this
// runs there.
//
// Pure on purpose: electron/terminals.js runs `ps` and sends the signal; the
// dry test (test/suspendWatch.test.js) checks the parsing and the decision.

// `ps -o pid=,stat= -p 101,202`, the one command for all live terminals: no
// header line, one "<pid> <state>" line per process that still exists.
export function processStateCommand(processIds) {
  const wanted = (processIds || []).map(Number).filter((processId) => Number.isInteger(processId) && processId > 0);
  if (wanted.length === 0) {
    return null;
  }
  return { file: "ps", commandArguments: ["-o", "pid=,stat=", "-p", wanted.join(",")] };
}

// pid -> state letters ("S+", "Ss", "T", "T+" …). A pid `ps` did not list is
// simply absent: the process is gone, and the exit handler deals with that.
export function parseProcessStates(psOutput) {
  const states = new Map();
  for (const line of String(psOutput || "").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)/);
    if (match) {
      states.set(Number(match[1]), match[2]);
    }
  }
  return states;
}

// "T" is stopped by a signal — what Ctrl+Z (SIGTSTP) or SIGSTOP leave
// behind. Lowercase "t" is Linux's "stopped by a debugger", which is somebody
// tracing the process on purpose and is left alone.
export function isStoppedState(processState) {
  return typeof processState === "string" && processState.startsWith("T");
}

// The CLI's own sentence, "Claude Code has been suspended. Run `fg` to bring
// Claude Code back." — matched on the text with escape sequences taken out,
// and on the end of the previous chunk too (`carriedText`), because the pty
// may hand it over in two pieces.
export const SUSPEND_MESSAGE_PATTERN = /Claude Code has been suspended\.\s*Run\s*`?fg`?\s*to bring Claude Code back/;
const CARRIED_CHARACTERS = 200;

function plainText(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\s+/g, " ");
}

// Looks at one chunk of output. Returns whether the CLI just said it is
// suspended, and what to carry over to the next chunk (nothing once it has
// matched, so one sentence counts once).
export function scanForSuspendMessage(carriedText, chunk) {
  const combined = `${carriedText || ""}${plainText(chunk)}`;
  if (SUSPEND_MESSAGE_PATTERN.test(combined)) {
    return { suspended: true, carriedText: "" };
  }
  return { suspended: false, carriedText: combined.slice(-CARRIED_CHARACTERS) };
}

// Before the SIGCONT, the CLI gets this long after its sentence to finish
// letting go of the screen; a SIGCONT that lands before its own stop request
// would be followed by that stop, and nothing would continue it.
export const MESSAGE_SETTLE_MILLISECONDS = 300;

// What to do with one terminal after a look. `wasStopped` is what the
// previous look said, so the note in the pane is written once per
// suspension, while SIGCONT is sent on every look that still finds it
// stopped (a process can be stopped again while the first one lands).
//
// `messageSeenAt` is when the CLI's sentence was last seen (0 for never),
// `now` the time of this look.
export function suspendDecision({ processState, wasStopped = false, messageSeenAt = 0, now = Date.now() }) {
  const messageSettled = messageSeenAt > 0 && now - messageSeenAt >= MESSAGE_SETTLE_MILLISECONDS;
  const stopped = isStoppedState(processState) || messageSettled;
  return {
    stopped,
    resume: stopped,
    announce: stopped && !wasStopped
  };
}

// The dim line under whatever the CLI printed, like the exit notice
// (lib/exitPlan.js): 2;37m is "dim, white", 0m back to normal.
export function suspendNoticeText() {
  const dim = "\x1b[2;37m";
  const plain = "\x1b[0m";
  return `\r\n${dim}Claude was suspended (Ctrl+Z) — resumed automatically.${plain}\r\n`;
}
