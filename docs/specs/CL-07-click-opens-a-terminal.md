# CL-07 · Terminal · a click is a terminal
Priority: P1 · Verified by: dry test `test/claudeCli.test.js` + manual (smoke hook `CLAUDING_SMOKE_TERMINAL`)

## Goal
Clicking a row resumes exactly that conversation, in its own folder, straight
away; several terminals live side by side and keep their scrollback when the
selection moves between them; within a few seconds the row knows the app is
driving it; and the "+" on a group header opens a new session into that group.

## Preconditions
- Clauding is running with at least two sessions in the list, in two different
  project folders, neither of them this repository.
- Neither session is running anywhere else (CL-02).

## Steps
1. Click a row and wait for the Claude Code prompt in the middle column.
2. Ask the session something short that proves which conversation it is (for
   example, to repeat the last thing it was told).
3. Click the second row, wait for its prompt, then click the first row again.
4. Watch the first row for a few seconds after step 1: it changes from "just
   started" to a row the app owns.
5. Press the "+" on a group header and start a session in a folder of your
   choice.
6. Let a clicked terminal sit untouched, with its CLI idle, for over twenty
   minutes.

## Expected state
- The terminal that opens is `claude --resume <the id of that row>` in that
  session's own folder; the conversation continues where it left off.
- Both terminals stay alive; switching back shows the earlier scrollback, not
  a fresh screen.
- Within a few seconds of a click the row shows that this terminal belongs to
  the app (the middle column is a terminal, not the note of CL-02), and before
  the CLI has registered anything the row shows a placeholder rather than
  nothing.
- A session started from a group's "+" lands in that group as soon as its CLI
  registers a session id.
- A terminal that was opened by a click, never typed into, and whose CLI has
  been idle for twenty minutes hangs up on its own; the conversation on disk
  is untouched and can be resumed by clicking again. A terminal that was typed
  into, or opened from "+ New", is never closed this way (CL-08).

## Evidence
- `test/claudeCli.test.js`
  - "a click on a row resumes exactly that session" — `--resume <id>` and
    nothing else; no `--fork-session`.
  - "a brand-new session is started with nothing but its appended prompt".
  - "the prompt snapshot is switched off whenever something is appended" —
    the flag that makes a resumed session know about the panel (CL-13).
  - "the terminal knows its own id, so `clauding` lands in the right panel"
    and "the folder holding the `clauding` command goes in front of PATH" —
    what makes the command of CL-11 work inside this terminal.
  - "the variables that would make the CLI think it is a nested session are
    dropped" — without this the CLI skips its registry entry and the row can
    never be linked to the terminal at all.
- Manual, with screenshots: the resumed conversation (step 2), the scrollback
  after switching back (step 3), the row owned by the app (step 4), the new
  session inside the group (step 5). The smoke hook `CLAUDING_SMOKE_TERMINAL`
  drives steps 1–3 and the click-to-resume for real, in a scratch folder.

## Out of scope
- Fork: CL-09. The "+ New" sheet itself: CL-08.
- The right panel: CL-10, CL-11.
- What the CLI does with `--resume`: assumed to work.

## What the dry tests do not prove
- The pty itself: that a `claude` really starts, that the session id in
  `~/.claude/sessions/<pid>.json` is linked to the terminal within a few
  seconds, and that the folder fallback works when it is not: manual, or the
  smoke hook. No dry test starts a `claude`.
- Scrollback across a switch, and the placeholder row: manual.
- The twenty-minute self-closing (step 6): manual, and best with a shortened
  timer — no dry test waits twenty minutes.
