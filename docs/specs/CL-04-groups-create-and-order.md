# CL-04 · Groups · creating and ordering
Priority: P1 · Verified by: dry test `test/sessionGroups.test.js`, `test/sessionGrouping.test.js` + manual (smoke hook `CLAUDING_SMOKE_GROUPS`)

## Goal
The order of the list is the user's own: a new group opens at the top, Default
stays at the bottom, a group can be renamed, moved and deleted without losing
a single session, a row can be dragged into a group, all of it survives a
restart, and a broken groups.json still draws a usable list.

## Preconditions
- Clauding is running with several sessions in the list.
- The groups file is the app's own (`<userData>/groups.json`); no test ever
  writes to a real project folder.

## Steps
1. Make a new group and give it a name.
2. Check where it appeared, and where Default is.
3. Make a second group and check the first one moved down by one.
4. Move a group up and down with its menu, and try to move the one just above
   Default down, and Default itself up.
5. Rename a group.
6. Drag a session's row onto another group's header.
7. Delete the group that row is now in and confirm.
8. Quit and start the app again.
9. With the app closed, put rubbish into groups.json (a group with no id, a
   membership pointing at a group that is gone, a duplicate id) and start the
   app.

## Expected state
- A new group is at the very top; Default is always the last header, and its
  header shows the translated word for "default" as long as it was never
  renamed (CL-18).
- Up and down swap a group with its neighbour and nothing else; the group just
  above Default cannot be pushed past it, and Default cannot move at all.
- A renamed group keeps its sessions and its place; renaming Default makes
  that name stick and it still stays last.
- A dragged row joins the group whose header it was dropped on, at once.
- Deleting a group never deletes a session: every row it held is back under
  Default, and the group is gone from the list.
- After a restart, the groups, their order, the membership and the fold state
  are exactly as they were.
- With rubbish in the file, the list still draws: the unusable entries are
  dropped, everything else is kept.

## Evidence
- `test/sessionGroups.test.js`
  - "a new group opens at the top and Default stays pinned at the bottom",
    "a renamed Default keeps its id and its place at the bottom".
  - "a group name is trimmed, collapsed to single spaces and capped" — and a
    group with no name is refused.
  - "move up and down swap neighbours and never move Default" — the two edges
    of step 4 as well.
  - "deleting a group sends its sessions back to Default and cannot touch
    Default".
  - "assigning a session to Default or to an unknown group clears its
    membership" — what the drag in step 6 writes.
  - "everything survives a round trip through the file" — the store is written
    and read back by a second store: groups, order, membership, hidden, folded.
  - "a groups.json full of rubbish still yields a usable list" and "a
    groups.json that is not even JSON is treated as empty" — step 9.
  - "the state handed out is a copy, not the store's own objects" — the
    renderer cannot corrupt the store by holding on to what it was given.
- `test/sessionGrouping.test.js`
  - "buckets come in the stored order, with Default last" and "a session with
    no membership lands in Default" — what the column draws from that state.
  - "inside a bucket, running sessions come first and the rest by recency".
- Manual, with screenshots: the drag in step 6, the confirmation in step 7,
  and the list after the restart in step 8. The smoke hook
  `CLAUDING_SMOKE_GROUPS` drives the same path through the real interface and
  puts back what it borrowed.

## Out of scope
- Hiding: CL-05. Folding: CL-06. The "+" on a group header (a new session
  straight into that group): CL-07.
- What a row looks like: CL-01.

## What the dry tests do not prove
- The drag itself (a row onto a header) — the store is told the result, not
  the gesture: manual.
- That the confirmation dialog appears before a group is deleted: manual.
- That the list on screen matches the store after a restart: manual.
