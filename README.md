# Clauding

**A macOS desktop window around your Claude Code sessions.** Every session on
your Mac in a list on the left, a **real terminal running `claude`** in the
middle, and a **side panel with tabs** on the right — a local HTML page, a
Markdown file or a web page, next to the terminal.

It is the terminal experience, not a chat window: you type like in
Terminal.app, slash commands work, permission prompts, thinking and tool
output look exactly like the CLI draws them. Clicking a session **is** a
terminal — `claude --resume` starts in that session's folder the moment the
row is clicked.

![The three columns: sessions, a real terminal, the side panel](docs/screenshots/three-columns.png)

## What it does

* **Your sessions, grouped your way.** Everything starts in one **Default**
  group; make more ("Website", "Work"), drag rows into them, fold a group
  shut, hide the rows you never want to see. Status is a colour on the row,
  not a group. A search box matches names, folders and first prompts.
* **A real terminal in the middle.** One pty per session, `claude --resume`
  on a click, `claude` in a folder you pick from "+ New". Nothing to close:
  quitting the app hangs every terminal up, and a terminal nobody typed into
  closes itself after 20 idle minutes.
* **A side panel with tabs.** Show a local `.html` or `.md` file or any
  http(s) address next to the terminal. Local files reload themselves when
  they change on disk, so a page Claude is editing updates while you watch.
  Whether the panel is open is remembered **per session**.
* **Agents.** An agent is a name, an emoji, a colour and the folder its
  definition is read from. Start a session as one and its definition goes
  into the system prompt; its emoji then marks every row it ever ran.
* **Fork.** Any conversation can be copied into a *new* terminal, with the
  original left exactly as it was — including a session that is busy
  somewhere else.
* **`clauding open <path or URL>`.** A command on the PATH of every terminal
  the app opens, so the session itself can put a page in the panel. Every
  session is told about it through a preamble appended to its system prompt.
* **Four interface languages**: English, Polski, Español, 简体中文. The app
  follows the system language on first start and remembers what you pick.

![The session list: your own groups, hidden rows, search](docs/screenshots/session-groups.png)

## Screenshots

`docs/screenshots/` holds the two pictures above:
`three-columns.png` (a session with a page open in the panel) and
`session-groups.png` (the list with your own groups, a search and hidden
rows). They are captured with the dev screenshot hook described under
**Dev-only hooks**.

## Requirements

* **macOS 13** or newer.
* **Node.js 22** or newer (`node --version`).
* **Claude Code CLI**, installed and already logged in — the app never asks
  for credentials, it only starts `claude` the way your terminal does. It
  uses `~/.local/bin/claude` when that file exists, otherwise `claude` from
  your PATH.

## Install

```
git clone https://github.com/ula-k/clauding.git
cd clauding
npm install          # also prepares node-pty for Electron
npm run install-app  # builds the renderer and puts Clauding.app in /Applications
```

`npm run install-app` writes a small launcher bundle at
`/Applications/Clauding.app`: an `Info.plist`, the icon, and a zsh script that
starts the Electron binary from *this* checkout with the last `npm run build`
output. There is no second copy of the app, so after changing the code
`npm run build` is enough for the next launch. Run the command again to
update the bundle (it overwrites), `npm run uninstall-app` to remove it.

Launch it from Launchpad, Spotlight or `open -a Clauding`.

## Run from source

```
npm start          # Vite dev server + Electron, with hot reload for the renderer
npm run build      # bundles the renderer into dist/renderer
npm run preview    # Electron loading the built renderer
npm run check      # syntax check + naming rules (no one-letter names, no jargon abbreviations)
npm run rebuild    # compiles node-pty against this Electron (only if the prebuilt binary fails)
```

## How it works, in one page

**What it reads.** Three things kept by the Claude Code CLI, all read-only:
the transcripts under `~/.claude/projects/*` (through
`@anthropic-ai/claude-agent-sdk`: `listSessions`, `getSessionInfo`,
`renameSession`), the per-process registry `~/.claude/sessions/<pid>.json`
and the background-job registry `~/.claude/jobs/<shortId>/state.json`, which
together give the Running / Waiting colours. The app writes nothing under
`~/.claude`; the `claude` processes in its terminals write their own
transcripts, exactly as they do from Terminal.app.

**What it writes**, all in `~/Library/Application Support/Clauding/`:

| File | What is in it |
| --- | --- |
| `groups.json` | your groups, which session is in which, hidden and folded ones |
| `agents.json` | your agents and the session → agent links |
| `panel-tabs.json` | each session's panel tabs and whether its panel is open |
| `preamble.md` | the text appended to every session's system prompt |
| `clauding.sock` | the socket the `clauding` command talks to (mode 0600) |

**The preamble.** `preamble.md` starts as a copy of
`electron/preamble-default.md`: it tells the session it runs inside Clauding,
describes the panel and says to use `clauding open`. Edit it and your version
is kept for good; while it is still byte-identical to a default this app once
shipped (recognised by a SHA-256 in `electron/preamble.js`), a new version
replaces it.

**`--system-prompt-snapshot off`.** Every terminal is started with this flag.
Without it the CLI reuses the system prompt stored with the conversation, so
a resumed session would never see the preamble — and one that had not heard
of the side panel published a claude.ai Artifact instead of opening the page.
With `off` the prompt is rendered fresh on every request, so new sessions,
resumes and forks all get it.

**Why plain JavaScript?** Because this is a small app meant to stay readable
without a build step to explain it: no TypeScript, no type annotations, no
one-letter names and no jargon abbreviations — `npm run check` enforces the
last two.

The rest of this file is the detail: how each part works and why it is built
that way.

## Layout

```
electron/main.js           window, IPC handlers, registry + project watchers, dev hooks
electron/terminals.js      the terminal registry (one pty per terminal, session linking, idle auto-close)
electron/claudeCli.js      where `claude` is, PATH fix-up, the environment the pty gets
electron/panelTabs.js      the right panel's tabs and per-session visibility + panel-tabs.json
electron/commandSocket.js  the Unix socket the `clauding` command talks to
electron/preamble.js       the system-prompt preamble (preamble.md)
electron/preamble-default.md   the default preamble text itself
electron/fileWatch.js      fs.watch helper for auto-reloading local pages
bin/clauding               the `clauding` command put on every terminal's PATH
electron/smokeFolder.js    where the dev smoke runs work (and what the list hides)
electron/smokeTerminal.js  CLAUDING_SMOKE_TERMINAL automation (dev only)
electron/smokeFork.js      CLAUDING_SMOKE_FORK automation for the Fork button (dev only)
electron/smokePreamble.js  CLAUDING_SMOKE_PREAMBLE: the preamble on a resumed session (dev only)
electron/smokeResize.js    CLAUDING_SMOKE_RESIZE: the two drag handles (dev only)
electron/recentProjects.js recent project folders from ~/.claude.json for "+ New"
electron/preload.cjs       contextBridge -> window.clauding
electron/channels.cjs      IPC channel names (shared by main + preload)
electron/sessions.js       listSessions() + enrichment (title, folder label, colour, status, ownership)
electron/sessionGroups.js  the user's own groups + hidden sessions (groups.json)
electron/agents.js         the user's agents + session -> agent links (agents.json)
electron/smokeAgents.js    CLAUDING_SMOKE_AGENTS automation for the agents (dev only)
electron/smokeEmoji.js     CLAUDING_SMOKE_EMOJI: the agent form's emoji field (dev only)
electron/smokeGroups.js    CLAUDING_SMOKE_GROUPS automation for the list (dev only)
electron/smokeCollapse.js  CLAUDING_SMOKE_COLLAPSE automation for folding a group shut (dev only)
electron/liveStatus.js     Running / Waiting derived from ~/.claude registries
electron/projects.js       folder labels ("…/projects/website"), colour index, ~ paths
scripts/prepareNodePty.js  postinstall: makes node-pty usable inside Electron
scripts/start.js           npm start (Vite dev server, then Electron)
scripts/check.js           npm run check
scripts/installApp.js      npm run install-app: the /Applications launcher bundle
scripts/uninstallApp.js    npm run uninstall-app
src/renderer/              React 18 + Vite (JSX), styles/theme.css holds every colour
src/renderer/terminalInstances.js  the xterm.js instances, kept alive outside React
src/renderer/components/TerminalPane.jsx   the visible terminal (fit + focus)
src/renderer/components/MiddleColumn.jsx   header + terminal, or the short note for a session running elsewhere
src/renderer/components/SidePanel.jsx      the right panel: tab strip, toolbar, webview / markdown tabs
src/renderer/components/SessionsColumn.jsx the left column: groups, rows, "+ group", "Hidden (N)"
src/renderer/components/GroupHeader.jsx    one group header: name, count, "+", "…" menu, drop target
src/renderer/components/SessionRow.jsx     one row: status dot, name, right-aligned time, "…" menu
src/renderer/components/PopupMenu.jsx      the "…" menus (fixed position, closes on Escape / outside click)
src/renderer/components/AgentsTab.jsx      the left column's second tab: one row per agent
src/renderer/components/AgentForm.jsx      add / edit an agent (name, emoji, colour, definition folder + file)
src/renderer/components/EmojiPicker.jsx    the built-in emoji list under the form's emoji field
src/renderer/emojiChoices.js       the first-grapheme rule + the 64 curated emoji and their keywords
src/renderer/components/AgentBadge.jsx     the emoji in its coloured circle (rows) and the header chip
src/renderer/agentConstants.js     the eight agent colour tokens and the small label helpers
src/renderer/sessionGrouping.js    sessions + groups.json -> what the column draws
src/renderer/groupConstants.js     the "default" group id and its translated label
src/renderer/i18n.js               translate(), the language list and the system-language mapping
src/renderer/locales/      en.json, pl.json, es.json, zh-CN.json — every UI string goes through translate()
```

The SDK (`@anthropic-ai/claude-agent-sdk`) is only used for reading:
`listSessions` and `getSessionInfo` — and `renameSession` for the editable
title. (`getSessionMessages` went with the read-only preview: the app does
not read a transcript any more.) Nothing under `~/.claude` is written by the app
itself; the `claude` processes in the terminals write their own transcripts
and registry entries, like they do from Terminal.app.

Electron runs as ESM (`"type": "module"`); the preload script is CommonJS
(`electron/preload.cjs`) because Electron loads preload files through its own
loader, and it requires `electron/channels.cjs`, the single list of IPC
channel names.

## Terminal architecture

### The pty (main process, `electron/terminals.js`)

`node-pty` spawns `claude --append-system-prompt <preamble>
--system-prompt-snapshot off` (plus `--resume <sessionId>` for an existing
session, and `--fork-session --name "<title> (fork)"` on top of that for a
fork — see **Fork** below) with:

| | |
| --- | --- |
| `cwd` | the folder picked in "+ New", or the session's own cwd |
| `env` | `process.env` minus the `CLAUDECODE` / `CLAUDE_CODE_*` markers, plus `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Clauding`, `CLAUDING_TERMINAL_ID=<terminal id>` and `<project>/bin` prepended to `PATH` (for the `clauding` command); `LANG` inherited |
| size | the last known xterm size (the pane sends the exact one right after it mounts) |

The preamble is read from `~/Library/Application Support/Clauding/preamble.md`
at every spawn (the file is created with the default text — `electron/preamble-default.md` —
on first use, edit it freely). `--append-system-prompt` is accepted in
interactive mode by CLI 2.1.271 — verified by asking the session what app it
runs inside.

**A terminal running as an agent** gets **one** append instead, holding the
preamble, a line saying who it is, and the agent's whole definition file (see
**Agents**). That is far too much text for a command line argument, so it is
written to `<userData>/prompts/<terminalId>.md` and passed with
`--append-system-prompt-file`, and the file is deleted when the pty exits
(anything left behind by a pty killed on quit is cleared at the next start).
`--append-system-prompt-file` has **no option line of its own** in
`claude --help` — it is only mentioned inside the `--bare` paragraph as
`--append-system-prompt[-file]` — so `claudeCli.js` probes for it once instead
of reading the help: the flag is put in front of the `mcp` subcommand, which
prints its usage and exits at once, and an option the CLI does not know makes
it say "unknown option" first. It exists in CLI 2.1.272 and is what this Mac
uses; without it the same text is passed inline with `--append-system-prompt`.

**Why `--system-prompt-snapshot off`.** By default (`on`) the CLI renders the
system prompt once, on a conversation's **first** request, records it, and
replays that recording on every later request *and every resume* — so a
session that was not born inside Clauding never sees our preamble, however
often it is resumed here. That is exactly what went wrong once: a resumed
session asked to "open it in the panel on the right" published a claude.ai
Artifact, because nothing had ever told it about the side panel or about
`clauding open`. With `off` the prompt is rendered fresh on every request, so
the preamble reaches new sessions, resumes and forks alike. The flag is
documented in `claude --help` (CLI 2.1.272).

**Keeping the stored preamble fresh.** At startup `refreshStoredPreamble()`
compares `preamble.md` with every default this app has ever written. If it is
still byte-identical to one of them it is replaced with the current default
(otherwise sessions would keep an old text forever); if you edited it, it is
left exactly as it is and a line goes into the log saying so.

**Nothing closes a terminal by hand.** There is no "Close terminal" button —
nobody wants to close one. Two things still hang ptys up, both automatic:

* **On quit** `closeAll()` sends SIGHUP to every pty, so no `claude` outlives
  the window (`before-quit` in `electron/main.js`).
* **Idle auto-close.** A terminal that a *click* on the session list opened,
  that never received a keystroke and whose CLI has then sat idle for 20
  minutes is hung up (SIGHUP; the session stays on disk and can be clicked
  again), so browsing the list cannot pile up `claude` processes. Terminals
  from "+ New", and any terminal you typed into, are never touched.

The `CLAUDE_CODE_*` variables are stripped because a Clauding started from
inside a Claude session would otherwise pass them on, and the CLI then treats
itself as a nested child: "Transcript saving is off" and no registry entry
(seen while testing). `process.env.PATH` gets `~/.local/bin`,
`/opt/homebrew/bin` and `/usr/local/bin` prepended at startup because a
Dock-launched app has a minimal PATH.

The registry keeps one record per terminal id: pid, cwd, session id, the
CLI's `busy`/`idle` status, and a bounded replay buffer (400 kB) so a reloaded
renderer can rebuild its xterm from what was printed. Output chunks are joined
and shipped once per ~16 ms (`terminal:data`); input (`terminal:input`) and
resizes (`terminal:resize`) are fire-and-forget messages. The internal
`close()` sends SIGHUP and SIGKILL after 3 s if needed; the transcript stays
on disk.

IPC: `terminal:open`, `terminal:input`, `terminal:resize`, `terminal:list`,
`terminal:replay` (renderer → main) and `terminal:data`, `terminal:exit`,
`terminal:changed` (main → renderer).

### Session linking

Verified with CLI 2.1.270/271: the CLI writes `~/.claude/sessions/<pid>.json`
right after start (`kind: "interactive"`, `entrypoint: "cli"`, `status`
`busy`/`idle`), and node-pty's child pid **is** that pid (the binary does not
re-exec). The registry reads the file named after each terminal's pid — on
every registry change plus a 1 s poll while a terminal is alive — and links
the session id the moment it appears. Fallback after 10 s without a pid file:
a live registry entry with the same cwd that started after the spawn. For
`--resume` the session id is known up front and confirmed the same way (the
CLI keeps the id).

Ownership feeds the session list: `listSessions` rows whose session belongs
to a live terminal get `ownedByApp: true` and `liveStatus.source = "app"`
(the running / waiting-for-you status itself still comes from the CLI's own
registry entry — the same source Terminal.app sessions use). Until the transcript
file exists (written at the first prompt) the renderer shows a placeholder
row built from the terminal record.

### The renderer

`terminalInstances.js` owns the xterm.js objects (`@xterm/xterm` 6 with the
fit and web-links addons), keyed by terminal id and kept for the life of the
app. `TerminalPane` only moves a terminal's wrapper element into the visible
pane and back out, so switching sessions keeps scrollback, cursor and
selection, and terminals that are off screen keep receiving output. xterm is
opened lazily the first time its pane is on screen (opening it in a detached
element measures nothing); output that arrives before that is buffered.

Look: colours are read from `theme.css` tokens (`--terminal-*` for the ANSI
palette, `--text`, `--accent` for the lavender block cursor), font
`"SF Mono", Menlo, monospace` 13 px, 12 px padding, 10 000 lines of
scrollback, translucent surface over the window gradient. Cmd+C / Cmd+V go
through Electron's default Edit menu, which turns them into copy / paste
events on xterm's hidden textarea (selection out, clipboard text in); Cmd+K
clears. Ctrl+C is the interrupt, as in any terminal. Option is left alone so
Polish letters type normally.

What the middle column shows for the selected session:

| state | shown |
| --- | --- |
| a live terminal of this app owns it | that terminal |
| a terminal / job outside the app owns it | a short centred note: title, folder, "This session is running in another terminal or job. Finish it there, then click it here to continue." — and a **Fork** button |
| nobody runs it | a terminal, immediately: the click spawns `claude --resume` in its cwd |

A third, barely visible state ("Opening a terminal…") is on screen for the
few milliseconds before the click's terminal exists, and stays if spawning it
failed — a missing folder, for example, which also raises an alert.

**Clickable links.** URLs in the terminal (`@xterm/addon-web-links`) and
absolute or `~/` paths ending in `.html`, `.htm`, `.md` (a custom xterm link
provider that also handles paths wrapped over several rows) open in the right
panel of that terminal's session on click; Cmd+click hands them to the
system instead (Chrome for URLs, the default app for files).

### node-pty inside Electron

node-pty 1.1.0 ships prebuilt N-API binaries (`prebuilds/darwin-arm64/`), so
it loads in Electron 44 without compiling — but its tarball stores
`spawn-helper` without the execute bit and npm 11 no longer runs the package's
own install scripts, so every spawn failed with `posix_spawnp failed` until
the bit was set. `scripts/prepareNodePty.js` (the `postinstall`) sets it and
then requires node-pty inside Electron (`ELECTRON_RUN_AS_NODE=1`) to prove the
binary matches; if that fails it runs `electron-rebuild --only node-pty`
automatically. `npm run rebuild` forces that compile (needs the Xcode command
line tools; takes about a minute). Both paths were verified on this Mac.

## Fork

Claude Code can fork a conversation, but a fork in one window would replace
what is on screen. Here it opens a **second terminal**: the copy takes over
the middle column, **the original keeps running, untouched**, and both rows
sit in the list.

A **Fork** button lives in the terminal header, right of the status pill
(tooltip: *"Start a copy of this conversation in a new terminal; this one
stays as it is."*). It appears as soon as the terminal has a session id. The
same button is on the note for a session running in a terminal or job
**outside** the app — forking is the one useful thing that can be done with
such a session, so that note is not a dead end any more.

The click spawns a new pty in the **original session's own folder** (the
fork's transcript lands under the cwd the command starts in, so this matters):

```
claude --resume <sessionId> --fork-session --name "<original title> (fork)" --append-system-prompt <preamble> --system-prompt-snapshot off
```

plus the same environment every Clauding terminal gets (`CLAUDING_TERMINAL_ID`,
`bin/` on `PATH`, the `CLAUDE_CODE_*` markers stripped).

* `--fork-session` gives the copy a **new session id**; the original
  transcript file is not modified.
* `--name` sets the CLI's display name, so the new row reads
  `<original title> (fork)` straight away — the suffix is deliberately not
  translated, because it is stored in the session, not redrawn by the app.
* The terminal record therefore starts with **no** session id (it must not
  claim the original's) and waits for the CLI to register the new one, the
  same linking path every terminal uses.
* **Group rule.** The moment the fork's session id is known it is put into
  the **same group as the original** (`assignSession`, the same mechanism a
  group header's `+` uses). Nothing else is copied: not the panel tabs, not
  the hidden flag.

**Forking a session that is busy.** Allowed, and no different: the fork gets
whatever is on disk at that moment. Verified on CLI 2.1.272 by making a
scratch session count slowly and pressing Fork mid-count: **the CLI printed no
warning and asked nothing** — the fork started at its prompt with the whole
conversation including the pending question ("Count out loud from 1 to 40…")
but, of course, without the answer the original was still writing. The
original kept counting in its own terminal. So there is nothing to pre-answer
and no prompt to pass through; the only thing to know is that a fork taken
mid-turn stops one message short.

## The right panel (`SidePanel.jsx`, `electron/panelTabs.js`)

Hidden by default; "Show panel" / "Hide panel" in the middle column's header,
`clauding panel show|hide` from a session, and a drag handle on its left edge
for the width.

**Open or closed is per session, the width is not.** Whether the panel is up
is stored as `panelVisible` next to that session's tabs in `panel-tabs.json`,
so one session can sit next to a page while the next one shows only its
terminal, and switching between them puts each panel back the way it was —
across restarts too. The rules:

* a session with no flag of its own **follows its tabs**: visible when it has
  some, hidden when it has none;
* "Show panel" / "Hide panel" and `clauding panel show|hide` write the flag
  for **that one session** — the command for the session it was run from,
  never for the window;
* `clauding open` (and the address field) sets it to visible for the session
  the tab belongs to, which is what makes a page appear as it is opened;
* with no session selected at all the button still works, it just has nowhere
  to write the flag, so that state is not remembered.

The **width** is one setting for the whole window (`localStorage`), because a
column that changed size on every click would be unusable.

**Dragging a handle** (both the left one and the panel's) uses pointer
events, not mouse events: the handle takes `setPointerCapture`, the window
listens for `pointermove` / `pointerup`, and for the length of the drag a
transparent `.drag-overlay` (fixed, `inset: 0`, above everything) covers the
window while the panel's `<webview>` stops taking pointer events. Without
that, the pointer crossing into the page — which is what narrowing the panel
does — hands the events to the guest process and the drag stops halfway.
Widths are clamped so the terminal keeps at least 480 px: the panel between
280 px and `window width − left column − 480 px`, the left column between
240 px and 480 px in the same way. The clamp also runs **on load and on
window resize**, because a width stored while the window was bigger used to
push the handle off screen, and then the panel could not be moved at all.

A **tab strip** at the top, one tab per page: a local **HTML** file
(`file://`), a local **Markdown** file, or an **http(s) URL**; the "+" tab is
an address field (paste a path or URL, Enter opens it; relative paths resolve
against the session's folder there, against the caller's cwd from `clauding open`).
Tab header: icon by type, short title (file name for files, the document
`<title>` for web pages once it arrives), close ×. Toolbar under the strip:
the address (click copies it), **Reload**, **Open in Chrome**
(`shell.openExternal` for URLs, `shell.openPath` for files), **Hide panel**.

Tabs are **per session**: switching sessions swaps the tab set, and the sets
live in `~/Library/Application Support/Clauding/panel-tabs.json` keyed by
session id, so a session's tabs come back after an app restart (and after the
terminal was closed and the session resumed later). A terminal whose CLI has
not registered its session yet keeps its tabs under `terminal:<id>` and they
move to the session id the moment it is known.

**Rendering.** HTML files and URLs render in an Electron `<webview>` (rather
than a `WebContentsView`: the webview lives in the renderer's DOM, so the tab
strip, the resizable width and per-session mounting are plain React/CSS; a
`WebContentsView` would have to be positioned from the main process on every
layout change). Every webview is locked down in `will-attach-webview`: no
preload, `nodeIntegration` off, `contextIsolation` and `sandbox` on, its own
`persist:clauding-panel` partition, only `file:`, `http:` and `https:` sources,
and `window.open` from inside a page goes to the system browser. Markdown
renders through the `marked` + `highlight.js` pipeline of `markdown.js`, in a
scrollable reading view: serif ("Iowan Old Style", Palatino,
Georgia) 17 px, line-height 1.7, max-width 46 rem centred, dark palette.

**Auto-reload.** Local files open in a tab are watched (`fs.watch` on the
parent folder filtered by file name, so editors that save through a rename
still count; debounced 300 ms) and the tab reloads — Claude edits the page,
you see it.

Electron 44 quirk: removing a `<webview>` from the DOM (closing a tab,
switching sessions) throws a harmless "Invalid guestInstanceId" from the
element's own `disconnectedCallback` (the guest is already gone by then);
`main.jsx` swallows that one message.

## The `clauding` command and the preamble

`bin/clauding` (`#!/usr/bin/env node`) is on the PATH of every terminal the
app opens:

```
clauding open <path or URL>     open a tab in the right panel (relative paths: against the caller's cwd)
clauding panel show|hide        show or hide the panel
clauding tabs                   list this session's tabs ("*" marks the active one)
```

It sends one JSON line to the app's Unix domain socket at
`~/Library/Application Support/Clauding/clauding.sock` (`net.createServer` in
the main process, socket file chmod 0600 so only the same user can connect;
newline-delimited JSON both ways: `{command, target, terminalId, cwd}` in,
`{ok: true, message}` or `{ok: false, error}` out), prints the one-line
answer and exits 0 — or exits 1 when it cannot be done.
`CLAUDING_TERMINAL_ID` from the pty environment tells the app which session's
tab set the command targets.

**Which session a command lands in.** The caller's own terminal first. But
the variable is not always there — a plain shell, a subagent, a terminal the
app has forgotten — so the app then falls back, in this order, to:

1. the **session on screen** (the renderer reports the selected pane to the
   main process on every change: channel `panel:selection`);
2. the **terminal that was focused or typed into most recently**;
3. nothing — only then does the command fail, with "This terminal is not
   known to the app (CLAUDING_TERMINAL_ID missing or stale)."

The confirmation line says which one was used, so an agent cannot guess
wrong: `Opened /path/page.html in the Clauding panel.` from its own terminal,
`Opened /path/page.html in the Clauding panel (current session).` or
`(most recent terminal)` from a fallback. Every failure has one shape:
`clauding: could not open — <reason>` (and `could not change the panel` /
`could not list the tabs`), on stderr, exit code 1.

The default preamble (`preamble.md`, from `electron/preamble-default.md`)
tells the session it runs inside Clauding, describes the panel, and says to
use `clauding open` whenever the user asks for something "on the right" /
"po prawej" / "a la derecha" or after creating an HTML / Markdown page for
the user to look at. It also says, in as many words, that a **claude.ai
Artifact is not the side panel** and that `ctrl+]` is not the answer either —
both mistakes a session actually made.

## The session list: your groups, a colour, and hiding

The left column has two tabs: **Sessions** (everything below) and **Agents**
(see the section above).

The left column looks like the Claude Code agents view: **one line per
session, the name and nothing else**, a small status dot on the left and a
dim relative time on the right. The folder is in the tooltip, not on a second
line. The search box still matches the folder and the first prompt under the
hood, so typing "blueprint" finds a session in that folder.

**Status is a colour, not a group.** Three tokens in `theme.css` decide it and
nothing else does — change them there and the whole list follows:

| token | meaning | today |
| --- | --- | --- |
| `--status-working` | the CLI is busy | light lavender (`--secondary`) |
| `--status-waiting` | waiting for you / needs an answer | dusty gold (`--gold`) |
| `--status-idle` | not running | `--text-faint` |

The only words on a row besides the name are the small **needs answer** badge,
and only when a job actually reports that it is blocked on something.

### Groups (`electron/sessionGroups.js`, `~/Library/Application Support/Clauding/groups.json`)

The grouping is the user's, never derived from anything:

```json
{
  "version": 1,
  "groups": [
    { "id": "default", "name": null, "order": 0 },
    { "id": "<uuid>", "name": "Website", "order": 1 }
  ],
  "membership": { "<sessionId>": "<groupId>" },
  "hidden": ["<sessionId>"],
  "collapsed": ["<groupId>"]
}
```

* The **`default`** group always exists and cannot be deleted; any session
  with no entry in `membership` belongs to it. Its `name` stays `null` so the
  header prints the translated label ("Default" / "Domyślna" / "Predeterminado");
  renaming it stores a real name, and that name wins from then on.
* `order` is simply the position in the array — groups render in that order,
  and an empty group shows a faint *empty* line rather than disappearing.
* Inside a group the running rows come first, then the rest by last activity.
* A group that is deleted takes nothing with it: its sessions go back to
  Default, after a confirmation inside the menu.
* Anything unexpected in the file is dropped when it is read — a broken
  groups.json can never keep the list from rendering.

**Managing them.** A `＋ group` button at the bottom of the list (type the name,
Enter). Each header shows, on hover, a `+` (new session in *this* group: the
folder sheet opens and the session joins the group as soon as its CLI
registers a session id) and a `…` menu with **Rename**, **Move up**,
**Move down** and **Delete group**. Each row has a `…` menu (and a right-click)
with **Move to** ▸ the groups, **Rename session** (the SDK rename) and
**Hide**. A row can also be **dragged onto a group header** (HTML5 drag and
drop). Sessions started with the top "+ New" land in Default.

**Collapsing.** Every header (Default included) has a **chevron** on the left:
it folds the group shut, and `collapsed` in groups.json remembers which ones
are folded — a group called "PRIV" stays shut across restarts, so screen
sharing shows nothing of it. Default is *expanded*: a group not named in
`collapsed` is open, and an older groups.json without the field simply has
everything open.

* A collapsed group is **only its header**: the name, the count, and — so
  nothing important is missed — a small **needs answer** badge if any session
  inside is waiting for one, and a subtle **running dot** if any is busy.
* **Search wins over collapsing.** While a query is typed every group is
  drawn open, so a match is never hidden behind a chevron. That is a render
  decision only; nothing is written back to groups.json.
* The header stays a **drop target**: a row dragged onto a collapsed header
  joins that group like any other.
* Collapsing changes nothing else — membership, hiding and status are
  untouched, and deleting a group also drops it from `collapsed`.

**Hiding.** `hidden` only lists session ids; the group membership is
untouched, so unhiding puts a session back exactly where it was. Hidden
sessions leave the groups and are counted on one collapsed line at the very
bottom — **Hidden (N)** — which expands into plain rows with an **Unhide**
button each. A hidden session whose CLI the registry shows as **busy** again
(or that one of our terminals picks up) is unhidden automatically:
`syncHiddenWithLiveStatus()` in `main.js` runs on every registry change.

IPC: `groups:get`, `groups:create`, `groups:rename`, `groups:move`,
`groups:delete`, `groups:assign`, `groups:set-hidden`, `groups:set-collapsed`
(renderer → main) and `groups:changed` (main → renderer, the whole state
after every write).

## Agents

An **agent** is your own: a **name**, an **emoji**, a **colour** and a
**definition folder** — the folder the agent reads *itself* from, which is
never the folder it works in. The working folder is picked per session in
"+ New"; the agent is a second, optional choice next to it.

### The store (`electron/agents.js`, `~/Library/Application Support/Clauding/agents.json`)

```json
{
  "version": 1,
  "agents": [
    {
      "id": "<uuid>",
      "name": "Spec Writer",
      "emoji": "📐",
      "color": "--project-color-2",
      "definitionFolder": "/Users/<you>/Documents/agents/spec-writer",
      "definitionFile": "/Users/<you>/Documents/agents/spec-writer/spec-writer.md",
      "lastWorkingDirectory": "/Users/<you>/Documents/projects/website"
    }
  ],
  "sessionAgents": { "<sessionId>": "<agentId>" }
}
```

* `color` is the **name of a token in theme.css**, never a hex value, so the
  palette stays in one place; the form offers eight of them
  (`--project-color-0` … `-7`, the same swatches the project dots use).
* `definitionFile` always lies inside `definitionFolder`; a stored path that
  wandered off is dropped when the file is read, exactly like groups.json —
  anything unexpected in agents.json is sanitized away rather than crashing
  the app.
* `sessionAgents` is what keeps the badge on a row long after the terminal is
  gone. Deleting an agent also drops every link to it.
* `lastWorkingDirectory` is written every time a session starts with that
  agent, and is what the "+ New" sheet preselects next time it is picked.

### Adding one

The **Agents** tab (the left column's second tab) lists them: the emoji in a
circle of the agent's colour, the name, and the dim definition folder
(`…/agents/spec-writer`). A **"…"** menu has **Edit** and **Delete** (with a
confirmation inside the menu); **clicking the row** opens the "+ New" sheet
with that agent already picked.

**"+ Add agent"** opens the form. Picking the definition folder fills in the
rest, following the usual convention: the `.md` whose basename is the
folder's name (`agents/spec-writer/spec-writer.md`), else `README.md`, else
the only `.md` there is. The **name** comes from that file's first `# `
heading with an `Agent:` prefix removed ("# Agent: Spec Writer" → "Spec
Writer"), the **emoji** from the first emoji in the file (or `✦`), and a
**select** lists the folder's other top-level `.md` files. Everything is
editable; the name and emoji are only re-suggested while you have not typed
a name of your own.

#### The emoji field

Three ways in, because typing an emoji is the one thing a text field is bad
at:

* **Paste or type** into the field. Whatever arrives — "✅ Test", a whole
  sentence, an emoji with a skin tone — only its **first grapheme cluster**
  is kept (`Intl.Segmenter`, falling back to `Array.from(text)[0]`), so
  "🧑‍💻" and "👩🏽‍🔬" survive in one piece. The field deliberately has **no
  `maxLength`**: a limit of 1 cuts an emoji in half, because they are two or
  more code units. The same rule runs again in `electron/agents.js` before
  anything is written to agents.json (an empty field becomes `✦`).
* **🙂** next to the field focuses it and opens the **native macOS panel**
  (`app.showEmojiPanel()` over `system:emoji-panel`, guarded by
  `app.isEmojiPanelSupported()`), the same palette ⌃⌘Space opens; it types
  into whatever has focus, which is why the field is focused first.
* **▦** opens a **built-in list** under the field: 64 emoji in five rows
  (work, tools, people, symbols, nature) with a search box matching an
  English keyword list embedded in `emojiChoices.js` — no emoji library.
  Escape or a click outside closes the list (and only the list; the form
  stays open).

Under the field a hint says "Paste, type, or press ⌃⌘Space".

### Starting a session as an agent

The "+ New" sheet has **Agent** under the folder list: "No agent" (always the
default — the sheet never remembers an agent by itself), each agent with its
emoji, and "Add agent…" at the bottom, which swaps the sheet for the form and
brings the sheet back with the new agent selected. Choosing an agent that has
worked somewhere before moves the folder selection to its
`lastWorkingDirectory`.

The terminal then gets the single combined append described above:

```
<Clauding preamble>

---

You are running as the agent "<name>". Your full definition follows; follow it.
It lives at <definitionFile>; its folder <definitionFolder> holds your working files.

<the definition file>
```

and `--name "<emoji> <agent name>"` unless a name was already given (a fork's
`--name` wins), so the CLI's own header says who is working too.

**Linking.** The moment the CLI registers a session id (the same linking path
every terminal uses), `sessionAgents[sessionId]` is written. A **fork**
inherits the original's agent: the same definition in its prompt and the same
badge on its row.

### Where it shows

* **Session rows**: the agent's emoji in a small circle in its colour,
  between the status dot and the name; the tooltip is the agent's name. The
  name printed on the row drops the emoji the CLI put in front of it, so it
  is not shown twice. Rows without an agent are exactly as they were.
* **Terminal header**: an `emoji name` chip in the agent's colour next to the
  title.
* **Search** matches the agent name too, so typing "spec" finds everything
  the Spec Writer ran.
* **Under the agent's own row** (Agents tab): every session that agent
  started, as sub-rows that look and behave like a row in the Sessions list
  — status dot, name, right-aligned time, and a click that selects the
  session and opens its terminal exactly the same way. The agent's name gets
  a count next to it ("Spec Writer · 3"); clicking the agent row itself
  still opens "+ New" with that agent picked.

  A session belongs to the list when `sessionAgents` links it **or** when the
  terminal it runs in was started as that agent, so a session just started
  appears before the CLI has registered its id. The order is the list's own:
  running first, then by last activity. Sessions you have **hidden** in
  groups.json are left out and counted on one faint line ("+1 hidden").
  Only sessions started from now on have a link — older ones never had one,
  and that is fine.

  **The links are resolved by id, not looked up in the list on screen.** The
  Sessions column holds one page (60 rows) until you press "Show more", so an
  agent's older work would simply be missing underneath it. Instead the main
  process reads every id in `sessionAgents` with the SDK's `getSessionInfo`
  (`agents:linked-sessions`), caches the rows and throws the cache away
  whenever the sessions change, and the renderer merges what comes back with
  the rows it already has. A link whose session is **not on disk** is left
  out without a word — a terminal closed before its first message leaves a
  link but no transcript, because the CLI only writes one once there is
  something to write. The link itself stays in `agents.json`; it is harmless.

  Scratch sessions (the smoke folder and `~/.claude/jobs/<shortId>/tmp/…`,
  see below) are dropped from the session list itself and from the resolved
  links, so they do not appear under an agent either: a smoke run's
  conversations stay out of both places.

## Scratch sessions are never listed

`listSessionsPage()` drops every session whose `cwd` is a scratch folder,
because those conversations are test noise, not sessions worth finding
again. Two folders count (`isScratchWorkingDirectory` in
`electron/sessions.js`):

* the app's **own smoke folder** — `$TMPDIR/clauding-smoke` by default,
  `CLAUDING_SMOKE_FOLDER` (or `CLAUDING_SMOKE_WORKING_DIRECTORY`) when set,
  all resolved in one place, `electron/smokeFolder.js`, so the filter always
  follows the folder the smoke runs actually use;
* a background job's throw-away folder, `~/.claude/jobs/<shortId>/tmp/…`.

A *live* terminal of the app in such a folder still gets its row — that row
comes from the terminal registry, not from the listing — so a smoke run can
still be watched while it happens.

## Live status: what is read and how it is mapped

Two registries kept by the Claude Code CLI are read (never written):

### `~/.claude/sessions/<pid>.json` — one file per running CLI process

Fields observed (CLI 2.1.270): `pid`, `sessionId`, `cwd`, `startedAt`,
`procStart`, `version`, `kind` (`"bg"`), `entrypoint` (`"cli"`), `name`,
`nameSource`, `jobId`, `status`, `statusUpdatedAt`, `updatedAt`,
`messagingSocketPath`, `peerProtocol`, `peerFeatures`.

`status` values observed: `"busy"` and `"idle"`.

The pid is verified with `process.kill(pid, 0)`; files whose process is gone
are ignored (stale files do linger).

| process alive and `status` | row colour |
| --- | --- |
| `busy` (also accepted: `working`, `running`) | working (`--status-working`) |
| `idle` or anything else | waiting for you (`--status-waiting`) |

### `~/.claude/jobs/<shortId>/state.json` — background jobs

Fields observed: `state`, `tempo`, `detail`, `needs`, `sessionId`,
`resumeSessionId`, `cwd`, `originCwd`, `name`, `nameSource`, `intent`,
`backend` (`"daemon"`), `cliVersion`, `createdAt`, `updatedAt`,
`firstTerminalAt`, `respawnFlags`, `linkScanPath`, `output`, `fan`, `inFlight`,
`tokens`, `suggestedReply`. There is no `displayIntent` on this machine
(`intent` is used instead) and no pid.

`state` values observed: `working`, `blocked`, `done`, `stopped`.
`tempo` values observed: `active`, `idle`, `blocked`.

| `state` | row colour |
| --- | --- |
| `working` (also accepted: `active`, `running`) | working (`--status-working`) |
| `idle`, `blocked` (also accepted: `waiting`) | waiting for you (`--status-waiting`) |
| `done`, `stopped`, anything else | idle (`--status-idle`) |

A job that reports `needs`, or `state: "blocked"`, also gets the small
**needs answer** badge on its row — the only place the list spells a status
out in words.

A job is matched to a session by both `sessionId` and `resumeSessionId`
(they differ when a job was resumed into a new transcript).

A verified live process entry wins over the job state for the same session
(example seen: job `state: "done"` while its process still sat `idle` — it
shows as waiting for you, which is what the terminal shows too).

Both registries are watched with `fs.watch` (debounced 300 ms) plus a 15 s
heartbeat that re-checks pids, because a process can die without touching a
file. `~/.claude/projects/*` is also watched (debounced 1 s) so new sessions and
fresh `lastModified` times appear without a reload.

## Dev-only hooks

Everything below only runs when the environment variable is set, and every
smoke run works in one throw-away folder — `$TMPDIR/clauding-smoke` unless
`CLAUDING_SMOKE_FOLDER` says otherwise, never in this repository and never in
a project of yours. The smoke runs marked as such spawn `claude` for real and
cost a few cents; the rest drive the interface only. Their sessions are kept
out of the app's own list (see **Scratch sessions are never listed**).

```
CLAUDING_SCREENSHOT=/path/out.png npm run preview        # capture after ~4 s and quit
CLAUDING_SCREENSHOT_SELECT=elsewhere ...                 # click the first row running outside the app
CLAUDING_SCREENSHOT_NEW=1 ...                            # open the "+ New" sheet first
CLAUDING_SCREENSHOT_CLICK='[data-agents-tab]>>[data-add-agent]' ...
                                                         # click these selectors in order first
                                                         # (a tab, a sheet, a menu item), so any
                                                         # state can be photographed without a
                                                         # smoke run of its own

CLAUDING_SMOKE_EMOJI=1 CLAUDING_SMOKE_FOLDER=/some/folder npm run preview
    the agent form's emoji field, without spawning a single `claude`: opens
    the Agents tab and "+ Add agent", asks the main process for the native
    emoji panel (and prints whether this Electron supports one), pastes
    "✅ Test", "🧑‍💻 developer", "👩🏽‍🔬" and "📐" into the field with
    webContents.insertText and checks only the first whole emoji is kept,
    then opens the built-in list, searches it, picks the rocket and checks
    Escape closes the list but not the form -> emoji-field.png.

CLAUDING_SMOKE_GROUPS=1 CLAUDING_SMOKE_FOLDER=/some/folder npm run preview
    the stage 5 list, without spawning a single `claude`: makes the group
    "Website" through the real store, moves two sessions into it, hides two
    others -> stage5-list.png (with the search box narrowed so both groups and
    the "Hidden (N)" line fit) and stage5-list-full.png; opens a row's "…"
    menu -> stage5-menu.png; clicks a session running outside the app and
    reads the note back -> stage5-elsewhere.png; then drives the group
    management through the UI — "+ group", the header menu's Move down
    (stage5-group-menu.png; a new group opens at the top, so Move up is the
    greyed-out one), a drag and drop onto the header, Delete group
    with its confirmation — and checks the store after each; reloads the
    renderer and checks groups / membership / hidden survived; hides a session
    the registry shows as busy and checks it comes back by itself; unhides
    what it borrowed. On failure: stage5-failed.png.

CLAUDING_SMOKE_TERMINAL=1 CLAUDING_SMOKE_FOLDER=/some/folder npm run preview
    opens a terminal in a scratch folder (NEVER this repository — a smoke
    session pointed at it once edited the app's own code; override with
    CLAUDING_SMOKE_WORKING_DIRECTORY), waits for the prompt (answers the CLI's
    trust dialog with Yes if it appears), asks the CLI to run
    `clauding open <the scratch page>` and reply "pong"
    (answers a permission prompt with Yes if one appears) -> stage4-panel.png;
    runs bin/clauding itself to open a Markdown file (stage4-md.png) and
    https://example.com/ (stage4-url.png); asks the CLI what app it runs
    inside and prints the tail of the answer; switches
    sessions and back, reloads the renderer (stage4-reloaded.png); /exit;
    then clicks the session's row and checks the click alone resumed the same
    session id (stage4-click.png); /exit, quits. On failure: stage4-failed.png.
    Overrides: CLAUDING_SMOKE_PAGE, CLAUDING_SMOKE_MARKDOWN, CLAUDING_SMOKE_URL.

CLAUDING_SMOKE_COLLAPSE=1 CLAUDING_SMOKE_FOLDER=/some/folder npm run preview
    folding a group shut, without spawning a single `claude`: makes (or
    reuses) a group named PRIV (CLAUDING_SMOKE_GROUP_NAME), moves a session
    that needs an answer and a busy one into it, clicks the header's chevron
    and checks the store, that no row of that group is drawn any more and
    that the header carries the badge and the running dot -> groups-collapsed.png;
    types a search word and checks the match inside the collapsed group shows
    again without changing the stored state -> groups-collapsed-search.png;
    drops a row on the collapsed header; reloads the renderer and checks the
    group is still collapsed; opens it again from the UI -> groups-expanded.png.
    Puts every borrowed row back and removes a group it created.
    On failure: groups-collapsed-failed.png.

CLAUDING_SMOKE_PREAMBLE=1 CLAUDING_SMOKE_FOLDER=/some/folder npm run preview
    the preamble on a **resumed** session, in the scratch folder only
    (CLAUDING_SMOKE_WORKING_DIRECTORY): opens a brand-new terminal, asks what
    app it runs inside and which command opens a file on the right, prints
    the answer -> preamble-new.png; /exit; clicks the session's row so the
    real click path resumes it and asks exactly the same question again (this
    is the one that was broken before --system-prompt-snapshot off); then
    runs bin/clauding from an environment with no CLAUDING_TERMINAL_ID and
    checks the tab lands in the panel of the session on screen
    -> preamble-resume.png. On failure: preamble-failed.png.
    Override the page it opens with CLAUDING_SMOKE_PLAN_PAGE.

CLAUDING_SMOKE_RESIZE=1 CLAUDING_SMOKE_FOLDER=/some/folder npm run preview
    the two drag handles, without spawning a single `claude`: stores a panel
    width from a bigger window and reloads (the width must come back inside
    the clamp), borrows a session that runs outside the app, opens a page in
    its panel, then drags the panel handle right (narrower — the direction
    that crosses the <webview>) -> panel-resize.png, left (wider), and the
    left column's handle, checking the width after each. Puts the stored
    widths and the borrowed tab back. On failure: panel-resize-failed.png.
    Note: `webContents.sendInputEvent` drags do **not** reproduce the guest
    swallowing the pointer (the browser process keeps routing the drag to the
    embedder), so this hook proves the clamp and that both directions work —
    not the overlay itself.

CLAUDING_SMOKE_AGENTS=1 CLAUDING_SMOKE_FOLDER=/some/folder npm run preview
    the agents, in the scratch folder only (CLAUDING_SMOKE_WORKING_DIRECTORY):
    inspects a definition folder (CLAUDING_SMOKE_AGENT_FOLDER; by default a
    small example definition written into the scratch folder) and checks the
    suggested .md file and the name taken from its heading; adds that agent
    through the real store and photographs the Agents tab -> agents-list.png;
    opens the row menu's Edit form -> agents-form.png; clicks the row so the
    "+ New" sheet opens with the agent preselected -> agents-new.png; starts
    a real session as the agent, asks it who it is and where its definition
    lives, prints the answer, and checks sessionAgents, lastWorkingDirectory,
    the badge on the row and the chip in the header -> agents-session.png.
    Exits the terminal and deletes the agent it added.
    On failure: agents-failed.png.

CLAUDING_SMOKE_FORK=1 CLAUDING_SMOKE_FOLDER=/some/folder npm run preview
    the Fork button, in the scratch folder only: opens a terminal, gets a
    "pong" out of it, puts that session in a group of its own, then presses
    the real Fork button in the header ([data-fork-button], so the whole
    renderer -> IPC -> registry path runs). Checks the fork got a new session
    id, that the original terminal is still alive, that the copy carries the
    conversation and that it landed in the original's group -> fork-both.png;
    clicks the original row again and checks its scrollback -> fork-original.png;
    finally makes the original busy (counting slowly), forks it mid-count and
    prints the fork's output tail so any CLI warning about the session being
    in use would show -> fork-busy.png. Exits every terminal and deletes the
    group it borrowed. On failure: fork-failed.png.
```

## License

MIT — see [LICENSE](LICENSE). Clauding is not affiliated with Anthropic; it
is a window around the Claude Code CLI, which you install and log into
yourself.
