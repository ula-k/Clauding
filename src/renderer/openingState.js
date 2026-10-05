// How long the middle column waits for a terminal before it says so.
//
// It used to wait for ever: a click on a session whose folder was unknown
// started nothing, and the column sat on "Opening a terminal…" with no way
// out. Now the wait has an end, and what ends it is decided here — pure, so
// test/sessionFolder.test.js checks it.
//
// The "opening" state of the middle column, after a click asked for a
// terminal. `startedAt` is when it was asked; `firstOutputAt` when the pty
// first said anything (null until then); `error` what the spawn threw.
//   "opening"  still within the wait, nothing wrong yet
//   "failed"   the spawn (or the registry) refused with an error
//   "silent"   OPENING_TIMEOUT_MILLISECONDS went by with no output at all
//   "ready"    output arrived, or the terminal ended (its pane says why)
export const OPENING_TIMEOUT_MILLISECONDS = 15000;

export function openingState({ startedAt = 0, now = Date.now(), firstOutputAt = null, exited = false, error = null, timeoutMilliseconds = OPENING_TIMEOUT_MILLISECONDS } = {}) {
  if (error) {
    return "failed";
  }
  if (firstOutputAt || exited) {
    return "ready";
  }
  if (startedAt && now - startedAt >= timeoutMilliseconds) {
    return "silent";
  }
  return "opening";
}
