# CL-21 · List · selecting several sessions
Priority: P2 · Verified by: dry test `test/selectionPlan.test.js` + manual

## Goal
Several rows can be picked out of the list and dealt with in one go — hidden,
deleted, given an agent, a group or a colour — and picking them out never
starts a `claude` process.

## Preconditions
- At least five sessions in the list, one of them running in a terminal
  **outside** the app.
- Clauding is running.

## Steps
1. ⌘-click three rows, in different groups if there are any.
2. Read the search box and the rows.
3. Open the `…` of one of the picked rows (or right-click it).
4. Shift-click a row a few lines below the last one clicked.
5. Press ⌘A with the list focused, then Escape.
6. Pick out a few rows including the one running outside the app and choose
   **Delete N sessions…**; read the question and cancel it.
7. Pick out two rows and press ⌘⌫.

## Expected state
- After step 1 the three rows are tinted and **no terminal was opened**: the
  middle column still shows whatever it showed before.
- The count is shown without a new button — currently in the search box, as
  its placeholder ("3 selected").
- The menu in step 3 is about the selection: hide them all, delete them
  all, assign them to an agent, move them to a group, give them all one
  colour. Nothing in it is about the one row under the pointer.
- Step 4 extends the selection to the whole range between the last row
  clicked and this one, in the order the rows are drawn; a second
  Shift-click moves that block rather than leaving rows behind.
- ⌘A picks out every row on screen (never a row inside a folded group, which
  is not drawn); Escape puts the selection away.
- The question in step 6 names how many sessions will go and the first few
  of them, and says which sessions are being **left alone** because they are
  running in a terminal outside the app. Cancel deletes nothing at all.
- Step 7 hides both rows (the same Hide as on one row: each session's
  terminal is hung up first). On a selection whose rows are all already
  under **Hidden (N)**, ⌘⌫ asks the delete question instead.

## Evidence
- `test/selectionPlan.test.js`
  - "a plain click is one row, and it is the click that opens a terminal".
  - "a modifier click never opens a terminal".
  - "⌘-click adds a row and takes it out again".
  - "Shift-click takes the range from the anchor, in the order on screen",
    "a range upwards is the same range", "a second Shift-click replaces the
    range instead of leaving rows behind", "Shift-click with no anchor yet
    is simply that one row".
  - "⌘A picks out every row on screen and Escape clears everything".
  - "hiding works on everything, including a session running elsewhere" and
    "deleting leaves a session running outside the app alone, and names it".
  - "the confirmation names the first five and counts the rest".
- Manual, with a screenshot: three rows picked out with the bulk menu open
  (`multi-select-menu.png`).

## Out of scope
- What a single row's menu does: CL-04, CL-05.
- The colours of the names themselves: CL-22.

## What the dry tests do not prove
- That ⌘-click, Shift-click, ⌘A and ⌘⌫ reach the list at all (the terminal
  has the keyboard most of the time), and that a bulk hide or delete really
  goes through every session: manual.
