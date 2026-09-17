# CL-01 · List · sessions and status
Priority: P1 · Verified by: dry test `test/sessions.test.js`, `test/liveStatus.test.js` + manual

## Goal
Every Claude Code session on this Mac has a row in the left column, the row's
color says what the CLI itself says the session is doing, the "needs answer"
badge appears only for a session whose job is stuck, and throw-away sessions
are not in the list at all.

## Preconditions
- Clauding is running with the session list on screen.
- At least one session is busy right now, one has been used recently and is
  idle, and one has not run for days.
- At least one background job exists that is waiting for a permission answer.
- At least one conversation exists in a scratch folder: a job's own scratch
  folder under `~/.claude/jobs/<id>/`, or the smoke folder
  `$TMPDIR/clauding-smoke`.
- The app writes nothing under `~/.claude`; both registries there are only read.

## Steps
1. Open Clauding and look at the left column without clicking anything.
2. Find the session that is busy right now — its row carries the working
   color and, if the group it sits in is folded shut, the group header does.
3. Find the session whose job is waiting for a permission answer — its row
   carries the waiting color and the badge (currently e.g. "needs answer").
4. Find a session that has not run for days — no badge, the quiet color.
5. Let the busy session finish and watch the same row without touching it: it
   changes to the waiting or quiet color on its own within a few seconds.
6. Search the list for the scratch conversation from the preconditions, by its
   folder name and by its first words.
7. Compare the whole list, side by side, with what the CLI's own agents view
   shows for the same moment (screenshot both).

## Expected state
- One row per session the SDK lists, newest first, with the project label
  ("…/projects/x" or "~/Desktop/notes") and the relative time.
- The color of a row is the meaning the registry gives, not a guess: running
  (a live CLI process reporting busy, or a job working), waiting for you (a
  live process that is idle, or a job that is idle or blocked), quiet
  otherwise.
- The badge is on the row of the blocked job only. A CLI sitting idle at its
  prompt has no badge: it is not waiting for an answer, it is simply idle.
- A session that stops running loses its color without a click and without a
  reload.
- The scratch conversation has no row and cannot be found by searching.

## Evidence
- `test/liveStatus.test.js`
  - "a live CLI process is working when busy and waiting otherwise" and "a job
    is working, waiting or finished, by its state" — the whole mapping in the
    table above, including the values the CLI has not used yet.
  - "registry files whose process is gone are ignored" — a stale registry file
    (they do linger) never colors a row; the pid check is handed in, so no
    process is signalled.
  - "a live process wins over the job state for the same session" — a job that
    says "done" while its process still sits idle shows as waiting for you.
  - "a job is matched to both its session ids" — a job resumed into a new
    transcript colors both rows.
  - "the needs-answer badge is only for a job that says it is stuck" — the
    badge rule, including the idle CLI that must not get one.
  - "a session running in one of the app's own terminals is marked as ours" —
    the row knows the app is driving it (CL-02 and CL-07 build on this).
- `test/sessions.test.js`
  - "a background job's scratch folder is never listed", "the app's own smoke
    folder is never listed either", "the same folder with and without the
    /private prefix is the same folder" — the scratch rule, both folders and
    the macOS symlink spelling of the temporary folder.
  - "the title falls back from the user's own name to the session id" — what
    the row is called when there is no title and no summary.
  - "a project folder is shortened to its last two parts", "a worktree is
    labelled by the repository it belongs to", "a folder inside the home
    folder is written with a tilde" — the project label of a row.
- Manual, with screenshots: the list next to the CLI's own agents view (step
  7), the color changing on its own (step 5), the badge on the blocked job
  (step 3).

## Out of scope
- Whether the three colors are exactly the ones the CLI's agents view uses —
  undecided; this specification only requires that the meaning matches. When
  the decision is made it belongs here.
- Deleting hidden test sessions — undecided, not specified anywhere yet.
- A session running in Terminal.app and what a click does with it: CL-02.
- Search: CL-03. Groups, hiding and folding: CL-04, CL-05, CL-06.

## What the dry tests do not prove
- That the list actually redraws when a registry file changes (the watcher and
  the 15 s heartbeat): manual, step 5.
- That the SDK returns every session on this Mac: assumed, out of scope.
- The colors themselves: manual, from the screenshot.
