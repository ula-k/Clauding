# CL-15 · Agents
Priority: P1 · Verified by: dry test `test/agents.test.js`, `test/emojiChoices.test.js`, `test/claudeCli.test.js` + manual (smoke hooks `CLAUDING_SMOKE_AGENTS`, `CLAUDING_SMOKE_EMOJI`)

## Goal
Picking a definition folder fills the form in by itself; a session started as
an agent knows its definition and its folder; the agent's emoji is on its rows
and in the header; the Agents tab lists each agent's sessions with a count and
the hidden ones counted apart; a link to a session with no transcript is
skipped without an error; deleting an agent takes its links with it; and the
emoji field holds exactly one whole character.

## Preconditions
- A folder with an agent definition in it (for example `agenci/spec-writer/`
  with `spec-writer.md`), readable, outside this repository.
- Clauding is running.

## Steps
1. Open the Agents tab and press "+ Add agent".
2. Pick the definition folder and read what the form filled in: which file,
   which name, which emoji.
3. Choose a different `.md` file in the same folder and watch the name and
   emoji change with it.
4. Paste "✅ Test" into the emoji field, then "🧑‍💻 developer", then "👩🏽‍🔬".
5. Pick a color and save the agent.
6. Start a session as that agent from "+ New", and ask it who it is and where
   its definition lives.
7. Look at the row of that session and at the header of its terminal.
8. Go back to the Agents tab: the agent's sessions are listed under it with a
   count; hide one of them (CL-05) and look again.
9. Close a terminal started as that agent before it says anything at all, then
   reopen the Agents tab.
10. Delete the agent and look at the rows that carried its badge.

## Expected state
- The form suggests the `.md` file named after the folder, else README.md,
  else the only one there; the name comes from the definition's first heading
  (without an "Agent:" prefix) and the emoji from the first emoji in the text.
- The emoji field keeps one whole character, joined emoji and skin tones
  included, and anything pasted after it is dropped.
- A color is one of the eight palette tokens, never a free color.
- The session started as the agent answers with its own name, its definition
  file and its folder; its title carries the agent's emoji, the row shows the
  agent's circle, and the row does not print the emoji twice.
- Under the agent, its sessions are listed newest work first, with a count;
  the hidden ones are not listed but counted on a line of their own.
- A link to a session that never wrote a transcript is skipped in the list
  without an error, and the count matches what is shown.
- Deleting the agent removes the badge from every row: no circle in a color
  nothing explains any more.

## Evidence
- `test/agents.test.js`
  - "a definition folder suggests the file named after it, then README, then
    the only one" and "the folder lists only its own markdown files, sorted".
  - "the name comes from the first heading, without the Agent prefix" and
    "the emoji comes from the first whole emoji in the definition".
  - "a single definition file suggests the same name and emoji" (step 3).
  - "an agent needs a name, a folder and a file inside that folder" and "a
    definition file given by its bare name is resolved inside the folder" —
    a stored path that wandered outside the folder is refused.
  - "the emoji is cut to one whole character and the color must be a palette
    token".
  - "deleting an agent takes every session link with it" (step 10).
  - "a link to a session with no transcript is kept, not treated as broken"
    (step 9) — the store keeps the link, the list simply does not show it.
  - "an agents.json full of rubbish still gives a usable Agents tab" and "an
    agents.json that is not even JSON is treated as empty".
  - "the appended prompt carries the preamble, who the agent is and the whole
    definition" (step 6).
  - "the working folder of an agent is remembered once, not on every start" —
    what "+ New" preselects next time.
- `test/emojiChoices.test.js`
  - "a pasted emoji with text after it keeps only the emoji", "a joined emoji
    stays in one piece", "the spaces around the field's text are dropped" —
    step 4, including "✅", "📐", "🧑‍💻" and "👩🏽‍🔬".
  - "the built-in list is made of single whole emoji", "every emoji in the
    list is offered only once", "searching the list keeps only the rows that
    match".
- `test/sessionGrouping.test.js`, "an agent's own list counts the hidden ones
  apart" (step 8), and "search matches the title, the agent, the folder and
  the first prompt" (CL-03).
- `test/claudeCli.test.js`, "a name the user typed wins over the agent's own"
  — a session with no name of its own is titled "<emoji> <agent name>", which
  is what step 7 reads.
- Manual, with screenshots: the filled-in form (step 2), the emoji field after
  each paste (step 4), the session answering who it is (step 6), the row and
  the header (step 7), the Agents tab with the counts (step 8) and after the
  deletion (step 10). The smoke hooks `CLAUDING_SMOKE_AGENTS` and
  `CLAUDING_SMOKE_EMOJI` drive most of this in the real interface.

## Out of scope
- The preamble the definition is appended to: CL-13, CL-14.
- Forking an agent's session: CL-09.
- The built-in agents and the skills menu being added elsewhere: not
  specified here.

## What the dry tests do not prove
- That the session actually answers with its own definition: no dry test
  starts a `claude` — manual, or the smoke hook.
- The form, the badge, the header chip and the Agents tab itself: manual.
- The native macOS emoji panel: out of scope (the plan excludes it).

## Known problem found while writing these tests
`test/agents.test.js` holds one test marked TODO: "the suggested name does not
repeat the emoji the heading starts with". A definition whose heading begins
with an emoji ("# 🚀 Launcher") suggests "🚀" in the emoji field *and*
"🚀 Launcher" in the name field, so an agent saved straight from the
suggestions wears its emoji twice — once in its circle, once in its name. The
app was not changed; the test says what the form should suggest and fails
today, on purpose.
