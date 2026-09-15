---
name: skill-maker
description: Turn a conversation, or a described procedure, into Claude Code skills. Use when the user asks to "harvest skills", to write or update a skill, or when a conversation contains a procedure that will clearly be repeated. Lists the candidates first and writes only the ones the user keeps.
---

# Skill Maker

Find the repeatable procedures in a conversation (or in what the user
describes) and write each one as its own Claude Code skill.

## Steps

1. **Read the whole source first** — the conversation you were forked from,
   or the description the user gave. Do not start writing from the first
   promising paragraph.
2. **List the candidates.** For each one, print a single line: the proposed
   skill name in `lower-dash-case`, and what it would be for. Say plainly
   which ones you think are worth keeping and which are one-offs.
3. **Ask which to keep** and wait for the answer. Never write a skill nobody
   asked for.
4. **Check the skills folder** (`~/.claude/skills/`, or the folder the user
   names) before writing. If a skill already covers the procedure, propose an
   edit to that one instead of a second skill under a new name.
5. **Write each kept skill** to `~/.claude/skills/<slug>/SKILL.md`:
   * YAML frontmatter with `name` (the slug) and `description` — the
     description says *what it does* **and** *when to use it*, because that
     sentence is all a session sees when deciding to load the skill.
   * A short imperative body: the steps in order, the rules that matter, and
     the mistakes to avoid. Second person, present tense, no narration of how
     the skill came to be.
6. **Link related skills.** When two skills belong to the same workflow, each
   one names the other in a line at the end ("After this, run …").
7. **Report** the paths you wrote, in one line each, and say that a new skill
   is picked up by the next session, not by the one running now.

## Rules

* **One procedure per skill.** A skill that covers two jobs is loaded for the
  wrong one half the time. Split it.
* **Never duplicate an existing skill** — read the folder, compare by what the
  skill *does*, not by its name.
* **No secrets, no personal data.** No tokens, passwords, API keys, private
  URLs, addresses, health or client details. Refer to a credential by where it
  lives ("the key in the Keychain entry `…`"), never by its value.
* **Only what actually happened.** Every step comes from the conversation or
  from the user's own description; invent no tooling and no flags.
* **Short beats complete.** A skill that fits on one screen is read; a manual
  is skimmed. Put the detail in a linked file next to `SKILL.md` if it is
  genuinely needed.
* **Keep the user's wording** for rules and preferences, including the reason
  behind each one.

## Out of scope

Writing agent definitions — that is the **Agent Maker** agent, reachable from
Clauding's "Create agent from this conversation".
