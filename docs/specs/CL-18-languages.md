# CL-18 · Languages
Priority: P3 · Verified by: dry test `test/i18n.test.js` + manual

## Goal
Four languages, all saying the same things; the app starts in the system
language and remembers the choice; the Default group is translated while the
fork marker is not; and no interface text is written outside the translation
table.

## Preconditions
- The app can be started with the system language set to Polish, Spanish,
  Simplified Chinese and something the app has no strings for (German, say).

## Steps
1. Start the app with the system in each of the four languages in turn.
2. Start it with the system in German.
3. Choose another language in the app, quit and start it again.
4. In each language, look at the list header, a group header, the row menus,
   the "+ New" sheet, the Agents tab and the panel.
5. Look at a forked session's name in each language (CL-09).

## Expected state
- Each language shows its own words everywhere; nothing falls back to English
  by accident.
- German starts in English.
- The chosen language survives a restart.
- The Default group's header is the translated word as long as it was never
  renamed; a renamed Default keeps the typed name in every language (CL-04).
- The marker on a forked session's name stays as it is in every language: it
  is that session's stored name, not a label the app redraws.

## Evidence
- `test/i18n.test.js`
  - "there is one locale file per supported language, and no others".
  - "every language has exactly the keys English has" — no missing and no
    extra keys in any of the four.
  - "no translation is left as an empty string".
  - "a placeholder used in English is used in every language too" — a count
    or a name never disappears from a translated sentence.
  - "the group Default is translated and the fork marker is not".
  - "the system language is matched by its whole tag, then by its language",
    "every Chinese variant lands on the one Chinese translation" (including
    the Traditional tags, which land on Simplified on purpose), "a language
    the app has no strings for falls back to English".
- Manual, with a screenshot per language (step 4).

## Out of scope
- The quality of the translations.
- Right-to-left languages: none are offered.

## What the dry tests do not prove
- That every string on screen really comes from the table: the dry tests
  compare the four tables with each other, they do not scan the components.
  A string written straight into a component would pass them and be caught
  only by the screenshots of step 4.
- That the choice is remembered (it is kept in the window's own storage):
  manual, step 3.
