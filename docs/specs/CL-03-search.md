# CL-03 · List · search
Priority: P2 · Verified by: dry test `test/sessionGrouping.test.js` + manual

## Goal
The search box finds a session by everything the user might remember about it
— its name, its folder, its first words and the agent that ran it — a match
inside a folded group is shown rather than hidden, and searching changes
nothing on disk.

## Preconditions
- Several sessions exist: one with a distinctive name, one in a distinctive
  folder, one whose first prompt has a distinctive word, and one started by an
  agent.
- At least one of them sits in a group that is folded shut.

## Steps
1. Open Clauding.
2. Type a word from a session's name in the search box.
3. Type part of a folder name instead ("blueprint").
4. Type a word from a session's first prompt.
5. Type an agent's name.
6. Clear the box.

## Expected state
- Every query leaves the matching rows on the list and takes the others off
  it; a query nothing matches leaves the list empty with a note.
- The folder and the first prompt match even though the row prints neither:
  the row is one line, the rest is what the search looks through.
- While a query is typed every group is drawn open, so a match inside a folded
  group is visible; the folded state itself is untouched in `groups.json`.
- Hidden sessions stay hidden while searching.
- Clearing the box puts the whole list back, folded groups included.

## Evidence
- `test/sessionGrouping.test.js`
  - "search matches the title, the agent, the folder and the first prompt" —
    the four things a query is compared against.
  - "a match inside a folded group is shown: every group opens while
    searching" — the rule that search wins over folding.
  - "search is case-insensitive and ignores the spaces around the query".
  - "a hidden session stays hidden while searching".
- Manual: the real box in the real window, one query per line of this
  specification — the name, the folder, the first prompt and the agent — plus
  the folded-group rule (a match inside a folded group opens it). With a
  screenshot: a query that matches nothing.

## Out of scope
- Folding and unfolding themselves: CL-06.
- The order of the results: CL-01 (running first, then by last activity).

## What the dry tests do not prove
- Typing with a non-Latin keyboard, and accents: manual.
