# CL-22 · List · session colours
Priority: P2 · Verified by: dry test `test/selectionPlan.test.js`, `test/sessionGroups.test.js` + manual

## Goal
Every session's **name** is written in a colour of its own, so a list of
forty rows can be read by colour; the colour is there without anybody
picking one, a chosen one is kept for good, and what the session is *doing*
stays a separate signal.

## Preconditions
- A handful of sessions in the list, at least one busy and one quiet.
- Clauding is running.

## Steps
1. Read the list: the colour of the names.
2. Open a row's `…` menu (or right-click it) and pick **Colour ▸** and one
   of the swatches.
3. Open the same menu again and pick **Colour ▸ Automatic**.
4. Quit and start the app again.

## Expected state
- Every name is drawn in its session's colour, and neighbouring rows are
  rarely the same colour: a session with no stored choice still has one,
  worked out from its id. A quiet session's name is the same colour, faded.
- After step 2 that name wears the chosen colour and nothing else about the
  row has changed — its group, its status and its position are untouched.
- After step 3 the name is back to the colour it had at step 1.
- Nothing else in the window is tinted: no bar, no chip, no coloured
  background. The row's selection background is the same lavender it always
  was, and the coloured name stays readable on it.
- The activity is still the dot before the name: working (a light dot that
  breathes), waiting for an answer (a gold dot, with the **needs answer**
  badge when CL-23 says so), and quiet.
- After a restart the chosen colour is back, and so is every automatic one.

## Evidence
- `test/selectionPlan.test.js`
  - "the automatic colour of a session never changes" — the same id gives
    the same token, every time.
  - "the automatic colours spread over the whole palette".
  - "a colour picked by hand wins over the automatic one".
  - "a stored colour that is not in the palette falls back to the automatic
    one".
  - "the palette the renderer draws is the palette the store accepts".
- `test/sessionGroups.test.js`
  - "a session colour is stored, changed and taken away again" — including
    "Automatic" as the absence of an entry.
  - "only a palette token may be a session colour".
  - "a colours map full of rubbish is dropped when the file is read".
  - "a deleted session takes its colour with it".
  - "colours survive a round trip through the file".
- Manual, with a screenshot: the list with names in several colours, a
  working row and a waiting row (`session-colours-c.png`).

## Out of scope
- Picking a colour for several sessions at once: CL-21.
- Agents: they have no colour at all any more (CL-15).

## What the dry tests do not prove
- That the coloured names are readable on the dark background and on the
  selection: manual, with a screenshot.
