# CL-09 · Fork
Priority: P1 · Verified by: dry test `test/claudeCli.test.js` + manual (smoke hook `CLAUDING_SMOKE_FORK`)

## Goal
Fork opens a second terminal holding the same conversation up to this moment
under a new session id, leaves the original running and untouched, gives the
copy the original's group and agent but neither its tabs nor its hidden flag,
and asks nothing even when the original is busy.

## Preconditions
- A session with a real conversation in it (at least one exchange), in a
  scratch folder, not this repository.
- That session is in a group of its own, and has a tab open in its panel.

## Steps
1. Select the session and press Fork.
2. Read the new terminal: the conversation so far is there, and the CLI is at
   its prompt.
3. Look at the original terminal: still open, still alive, its scrollback
   intact.
4. Look at the list: two rows, two ids, the copy in the original's group, with
   the original's agent badge if it had one.
5. Look at the copy's panel: empty, whatever the original had open.
6. Make the original busy (ask it to count slowly) and press Fork while it
   counts.

## Expected state
- The copy is a new session id; the original transcript is not written to.
- The copy's name is the original's, with a marker after it (currently e.g.
  "… (fork)"), left untranslated on purpose because it becomes the stored name
  of that session.
- The original keeps running, in its own terminal, with its own panel.
- The copy joins the original's group as soon as its CLI registers an id, and
  carries the original's agent; it does not inherit the panel tabs and it is
  never hidden because the original was.
- Forking a busy session asks nothing and does not disturb the original.

## Evidence
- `test/claudeCli.test.js`
  - "a fork resumes the original and asks for a copy under its own name" —
    `--resume <id> --fork-session --name "<title> (fork)"`, in that order.
  - "a fork is named after the original, with room kept for the marker" — a
    long title is cut with an ellipsis so the whole name still fits, and the
    marker is always the last thing in the name.
  - "a typed session name is tidied and capped" — the cap the terminal
    applies on top.
  - "a name the user typed wins over the agent's own" — a fork of an agent's
    session keeps the fork name, not the agent name.
  - "the prompt snapshot is switched off whenever something is appended" —
    including for a fork, so the copy knows about the panel too (CL-13).
- Manual, with screenshots: both terminals side by side (step 2–3), the two
  rows with the copy in the original's group (step 4), and the fork of a busy
  session (step 6). The smoke hook `CLAUDING_SMOKE_FORK` does exactly this
  with a real `claude` in a scratch folder, Fork pressed in the real
  interface.

## Out of scope
- The CLI's own behaviour under `--fork-session`: assumed.
- Panel tabs: CL-10. Agents: CL-15.

## What the dry tests do not prove
- That the copy really holds the conversation and the original really keeps
  running: manual, or the smoke hook. No dry test starts a `claude`.
- That the copy joins the group and inherits the agent (that happens when the
  CLI registers the new id): manual.
- That the CLI asks nothing when the original is busy: manual.
