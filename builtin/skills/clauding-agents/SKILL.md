---
name: clauding-agents
description: Use the `clauding` command from inside a Clauding terminal — register an agent definition you have just written (`clauding agent add <folder>`), list the registered agents, and show a page in the right-hand panel (`clauding open`). Use whenever you write or change an agent definition, or want the user to read a page instead of a wall of terminal text.
---

# Clauding: registering agents and showing pages

You are running inside **Clauding**, a desktop app around Claude Code: your
terminal is the middle column, and a side panel on the right shows HTML,
Markdown and URL tabs. The `clauding` command is on your PATH and talks to
the app you are running in.

## Register an agent definition

After you have written a definition **and the user has approved it**:

```
clauding agent add <definition folder> [--name "Release Notes Writer"] [--emoji "📝"]
```

* The **definition folder** is the folder holding the `.md` file, not the
  folder the agent works in. An agent reads itself from there; where it works
  is picked per session in the app's "+ New" sheet.
* Without the flags the app suggests everything itself: the definition file
  (`<folder>/<folder name>.md`, else `README.md`, else the only `.md` there),
  the name from the `# Agent: …` heading and the emoji from the file. There
  is no color to give an agent: the emoji is what tells one from another.
* The same folder is never registered twice; a second attempt prints the name
  it is already registered under.
* On success it prints `Added agent "<name>" to Clauding.`, and on refusal
  `clauding: could not add agent — <reason>`. **Report the printed line
  verbatim** — it is how the user knows what the app did.

`clauding agent list` prints the agents that are registered, one per line.

## Show a page instead of printing it

```
clauding open <path or URL>     # a tab in the right-hand panel
clauding tabs                   # what is open for this session
clauding panel show|hide
```

Anything the user has to *read* — a draft definition, a plan, a comparison —
goes into the panel. A long Markdown document pasted into the terminal is not
something anyone reviews.

## Rules

* **Approval first.** Never register an agent the user has not seen and
  agreed to. Show the draft with `clauding open`, wait, then add it.
* **One definition per folder.** If a folder already holds an agent, write the
  new one in a folder of its own.
* **Do not edit the app's settings or `agents.json` by hand.** The command is
  the only supported way in; a hand-edited file is dropped when it does not
  parse.
* The command only works in a terminal the app opened. If it answers that the
  app is not running, say so instead of retrying in a loop.

Related: the **skill-maker** skill turns a conversation into skills; this one
is about the agent definitions and the panel.
