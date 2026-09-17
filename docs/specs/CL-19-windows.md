# CL-19 · Windows
Priority: P2 · Verified by: dry test `test/platform.test.js` + CI on `windows-latest` + manual (nobody has run it yet)

## Goal
The same app on Windows 10/11: the session list is filled from the CLI's own
registries under `%USERPROFILE%\.claude`, a click opens a real terminal
running `claude` through ConPTY, the `clauding` command reaches the app over
a named pipe, and `npm run install-app` leaves a launcher and a Start Menu
entry that run this checkout. macOS behaves exactly as it did before.

## Preconditions
- Windows 10 or 11, 64-bit, Node 22, Git.
- Claude Code for Windows installed and already logged in.
- A clean `git clone` of this repository, `npm install`, `npm run install-app`.

## Steps
1. Start the app from the Start Menu.
2. Look at the session list: names, folder labels, the status colors.
3. Click a row that is not running anywhere. Type something and read the reply.
4. Ask the session to run `clauding open <some .md file>` and watch the panel.
5. Press Ctrl+Backspace on a selected row, then again on the hidden row.
6. Open the Agents tab and "+ Add agent"; look at the emoji field.
7. Open the menu bar: Clauding, Edit, Skills, View, Window.
8. Clauding → Check for new version….
9. `npm run uninstall-app`.

## Expected state
- The list is the same list: one line per session, a color for the status,
  `…\projects\website` as the folder label.
- The click opens a terminal, the CLI draws normally and the row turns into
  an owned session (the terminal, not the "running elsewhere" note).
- `clauding open` answers with one line and the page appears in the panel.
- Ctrl+Backspace hides the session; on the hidden row it asks before deleting.
- The emoji field has the grid button but no 🙂 button, and the hint names
  Win+. — there is no Electron call for the Windows picker.
- The menu bar is inside the window, with the same five menus; the Clauding
  menu has About, the version check, Settings… (Ctrl+,) and Quit, and none of
  the macOS-only Services / Hide / Hide Others / Show All.
- The version check runs `git fetch` and, if it offers an update, the four
  commands with `npm.cmd`.
- Uninstalling removes `%LOCALAPPDATA%\Programs\Clauding\` and the Start Menu
  shortcut, and nothing else.

## Evidence
- `test/platform.test.js` — every Windows branch, exercised on macOS with
  `platform: "win32"` injected:
  - "the Claude Code registries are the same folders under a Windows home",
    "the app's data folder follows each system's own convention",
    "a home path is shortened with the separator its own system uses",
    "a Windows working directory gets the same kind of folder label as a Mac
    one", "a background job's scratch folder is hidden on either system".
  - "the Windows lookup order, one step at a time" and "CLAUDING_CLAUDE_BIN
    wins over everything, on both systems" — `claude.exe`, then `claude.cmd`,
    then PATH.
  - "a .cmd is spawned through the command interpreter, an .exe is not",
    "a Windows pty asks for ConPTY and a macOS one asks for nothing".
  - "Windows gets a named pipe, macOS a socket file", "the pipe name is
    stable for one data folder and different for another".
  - "the modifier is ⌘ on macOS and Ctrl on Windows, and never both",
    "Ctrl+C stays the interrupt on Windows, while ⌘C is the menu's copy on
    macOS", "only macOS has an emoji panel Electron can open".
  - "the Windows menu bar has the same menus, without the macOS-only roles".
  - "the Windows install plan names every file it would write", "the launcher
    runs the checkout, and carries no code of the app", "the Start Menu
    shortcut is made by PowerShell, with our icon and a quoted path".
- `test/sessions.test.js` — "a Windows working directory is read the same way".
- `test/skillsScan.test.js` — "on Windows the scan looks where a Windows
  machine keeps skills".
- `test/installApp.test.js` — "the Windows install is a different thing
  entirely, and never names /Applications".
- CI, `.github/workflows/test.yml`: the whole suite plus `npm run check` and
  `npm run build` on `windows-latest`, and `node scripts/checkNodePty.js` —
  node-pty loads, opens a ConPTY pty and gets `ok` back out of `cmd.exe`.
- Manual, steps 1–9, with screenshots. **Not done yet.**

## Out of scope
- The dev hooks: the screenshot hook and every `CLAUDING_SMOKE_*` run stay
  macOS-only by design and say so on Windows.
- Linux.
- Signing or an installer package: `npm run install-app` writes a launcher,
  not an `.msi`.

## What the dry tests do not prove
- That ConPTY carries a full-screen CLI faithfully — the resize handshake and
  the alternate screen buffer are only exercised by a real session.
- That session linking works. It relies on node-pty's child pid being the pid
  the CLI registers under; through `cmd.exe /c` that is the interpreter's pid,
  and only the folder fallback would save it. Pointing `CLAUDING_CLAUDE_BIN`
  at `claude.exe` avoids the wrapper.
- That hanging a terminal up ends `claude` cleanly without signals.
- That Claude Code for Windows really writes the same registry files with the
  same fields; the whole list depends on it (see
  `electron/lib/platformPaths.js`).
- That PowerShell is allowed to create the shortcut on a locked-down machine.
