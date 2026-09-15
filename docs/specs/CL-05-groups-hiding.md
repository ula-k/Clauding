# CL-05 · Groups · hiding
Priority: P1 · Verified by: dry test `test/sessionGroups.test.js`, `test/sessionGrouping.test.js` + manual (smoke hook `CLAUDING_SMOKE_GROUPS`)

## Goal
Hiding a session takes it off the list without losing it: the "Hidden (N)"
line grows by one, unhiding puts the row back in the group it came from, and a
hidden session that starts working again comes back on its own.

## Preconditions
- Clauding is running; at least one session sits in a group that is not
  Default.
- One hidden session can be made busy again from outside the app (resumed in
  Terminal.app, or by a background job).

## Steps
1. Hide a session from its row menu.
2. Read the line at the bottom of the list (currently e.g. "Hidden (3)").
3. Open that line and unhide the session.
4. Check which group it is back in.
5. Hide it again, and make that same session busy from outside the app.
6. Watch the list without clicking anything.

## Expected state
- A hidden row leaves its group at once and the hidden count grows by one.
- Hiding changes nothing else: the session keeps its group, its agent and its
  panel.
- Unhiding puts the row back exactly where it was, not into Default.
- A hidden session that the registry shows as running again is unhidden by the
  app itself, back into its own group, with no click — hiding is for a list
  that got too long, not a way to lose live work.

## Evidence
- `test/sessionGroups.test.js`
  - "hiding keeps the session's group, so unhiding puts it back where it was".
  - "a hidden session that is running again is unhidden on its own" — only the
    sessions that are running are unhidden, the others stay hidden, and the
    store says whether anything changed (so the list is only redrawn when it
    did).
  - "everything survives a round trip through the file" — the hidden list is
    stored and read back.
- `test/sessionGrouping.test.js`
  - "hidden sessions leave the buckets and are listed apart" — the rows behind
    the "Hidden (N)" line, sorted the same way as the list itself, and not
    counted as visible.
  - "a hidden session stays hidden while searching" (CL-03).
- Manual, with screenshots: the count before and after (steps 1–2), the row
  back in its own group (step 4), and the row reappearing by itself (step 6).
  The smoke hook `CLAUDING_SMOKE_GROUPS` hides two sessions through the real
  store and unhides them again at the end.

## Out of scope
- Deleting a hidden session: undecided, not specified.
- Which sessions count as running: CL-01.

## What the dry tests do not prove
- That the unhiding actually happens while the app runs (it is driven by the
  registry watcher, not by the store): manual, step 6.
- The "Hidden (N)" line itself: manual.
