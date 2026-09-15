# CL-14 · Preamble · editing and refreshing
Priority: P3 · Verified by: dry test `test/preamble.test.js`

## Goal
An edited preamble.md is never overwritten; a file that is still one of the
app's own older defaults is brought up to date; an agent's session gets one
combined text (preamble plus definition), and the temporary file holding it
disappears when the terminal does.

## Preconditions
- The app's own folder holds `preamble.md`.

## Steps
1. Start the app for the first time (no preamble.md yet) and look at the file.
2. Edit the file by hand and start the app again.
3. Put the text of an older default back into the file and start the app again.
4. Start a session as an agent (CL-15) and look at the prompts folder while it
   runs, then after it exits.

## Expected state
- First start writes the current default text.
- A file the user edited stays exactly as it was; the log says it was left
  alone and where the new default text can be read.
- A file that is byte for byte an older default of this app is replaced with
  the current one — otherwise every session started before this version would
  keep the old text forever.
- An agent's terminal gets one appended text: the preamble first, then who the
  agent is, then its whole definition; it is passed as a file rather than on
  the command line, and that file is removed when the terminal exits (and any
  left over from a crash are cleared at the next start).

## Evidence
- `test/preamble.test.js`
  - "the first start writes the default text" (and a second start reports it
    is current).
  - "a file the user edited is kept, whatever the new default says" — with
    the single log line.
  - "a file that is still one of our own old defaults is brought up to date"
    and "one changed character is an edit, not an old default".
  - "the current default is not in the list of replaceable old defaults" — so
    the file is not rewritten on every start.
  - "reading the preamble writes the default when the file is missing or
    empty" and "a preamble that cannot be written still gives the session its
    text".
- `test/agents.test.js`, "the appended prompt carries the preamble, who the
  agent is and the whole definition" — the combined text of step 4.
- `test/claudeCli.test.js`, "the prompt goes into a file when the CLI takes
  one, and inline when it does not" — the text never reaches the command line
  when the file is used.

## Out of scope
- What the preamble says: CL-13.

## What the dry tests do not prove
- That the prompt file is written at spawn and deleted on exit, and that
  stale ones are cleared at the next start: manual (it needs a real pty).
- Whether this CLI accepts `--append-system-prompt-file`: that is probed by
  running `claude` once, which no dry test does.
