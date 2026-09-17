# CL-25 · Panel · the Skills tab
Priority: P2 · Verified by: dry test `test/skillsList.test.js` + manual

## Goal
The skills on this Mac are read as a **catalogue in the side panel** — a
search field, a count, and one row per skill with its whole description and
where it comes from — instead of a popover that could show neither the
descriptions nor thirty rows. The macOS **Skills** menu is the only way in;
clicking a skill still reads it in the middle column, with the catalogue
staying open beside it.

## Preconditions
- A skills folder with more than a handful of skills in it, at least one of
  them built-in and one under a plugin folder.
- A session selected in the list (the tab belongs to a session, like every
  other panel tab).

## Steps
1. Open the terminal header's **"…"** and the **gear** popover, and look
   for Skills in either.
2. Menu bar → **Skills → Show skills…**.
3. Type part of a skill's description into the field at the top.
4. Click a row.
5. Menu bar → **Skills →** one of the skills listed there.
6. Use the two links in the footer.
7. Quit the app, start it again and look at the panel.

## Expected state
- Step 1: **nothing**. Skills is in neither place any more — no button, no
  menu item, no popover.
- Step 2: the panel comes up for this session with a **Skills** tab in it:
  the search field, the count (`31`), and the rows — the app's own skills
  first with a **BUILT-IN** badge, then the rest alphabetically. Each row
  shows the whole description, never cut, and on the right `built-in`,
  `plugin <name>` or the folder (`~/.claude/skills`).
- Step 3: the list narrows as the word is typed (name **and** description
  are matched) and the count becomes `2 of 31`. A word nothing matches
  leaves the list empty and the total still honest.
- Step 4: the skill's `SKILL.md` opens **over the terminal** in the middle
  column with **Back to terminal**, exactly as before; the Skills tab is
  still there next to it.
- Step 5: the same thing happens — the reader opens *and* the tab is put up.
- Step 6: **Scan for skills…** opens the scan sheet, **Reveal in Finder**
  opens the skills folder. Both are links in the footer, not buttons.
- Step 7: the Skills tab is gone; the session's pages are back. It is a view
  of the folder, not a page, so it was never written to disk.

## Evidence
- `test/skillsList.test.js`
  - the order: "the app's own skills come first, everything else by name",
    "sorting leaves the list it was given alone", "nothing at all is an
    empty list, not an error".
  - the filter: "the search matches the name and the description, whatever
    the case", "an empty field matches everything", "the count says how
    many are shown out of how many there are", "a search that matches
    nothing still knows how many skills there are".
  - where a skill comes from: "a built-in skill says so", "a skill inside a
    plugin is named by its plugin", "anything else is the folder it sits
    in, with the home folder shortened", "a Windows path is read the same
    way", "every row carries the label the tab draws on its right".
  - the tab: "one skills tab per session, reused rather than opened twice"
    and "the skills tab is never written to panel-tabs.json".
- Manual, with a screenshot: the tab with a word typed into its search
  field and the skill open in the reader beside it (`skills-tab.png`,
  captured with `CLAUDING_SCREENSHOT_SKILLS`).

## Out of scope
- Finding skills elsewhere on the Mac and copying them in: **Scan for
  skills…**, unchanged.
- Writing a skill: that is the skill-maker over a conversation ("Harvest
  skills").
- The reader itself, which is the same one an agent definition opens in.

## What the dry tests do not prove
- That the whole description is readable in a panel of the usual width, and
  that the footer links stay on one line next to a long folder path:
  manual, with a screenshot.
