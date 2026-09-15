# CL-11 · Panel · the `clauding` command
Priority: P1 · Verified by: dry test `test/commandProtocol.test.js` + manual (smoke hook `CLAUDING_SMOKE_PREAMBLE`, step 4)

## Goal
`clauding open`, `clauding panel show|hide` and `clauding tabs` work from a
terminal of the app; when the caller has no terminal id of its own the tab
still lands somewhere sensible — the session on screen, then the most recently
used terminal, then a readable error — and the answer always says where it
went. Success exits 0, failure exits 1.

## Preconditions
- Clauding is running with at least one terminal open.
- An HTML file and a Markdown file in a scratch folder.

## Steps
1. In a terminal of the app, run `clauding open` on the HTML file with an
   absolute path, then with a path relative to that terminal's folder.
2. Run `clauding panel hide`, then `clauding panel show`.
3. Run `clauding tabs`.
4. From a plain shell outside the app (no `CLAUDING_TERMINAL_ID`), with a
   session selected in the window, run `clauding open` on the Markdown file.
5. Do the same with nothing selected but a terminal used recently.
6. Do the same with the app not running at all.
7. Run `clauding open` on a file that does not exist, and on a `.csv`.
8. Check the exit code after a success and after a failure.

## Expected state
- The tab lands in the panel of the session the command came from; a relative
  path is resolved against the folder the command was run in, not the app's.
- `panel show|hide` moves that session's panel only (CL-10), and the window
  acts on it only when that session is the one on screen.
- `tabs` lists this session's tabs and marks the active one.
- Without a terminal id the command still works and the answer names the
  fallback it used (currently e.g. "… (current session)." or "… (most recent
  terminal)."), so a session reading its own output cannot claim the page is
  where it is not.
- With nothing to fall back on, and for a file that cannot be opened, the
  command fails with a readable reason (currently e.g. "clauding: could not
  open — …") and never prints a success line.
- Exit code 0 on success, 1 on any failure.

## Evidence
- `test/commandProtocol.test.js`, against a fake terminal registry and the
  real panel store:
  - "open lands in the caller's own terminal and says so without a fallback" —
    the exact shape of the success line, with no fallback named.
  - "a relative path is resolved against the folder the command was run in"
    and "with no folder of its own the caller's terminal folder is used".
  - "without a terminal id the page goes to the session on screen, and the
    line says so", "a stale terminal id falls back the same way as none at
    all", "a session on screen with no terminal of its own still takes the
    page", "with nothing on screen the most recently used terminal takes it" —
    the whole fallback order, each naming itself in the answer.
  - "with no terminal at all the command fails with a readable reason".
  - "a file that cannot be opened fails instead of pretending" — a missing
    file and an unsupported kind both raise, so the caller gets a failure line.
  - "panel show and hide write the flag for that session and tell the window",
    "panel show through a fallback names the fallback in its answer".
  - "tabs lists this session's tabs, marking the active one" and "tabs through
    a fallback says whose tabs these are".
  - "an unknown command and a panel without show or hide are refused".
  - "a terminal whose CLI has not registered a session yet keeps its tabs
    under its own key" (CL-10).
  - "a web address opens as a tab of its own".
- Manual, with screenshots: each command run in a real terminal of the app,
  the app-is-not-running message (step 6), and the exit codes (step 8). The
  smoke hook `CLAUDING_SMOKE_PREAMBLE` runs `bin/clauding` from a plain
  environment while a resumed session is on screen.

## Out of scope
- What the panel does with a tab: CL-10.
- The socket's own framing (one JSON object per line, the 0600 socket file):
  assumed; it is exercised by every manual step.

## What the dry tests do not prove
- `bin/clauding` itself: the socket connection, the "the app is not running"
  message and the exit codes are in that script, and no dry test runs it
  (that would need a live app): manual, steps 6 and 8.
- That the window reacts to `panel show|hide` when that session is on screen:
  manual.
