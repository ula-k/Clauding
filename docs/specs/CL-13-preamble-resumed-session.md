# CL-13 · Preamble · a resumed session
Priority: P1 · Verified by: dry test `test/preamble.test.js`, `test/claudeCli.test.js` + manual (smoke hook `CLAUDING_SMOKE_PREAMBLE`)

## Goal
A new session, a session resumed by a click and a forked session all know they
run inside Clauding and that `clauding open` puts a page in the right panel —
and none of them answers a request to "open this on the right" by publishing a
claude.ai Artifact.

## Preconditions
- A scratch folder, never this repository.
- A session that was *not* born inside Clauding (started in Terminal.app) is
  available to resume by clicking its row — that is the case the bug hit.

## Steps
1. Start a new session from "+ New" and ask it, in one line, what app it is
   running inside and which exact command opens a file on the right.
2. Exit that session, then click its row to resume it, and ask the same
   question again.
3. Click the row of the session that was started in Terminal.app and ask the
   same question.
4. Fork a session (CL-09) and ask the copy the same question.
5. In each of them, ask for a page to be opened "on the right" and watch what
   the session does.

## Expected state
- Every one of the four answers names Clauding and `clauding open`; a resumed
  session is not vaguer than a new one.
- Asked to open something on the right, the session runs `clauding open` and
  the page appears in the panel. It does not publish a claude.ai Artifact, and
  it does not tell the user to press a keystroke instead.
- If `clauding open` fails, the session says so instead of claiming the page
  is open.

## Evidence
- `test/preamble.test.js`
  - "the default text tells a session it is in Clauding and which command
    opens the panel" — Clauding, the side panel, `clauding open`, `clauding
    panel hide`, `clauding tabs`.
  - "the default text forbids answering with a claude.ai Artifact" — the
    Artifact ban, the keystroke that is not the panel either, and the rule to
    report a failed open verbatim.
  - "the default text asks for a plan as an HTML page in the panel" — the
    instruction behind CL-10's usual case.
  - "the default text names the panel in the languages the interface has" —
    so the request can be made in Polish, Spanish or Chinese (CL-18).
  - "reading the preamble writes the default when the file is missing or
    empty" — every spawn reads it, so every session gets it.
- `test/claudeCli.test.js`
  - "the prompt snapshot is switched off whenever something is appended" —
    for a new session, a resumed one, a fork and an agent alike. This is the
    whole fix: without `--system-prompt-snapshot off` the CLI replays the
    system prompt recorded on the conversation's first request, so a session
    that was not born inside Clauding never learns about the panel.
  - "a brand-new session is started with nothing but its appended prompt" and
    "with nothing to append there is no snapshot flag either".
- Manual, with screenshots: the four answers (steps 1–4) and the page landing
  in the panel instead of an Artifact (step 5). The smoke hook
  `CLAUDING_SMOKE_PREAMBLE` asks the question of a new and of a resumed
  session with a real `claude` and prints both answers.

## Out of scope
- Editing the preamble and refreshing it: CL-14.
- What `clauding open` does with the tab: CL-10, CL-11.
- The agent's own definition on top of the preamble: CL-15.

## What the dry tests do not prove
- What the model actually answers: no dry test starts a `claude`. The text is
  checked for what it must say and the command line for the flag that gets it
  delivered; the answer itself is manual, or the smoke hook.
