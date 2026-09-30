// The two decisions the terminal makes that depend on the system it runs on,
// kept apart from terminalInstances.js so they can be checked without xterm,
// without a DOM and without loading a stylesheet.
import { commandKeyPressed, isWindowsPlatform } from "./platform.js";

// Paths to pages the right panel can show, as the CLI prints them:
//   /Users/me/notes/plan.md         an absolute macOS path
//   ~/notes/plan.md                 the same, shortened
//   C:\Users\me\notes\plan.md       an absolute Windows path
//   file:///C:/Users/me/plan.html   and either of them as a file URL
// The Windows alternatives come first, so a drive letter is never read as a
// URL scheme; `describeTarget` in electron/panelTabs.js turns whichever
// matched into a tab. A fresh object every time: a global regular expression
// carries its own lastIndex.
export function localPagePattern() {
  return /(?<![\w:/.-])(?:file:\/\/\/[A-Za-z]:\/[^\s"'`<>()[\]|]*?|[A-Za-z]:[\\/][^\s"'`<>()[\]|]*?|(?:~|\/)[^\s"'`<>()[\]|]*?)\.(?:html?|md|markdown)\b/g;
}

// Cmd+K clears like in Terminal.app. Cmd+C / Cmd+V are left to the
// application menu, whose accelerators beat anything handled here anyway:
// Cmd+C becomes a copy event on xterm's hidden textarea (selection out), and
// Cmd+V is Clauding's own paste in the main process — a file on the clipboard
// types its path, anything else comes back as the ordinary paste event xterm
// has always handled (electron/pasteSmart.js). Ctrl+V is untouched and goes
// through to the CLI, which pastes a raw clipboard image itself.
//
// On Windows the modifier is Ctrl — but Ctrl+C there has to stay the
// interrupt, the way it is in every Windows console, so only Ctrl+K and
// Ctrl+V are taken and everything else goes through to the CLI. Copying is a
// selection plus the Edit menu.
//
// Ctrl+Z never reaches the CLI. Claude Code binds it to "suspend": it stops
// itself and says "Run `fg` to bring Claude Code back" — but there is no
// shell in a Clauding pane, so there is no `fg` and the pane froze until the
// app was restarted. The key is turned into what the CLI's own message
// suggests instead, its undo (Ctrl+_, the byte 0x1f), on every system. ⌘Z
// on macOS is the Edit menu's Undo, which does the same in a terminal
// (electron/main.js), so here it is left to the menu. If a suspend happens
// anyway, the main process continues the process on its own
// (electron/lib/suspendWatch.js).
export const CLAUDE_UNDO_INPUT = "\x1f";

function isSuspendKey(event) {
  const key = String(event.key || "").toLowerCase();
  const isLetterZ = key === "z" || event.code === "KeyZ";
  return isLetterZ && Boolean(event.ctrlKey) && !event.metaKey && !event.altKey;
}

export function terminalKeyDecision(event, platform) {
  if (event && isSuspendKey(event)) {
    // Only the keydown types the undo; the keypress and keyup of the same
    // stroke are swallowed too, so nothing of it reaches the pty.
    return event.type === "keydown" ? "undo-instead-of-suspend" : "swallow";
  }
  if (!event || event.type !== "keydown" || !commandKeyPressed(event, platform)) {
    return "pass-to-terminal";
  }
  const key = String(event.key || "").toLowerCase();
  if (key === "k") {
    return "clear";
  }
  const takenByMenu = isWindowsPlatform(platform) ? ["v"] : ["c", "v", "a", "q", "w", "z"];
  return takenByMenu.includes(key) ? "leave-to-menu" : "pass-to-terminal";
}
