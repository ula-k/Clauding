# CL-10 · Panel · tabs per session
Priority: P1 · Verified by: dry test `test/panelTabs.test.js` + manual (smoke hook `CLAUDING_SMOKE_TERMINAL`)

## Goal
The right panel belongs to the session, not to the window: HTML, Markdown and
web addresses open and render there, a file edited on disk refreshes itself,
and both the tabs and "panel shown / hidden" come back per session after
switching and after a restart.

## Preconditions
- Two sessions with terminals open.
- An HTML file and a Markdown file in a scratch folder, and a web address.

## Steps
1. With the first session on screen, open the HTML file in the panel (from the
   session, with `clauding open`, or by clicking the path the terminal
   printed).
2. Open the Markdown file, then the web address: three tabs.
3. Edit the HTML file on disk and save it.
4. Switch to the second session.
5. Open something in the second session's panel, then hide the panel there.
6. Switch back to the first session.
7. Quit the app and start it again, then open each session in turn.
8. In a terminal, print a path to a `.html` file and a web address and click
   them.

## Expected state
- Each tab shows what it is: a local page, a rendered Markdown file, a web
  page; the tab is named after the file (or the page's own title once it is
  known).
- The edited file reloads in the panel by itself, without reopening the tab.
- Each session shows its own tabs and its own idea of whether the panel is
  up; showing or hiding in one session does not move the other's panel.
- After a restart each session still has its own tabs and its own visibility.
- A path or a URL printed in the terminal is clickable and opens in the same
  panel.

## Evidence
- `test/panelTabs.test.js`
  - "opening a page puts the panel up for that session and makes the tab
    active" and "a session nobody has opened anything for has no tabs and a
    hidden panel" — the default rules: opening a page is asking to see it; a
    session with no tabs and no choice of its own is hidden.
  - "show and hide are remembered for that one session" and "a page opened
    without revealing leaves the panel where the user put it" — a session
    hidden on purpose stays hidden.
  - "a session with nothing in it at all is hidden, and remembers nothing" —
    the one case where the flag is dropped: an empty session.
  - "opening the same page twice only re-activates the tab" and "closing the
    last tab of a session forgets it again".
  - "tabs opened before the CLI registered a session move to the session id"
    and "migrating into a session that already has the same page does not
    double it" — the `terminal:<id>` keys of a terminal whose CLI has not
    registered yet.
  - "every session gets its own panel back after a restart" — written to the
    file and read back by a second store (step 7).
  - "what may be opened: local pages, notes and web addresses, nothing else"
    and "a relative path is resolved against the folder the command ran in" —
    what a tab may be, and the readable refusals for everything else.
  - "a page's own title replaces the file name once the panel knows it".
- Manual, with screenshots: the three tabs (step 2), the page reloading after
  an edit (step 3), each session's own panel (steps 4–6), the same after a
  restart (step 7), and a clicked path from the terminal (step 8). The smoke
  hook `CLAUDING_SMOKE_TERMINAL` opens an HTML and a Markdown tab for real.

## Out of scope
- The `clauding` command itself and where a tab lands when the caller is
  unknown: CL-11.
- The panel's width: CL-12.

## What the dry tests do not prove
- That anything renders: the webview, the Markdown pipeline, the page title:
  manual.
- That a file changed on disk reloads (that is the file watcher): manual.
- That paths and URLs in the terminal are clickable: manual.
