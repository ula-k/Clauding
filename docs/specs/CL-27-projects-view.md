# CL-27 · Projects · the tab and the project view
Priority: P2 · Verified by: dry test `test/projectsView.test.js`, `test/projectsData.test.js` + manual (screenshots on the fixture)

## Goal
A project — one ClickUp list, the local checkouts where its CU- branches
live, their pull requests and the Claude Code sessions working on its tasks —
is read in **one place**: a third tab in the left column and a view in the
middle column, without closing a single terminal. Nothing is written to
ClickUp, git or GitHub.

## Preconditions
- Started with `CLAUDING_PROJECTS_FIXTURE=test/fixtures/projects/website.json`
  and its own `--user-data-dir` (made-up data: "Website", "Mobile app" with
  no token, "Docs site" in Private). For a real project: a ClickUp token in
  the Keychain or `CLAUDING_CLICKUP_TOKEN`, and a project added with
  "Add a project…".
- At least one terminal open in the Sessions tab.

## Steps
1. Click **Projects** in the left column.
2. Look at the list, then at the middle column.
3. Click the chips My focus, Up next, Specs pipeline, Build, Everything.
4. Under Specs pipeline click another stage counter, then a spec's name.
5. Under My focus click a card (not a chip), then its `CU-…` chip, then the
   small ↗ next to it.
6. Click a session chip on a card.
7. Click **Mobile app**.
8. Click Sessions, then Projects again.
9. Click **Refresh** in the project header.

## Expected state
- Step 1: three tabs, **Sessions · Agents · Projects**, and "+" next to them;
  "Website" is selected.
- Step 2: one row per project, grouped Work / Private: color ring, name,
  "N left", a thin bar in the bucket colors, the nearest deadline
  (currently e.g. "Feature freeze in 18 d", gold when a week or less away)
  and "% closed"; no "waiting for you" in the list. A project never opened
  says so. The middle column shows the header (name, list and repository
  chips, "refreshed …", Refresh, Show/Hide panel), the deadline axis with
  **Today** and, under it, a line marked **Computed**; the numbers (buckets,
  left to close, pace, specs to write / in review / red CI, who has what);
  the filter chips with counts; the task cards.
- Step 3: the chip row moves to the top of the view and stays there; each
  chip shows the number of cards it holds. Build and Everything fold the
  tasks nobody started behind one line.
- Step 4: five stage counters, one highlighted, and the list of that stage
  under them; a spec's name opens its task in the side panel.
- Step 5: the card opens in place (task fields, description, comments count,
  sessions, code); the `CU-…` chip opens the app's own task view as a tab of
  this project's panel ("Open in ClickUp ↗" at the top); ↗ opens the task in
  the default browser.
- Step 6: the Sessions tab is shown with that session selected, exactly as a
  click on its row.
- Step 7: "No ClickUp token on this Mac" with the Keychain command and
  `CLAUDING_CLICKUP_TOKEN`; no error dialog.
- Step 8: Sessions shows the terminal as it was (scrollback kept, nothing
  restarted); Projects shows the same project again with its own panel tabs.
- Step 9: with the fixture, the same data; with a real project, the data is
  read again (ClickUp, `git fetch`, gh) — offline keeps the last copy and says
  "offline · as of …".

## Evidence
- `test/projectsView.test.js`: the fixture supplies its own projects and
  never touches the store; the list's groups, bar, deadline and % closed;
  deadline wording; bucket segments; filter chip counts and order; a card's
  chips (task, spec, sessions, branches per repository, PR, missing ones);
  pipeline dots; what waits on the user as a sentence; session state; the
  per-day line and colliding axis labels; the spec stage opened first; the
  burn-down line; the header's state; the spec link field as a board setting.
- `test/projectsData.test.js`: statuses, the ClickUp client (GET only), git
  and gh, session linking, stages, numbers, a whole project snapshot, the
  store (defaults `main` / `staging`, `specUrlFieldName`), cache and offline.
- Screenshots on the fixture: the list, the view, an expanded card with the
  task in the panel, the spec pipeline, the no-token state.

## What the dry tests do not prove
The real ClickUp answers (pagination, custom fields, dependencies to the
planning list) against a live workspace, `gh` signed in, and `git fetch` on
Refresh: manual.
