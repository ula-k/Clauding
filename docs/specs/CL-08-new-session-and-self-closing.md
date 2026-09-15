# CL-08 · Terminal · "+ New" and self-closing
Priority: P2 · Verified by: dry test `test/sessions.test.js` + manual

## Goal
"+ New" offers the folders actually worked in lately, refuses a folder that is
not there instead of opening a dead terminal, and puts the new session in
Default; and a terminal that a click opened and nobody touched hangs up by
itself, while one that was typed into or started from "+ New" never does.

## Preconditions
- The CLI has been used in several folders (they are in `~/.claude.json`).
- One of those folders has since been renamed or deleted.

## Steps
1. Press "+ New" and read the list of folders offered, with "Other…" at the
   end.
2. Pick "Other…" and choose a folder from the dialog.
3. Start the session and check which group it lands in.
4. Press "+ New" again and try a folder that no longer exists.
5. Open a terminal by clicking a row, type nothing, and leave it for over
   twenty minutes.
6. Do the same with a terminal started from "+ New", and with one that was
   typed into.

## Expected state
- The list holds the folders the CLI was started in, most recent first, each
  shown as a short, readable label ("…/projects/x", "~/Desktop/notes"); a
  folder that no longer exists is not offered.
- A folder that is not there gives a warning and no terminal is opened.
- A session started here lands in Default, like any session with no group of
  its own.
- Only the untouched, clicked terminal closes itself after twenty minutes of
  its CLI being idle; the other two stay open for as long as the app does.

## Evidence
- `test/sessions.test.js`
  - "a project folder is shortened to its last two parts", "a folder inside
    the home folder is written with a tilde", "a worktree is labelled by the
    repository it belongs to" — the labels the sheet prints for each folder.
  - "the project colour is stable for a folder and inside the palette" — the
    dot next to each folder.
- `test/sessionGroups.test.js`, "a session with no membership lands in
  Default" (in `test/sessionGrouping.test.js`) — step 3.
- Manual, with screenshots: the sheet with its folders (step 1), the warning
  (step 4), and the three terminals after twenty minutes (steps 5–6).

## Out of scope
- What a click does: CL-07. Agents in the sheet: CL-15.

## What the dry tests do not prove
- The sheet itself, the folder dialog, the warning: manual.
- Which folders `~/.claude.json` holds, and that unreadable ones are skipped:
  manual (it depends on this Mac).
- The twenty-minute rule: manual, and best with a shortened timer.
