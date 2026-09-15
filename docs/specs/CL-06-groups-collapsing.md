# CL-06 · Groups · collapsing
Priority: P2 · Verified by: dry test `test/sessionGrouping.test.js`, `test/sessionGroups.test.js` + manual (smoke hook `CLAUDING_SMOKE_COLLAPSE`)

## Goal
A folded group is a header and nothing else — which is the point on a shared
screen — but it still says when something inside is working or needs an
answer, it still takes a dragged row, and it is still folded after a restart.

## Preconditions
- A group (currently e.g. "PRIV") holds at least one session that is running
  and one whose job is blocked.
- Clauding is running.

## Steps
1. Click the chevron on that group's header.
2. Read the header: the group's name, how many sessions are in it, and the
   marks that replace the rows.
3. Type a search word that matches a session inside it (CL-03), then clear it.
4. Drag a row from another group onto the folded header.
5. Reload the window (or quit and start again).

## Expected state
- Folded, the group shows no rows at all, but the header carries the count and
  the same two signals the rows would have carried: something is running,
  something needs an answer.
- The header is still a drop target: the dragged row joins the group and the
  count grows, while the group stays folded.
- While a search is typed the group is drawn open; clearing the search folds
  it again, and the stored state never changed.
- After a restart the group is still folded. Default can be folded too.

## Evidence
- `test/sessionGrouping.test.js`
  - "a bucket reports what its rows would show, so a folded group stays
    honest" — the folded bucket keeps its sessions (so the count is right) and
    reports `hasRunning` and `hasNeedsAnswer`.
  - "a match inside a folded group is shown: every group opens while
    searching".
- `test/sessionGroups.test.js`
  - "collapsing only accepts groups that exist, Default included".
  - "deleting a group sends its sessions back to Default and cannot touch
    Default" — a deleted group is also dropped from the folded list.
  - "everything survives a round trip through the file" — the folded list is
    stored and read back.
  - "a groups.json full of rubbish still yields a usable list" — a fold
    pointing at a group that is gone is dropped.
- Manual, with a screenshot: the folded header with its count, its badge and
  its running dot (step 2), and the row dropped on it (step 4). The smoke hook
  `CLAUDING_SMOKE_COLLAPSE` walks all five steps in the real interface.

## Out of scope
- Making, renaming and ordering groups: CL-04.

## What the dry tests do not prove
- The chevron, the drop on a folded header, and what the header draws:
  manual, or the smoke hook.
