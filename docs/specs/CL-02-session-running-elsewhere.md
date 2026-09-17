# CL-02 · List · a session running outside the app
Priority: P1 · Verified by: dry test `test/liveStatus.test.js` + manual

## Goal
A session that a terminal or a background job outside Clauding is running is
not something this window may talk in: its row says so, the middle column
offers the one useful thing — a copy of the conversation — and clicking it
starts no `claude` at all.

## Preconditions
- A session is running in Terminal.app (or as a background job) right now, so
  the CLI has a live entry for it in `~/.claude/sessions/<pid>.json`.
- No terminal of the app owns that session.
- Both registries under `~/.claude` are only read; the app writes nothing there.

## Steps
1. Open Clauding and find that session's row.
2. Click the row.
3. Finish the session in the terminal it is running in (manual only).
4. Click the same row here again.

## Expected state
- The row is marked as running outside the app, in the color its registry
  entry earns it (working while busy, waiting for you while idle).
- The middle column shows a short centered note with the session's title and
  its folder, saying the session is running somewhere else (currently e.g.
  "This session is running in another terminal or job. Finish it there, then
  click it here to continue.").
- A **Fork** button sits on that note, and nothing else does — there is no
  terminal, and no `claude` process was started by the click.
- After step 3 the same click opens a terminal and resumes that very session
  (the id is unchanged); this is the CL-07 path, reached from here.

## Evidence
- `test/liveStatus.test.js`
  - "a live CLI process is working when busy and waiting otherwise" — the
    color such a row gets.
  - "a session running in one of the app's own terminals is marked as ours"
    and "what the registry says about our own terminal still decides its
    color" — the difference between *ours* and *elsewhere*, which is what
    decides between a terminal and the note.
- Manual: clicking a session that runs elsewhere must show the note and Fork
  and must NOT start a terminal — no new `claude` process appears. Then, with
  screenshots: the note itself (step 2) and the resume after the other
  terminal has finished (steps 3–4).

## Out of scope
- Forking such a session: CL-09.
- The exact wording of the note; only its meaning is judged.

## What the dry tests do not prove
- That a session finished in Terminal.app can then be resumed here — the
  registry entry has to disappear for real, so that half stays manual.
