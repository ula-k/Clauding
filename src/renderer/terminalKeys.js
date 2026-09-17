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
// application menu: Electron turns them into copy / paste events on xterm's
// hidden textarea, which xterm handles (selection out, clipboard text in).
//
// On Windows the modifier is Ctrl — but Ctrl+C there has to stay the
// interrupt, the way it is in every Windows console, so only Ctrl+K and
// Ctrl+V are taken and everything else goes through to the CLI. Copying is a
// selection plus the Edit menu.
export function terminalKeyDecision(event, platform) {
  if (!event || event.type !== "keydown" || !commandKeyPressed(event, platform)) {
    return "pass-to-terminal";
  }
  const key = String(event.key || "").toLowerCase();
  if (key === "k") {
    return "clear";
  }
  const takenByMenu = isWindowsPlatform(platform) ? ["v"] : ["c", "v", "a", "q", "w"];
  return takenByMenu.includes(key) ? "leave-to-menu" : "pass-to-terminal";
}
