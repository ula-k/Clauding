# CL-27 · Projects · the tab, the project view, the settings
Priority: P2 · Verified by: dry tests `test/projectsView.test.js`, `test/projectsData.test.js`, `test/projectsSetup.test.js` + manual (screenshots on the fixture and on a real project in its own `--user-data-dir`)

## Goal
A project — a ClickUp list (or the folder or space it lives in), the local
checkouts where its CU- branches live, their pull requests and the Claude
Code sessions working on its tasks — is read in **one place**: a third tab
in the left column and a view in the middle column, without closing a
single terminal. The view says what is on the user's plate (her queue),
what waits on others and what is closed. Nothing is written to ClickUp, git
or GitHub; only `project-boards.json` changes (and a terminal opens when a
session is started for a task).

## Preconditions
- Fixture run: `CLAUDING_PROJECTS_FIXTURE=test/fixtures/projects/website.json`
  and its own `--user-data-dir` (made-up data: "Website", "Mobile app" with
  no token, "Docs site" in Private).
- Real run: a ClickUp token in the Keychain or `CLAUDING_CLICKUP_TOKEN`, its
  own `--user-data-dir`, a ClickUp list / folder / space link, and the local
  repositories. `gh` may be signed out.
- At least one terminal open in the Sessions tab.

## Steps
1. Click **Projects** in the left column; with no project, click "Add a
   project…" (or **Projects → Add a Project…** in the menu bar).
2. Type a name, paste `https://example.com/nothing` as the project link, Add.
3. Paste a real list link (`…/v/l/<view>` or `…/v/li/<list>`), the
   repositories (one folder per line), Add. Then add another project from a
   space link, and one from a folder link.
4. Look at the list, then at the middle column.
5. Type part of a task's name into "Search projects and tasks", click the
   task under the project.
6. Click the chips My focus, Up next, Specs pipeline, Build, Everything;
   type into "Search tasks".
7. Click a number: a bucket, "My queue", "waiting on others", a person,
   "specs to write"; then ✕ on the chip that appears.
8. Under Specs pipeline click another stage counter, then a spec's name.
9. Click a card (not a chip), then its `CU-…` chip, then the small ↗.
10. Open a card's "…": Pin to Up next; open Up next; "…" → Move down; "…" →
    Link a session… → a session; "…" → Unlink; "…" → Start a session for
    this task → In <repository>.
11. Click **Settings** in the header: change the base and staging branches,
    add a deadline typed by hand and one that follows a task, map a status
    to another place on your side, pick the developer-status field, Save.
12. Look at the deadline axis of a project whose plan is kept in ClickUp
    (a task named for the project with phase and milestone subtasks); open
    Settings → Deadlines → "Where the phases and deadlines come from".
    Click a deadline typed here on the axis, change its date, Save; "+ Add a
    deadline".
13. Settings → ClickUp → Change… on the specs list: walk workspace → space →
    folder, pick a list.
14. On the throw-away project: Settings → Remove project… → Remove.
15. Click **Mobile app** (fixture); click Sessions, then Projects again;
    **Refresh**.
16. Open a local HTML page in the side panel, click into it, press ⌘+ twice;
    click the "125 %" in the address bar; open another local page.

## Expected state
- Step 1: three tabs, **Sessions · Agents · Projects**, and "+" next to them.
- Step 2: the sheet stays open and says, in the app's language, "That is
  not a ClickUp link. Paste a link to a list, a folder, a space or a task."
- Step 3: the list link becomes the build list at once; the specs list is
  found through the build tasks' dependencies on the first refresh. The
  folder link finds the same build list (its tasks depend on tasks outside
  the folder). A space with too many lists (or none depending on another)
  shows "Which list is the build list?" with the lists to pick from.
- Step 4: one row per project, grouped Work / Private: color ring, name,
  "N in my queue", a thin bar in the bucket colors, the nearest deadline and
  "M waiting · K closed". The view: header (name, list and repository chips —
  under the name when the column is narrow —, "refreshed …", Refresh,
  Settings, Show/Hide panel); the deadline axis, or, with none, a sentence
  that says why ("no dates in ClickUp yet", or how many tasks carry a due
  date); the numbers (buckets, **My queue** with its line, waiting on others,
  closed, needed and actual hand-offs per week, specs to write / in review,
  red CI, who has what); the chips with counts; the task cards (status, my
  queue / waiting / closed, the developer-status chip, dots with staging
  marked as the hand-off and QA / prod faint, link chips).
- Step 5: the project row lists the matching tasks; a click opens the
  project on Everything with the search filled in and that card open.
- Step 6: the chip row moves to the top and stays; My focus holds the queue
  needing the user first, with the untouched tasks folded behind one line;
  the task search narrows any list (folded cards included).
- Step 7: the cards are exactly the ones the number counts; the chip says
  which ("Only: In staging"), ✕ goes back.
- Step 8: five stage counters, one highlighted, and the list of that stage.
- Step 9: the card opens in place (fields with drop-down names, description,
  comments count, sessions, code); `CU-…` opens the app's own task view as a
  tab of this project's panel; ↗ opens the browser.
- Step 10: 📌 on the card and Up next 1; the order changes; the session chip
  appears / disappears; a terminal opens in the repository folder, the
  Sessions tab shows it, its first message is the task link, and once the
  session has an id it is linked to the task.
- Step 11: the view draws again with branches "+N ahead" / "in staging"
  counted against the new branches, the deadlines on the axis ("⧉" before
  one that follows a task, dated from that task), the numbers moved.
- Step 12: the phases are bars under the axis (done / running / later), the
  milestones diamonds, "From ClickUp: <task> (N dated, M without a date)";
  the setting says "Found in ClickUp: <task>" and lists the other candidates;
  a click on a phase opens its task in the panel. A typed deadline moves;
  nothing is saved without a name and a date/task.
- Step 13: the picker reads ClickUp one level at a time; the chosen list
  shows in the sheet until Save.
- Step 14: "Remove “…” from Clauding?" first; after Remove the project is
  gone from the list; ClickUp, git and sessions are untouched.
- Step 15: "No ClickUp token on this Mac"; Sessions shows the terminal as it
  was; Refresh reads again (offline keeps the last copy and says so).
- Step 16: the page grows to 125 % and the address bar says "125 %"; the
  click puts it back to 100 %; the other local page opens at 100 %.

## Evidence
- `test/projectsSetup.test.js`: the link parser (task, list, list view,
  saved view, board view, folder, space, bare ids, garbage); telling lists
  apart by dependencies (inside, outside, none → ask); real planning status
  names; the spec field by prefix; drop-down / label names; the three places
  and their defaults; the developer-status field (detected, chosen, mapped);
  a task's path from time in status, hand-offs and re-entries; the fallback
  path; hand-offs per week, the My queue line, needed per day; the opening
  of a transcript; branch names in any case / with suffixes / under a folder;
  only the project's branches with staging in one pass; the project and task
  searches; numbers as filters; the honest empty axis; date fields, Up next
  order, a session's first message; the settings the store keeps; a whole
  snapshot with the developer field and a deadline that follows a task;
  phases and single dates read from tasks, the roadmap task named for the
  project, plan-like lists, the source setting, phases in lanes and merged
  markers; the side panel's zoom (clamping, steps, label, reset).
- `test/projectsView.test.js`, `test/projectsData.test.js`: the fixture, the
  list, chips, cards, pipelines, statuses, the ClickUp client (GET only),
  git and gh, session linking, stages, numbers, a whole project, the store,
  cache and offline.
- Screenshots on a real project in its own profile: add sheet (error, list
  link, space → pick), list with search, view, expanded card, task tab,
  specs pipeline, stat filter, task search, card menu, Up next, start a
  session, deadline sheet, settings (general, ClickUp, repositories,
  deadlines, status map, developer field, picker, remove).

## What the dry tests do not prove
The real ClickUp answers (views, folders, spaces, time in status, list
members and fields) against a live workspace, `gh` signed in, `git fetch`
on Refresh, and a real session getting linked after "Start a session for
this task" (the screenshot run uses `CLAUDING_DRY_SPAWN=1`): manual.
