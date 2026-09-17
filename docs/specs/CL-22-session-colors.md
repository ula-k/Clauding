# CL-22 · List · session colors
Priority: P2 · Verified by: dry test `test/selectionPlan.test.js`, `test/sessionGroups.test.js` + manual

## Goal
A session's **name** can be written in a color of the user's choosing, so
the few rows that matter stand out in a list of forty; the color is only
ever one she picked, it is kept for good, and what the session is *doing*
stays a separate signal.

## Preconditions
- A handful of sessions in the list, at least one busy and one quiet.
- Clauding is running.

## Steps
1. Read the list: the color of the names.
2. Open a row's `…` menu (or right-click it) and pick **Color ▸** and one
   of the swatches.
3. Open the same menu again and pick **Color ▸ None**.
4. Quit and start the app again.

## Expected state
- A session nobody has colored has **no color**: its name is written in the
  ordinary text color, faded while it is quiet. There is no automatic
  color — a colored name means somebody chose it.
- After step 2 that name wears the chosen color and nothing else about the
  row has changed — its group, its status and its position are untouched.
- After step 3 the stored color is gone and the name is back to the
  ordinary text color; "None" is ticked in the menu again.
- Nothing else in the window is tinted: no bar, no chip, no colored
  background. The row's selection background is the same lavender it always
  was, and the colored name stays readable on it.
- The activity is still the dot before the name: working (a light dot that
  breathes), waiting for an answer (a gold dot, with the **needs answer**
  badge when CL-23 says so), and quiet.
- After a restart the chosen color is back, and the rows nobody colored are
  still plain.

## Evidence
- `test/selectionPlan.test.js`
  - "only a color picked by hand gives a session a color" — anything else
    is no color at all.
  - "a stored color that is not in the palette is no color at all".
  - "a session with no id has no color".
  - "the palette the renderer draws is the palette the store accepts".
- `test/sessionGroups.test.js`
  - "a session color is stored, changed and taken away again" — "None" is
    the absence of an entry.
  - "only a palette token may be a session color".
  - "a colors map full of rubbish is dropped when the file is read".
  - "a deleted session takes its color with it".
  - "colors survive a round trip through the file".
- Manual, with a screenshot: the list with names in several colors, a
  working row and a waiting row (`session-colors-c.png`).

## Out of scope
- Picking a color for several sessions at once: CL-21.
- Agents: they have no color at all any more (CL-15).

## What the dry tests do not prove
- That the colored names are readable on the dark background and on the
  selection: manual, with a screenshot.
