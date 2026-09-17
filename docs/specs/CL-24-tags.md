# CL-24 · List · tags
Priority: P2 · Verified by: dry test `test/tags.test.js` + manual

## Goal
A row can carry a few words of the user's own — "Finish today", "Waiting",
"Read later" — as small colored pills after the name, put on and taken off
from the row's `…` menu or from the bulk menu, with no new button anywhere
in the window. NEEDS ANSWER stays what it always was: a system tag the app
decides, always drawn first, which nobody can rename or remove.

## Preconditions
- A handful of sessions in the list, at least one of them carrying
  NEEDS ANSWER (CL-23).
- Clauding is running; groups.json may or may not have a tag catalogue yet.

## Steps
1. Start the app with no tag catalogue in groups.json at all and open a
   row's `…` menu → **Tags ▸**.
2. Put **Finish today** on one row; put three tags on another; try a fourth.
3. Make a new tag from the submenu: **New tag…**, type a name, pick a
   color, press Enter.
4. Type part of a tag's label in the search box.
5. Pick two rows out with ⌘-click, one of them wearing the tag and one not,
   and open **Tags ▸** in the bulk menu.
6. Open **Manage tags…**, rename a tag, give it another color, delete it.
7. Narrow the left column until a name and its pills no longer fit on one
   line.
8. Delete a session that wears tags, and restart the app.

## Expected state
- Step 1: the catalogue is not empty — the shipped example **Finish today**
  is in it, in a gold-ish color, checked on nothing yet.
- Step 2: a click toggles the tag and the pill appears after the name at
  once; the fourth tag is refused and a small note in the menu says so,
  rather than one of the three being pushed out.
- Step 3: the tag is added to the catalogue **and** put on the session the
  menu belongs to. A label is cut at fifteen characters, so no pill is ever
  truncated.
- Step 4: only the sessions wearing that tag are listed. There is no filter
  control anywhere — typing the label is the filter.
- Step 5: the tag every picked row wears is checked; the tag only some of
  them wear shows the mixed mark. Clicking a mixed or unchecked tag puts it
  on all of them; clicking a checked one takes it off all of them.
- Step 6: renaming and recoloring change every row wearing the tag at once;
  deleting asks first, saying how many sessions wear it, and then takes it
  off all of them. The catalogue may be emptied completely and stays empty.
- Step 7: the row grows to two lines — the name on the first, the pills on
  the second. The time stays right-aligned **on the first line**, and the
  status dot (and an agent's badge) stay level with the first line, not
  floating between the two.
- Step 8: the deleted session's tags are forgotten; after a restart the
  catalogue, the colors and every session's tags are exactly as they were.
- NEEDS ANSWER is never in the Tags menu, is always the first pill on a row,
  and keeps the look it has always had.

## Evidence
- `test/tags.test.js`
  - "a brand-new groups.json starts with the one shipped tag", "a
    groups.json written before tags existed is seeded the same way" and "a
    catalogue the user emptied stays empty — nothing is seeded again".
  - "a label is trimmed, collapsed and cut to fifteen characters" and "the
    window cleans a label exactly the way the store does".
  - "a tag with no label at all is not made"; "a color outside the palette
    becomes the first palette color"; "a stored tag with a broken label or
    color is repaired or dropped".
  - "a session wears three tags and refuses the fourth", "taking a tag off
    never refuses…" and "a stored session wearing four tags keeps only
    three, and unknown tags go".
  - "one call puts a tag on a whole selection and names who had no room".
  - "deleting a tag takes it off every session at once" and "a deleted
    session is forgotten by the tags as well".
  - "a row draws its tags in the catalogue's order, never more than three".
  - the bulk states: "…ticks a tag every picked row wears, and clicking
    takes it off", "a tag only some of the picked rows wear is mixed…", "a
    tag nobody in the selection wears reads as none", "the bulk plan names
    the rows that already wear three tags".
  - "the search box matches a tag's label as well as the name and the
    folder".
- Manual, with screenshots: rows with one, two and three tags next to
  NEEDS ANSWER including a wrapped row (`tags-rows.png`), the row menu's
  **Tags ▸** open (`tags-menu.png`), and the bulk **Tags ▸** with a mixed
  state (`tags-bulk.png`).

## Out of scope
- NEEDS ANSWER itself, which is not a tag anybody can edit: CL-23.
- The color of the **name**, which is a different thing from a tag's color:
  CL-22.
- Filtering by tag with a control of its own: there is none, on purpose —
  the search box matches labels.

## What the dry tests do not prove
- That a wrapped row looks right: that the pills sit under the name, that
  the time and the dot stay on the first line, and that a pill's color is
  readable on the dark ground — manual, with a screenshot.
