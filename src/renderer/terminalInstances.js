// The xterm.js instances, one per terminal id, kept alive for the whole life
// of the app outside React: switching sessions only re-parents the terminal's
// DOM wrapper into the visible pane, so scrollback, cursor and selection
// survive, and terminals that are not on screen keep receiving output.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const SCROLLBACK_LINES = 10000;
// Absolute or ~/ paths to pages the right panel can show.
const LOCAL_PAGE_PATTERN = /(?<![\w:/.-])(?:~|\/)[^\s"'`<>()[\]|]*?\.(?:html?|md|markdown)\b/g;
const instances = new Map();
let lastKnownDimensions = { columns: 100, rows: 30 };

// A click on a link opens it in the right panel of this terminal's session;
// Cmd+click hands it to the system (Chrome for URLs, the default app for files).
function openLinkFromTerminal(terminalId, event, target) {
  if (event && event.metaKey) {
    window.clauding.openExternally(target).catch((error) => console.error("Could not open externally", error));
    return;
  }
  window.clauding.openPanelTab({ terminalId, target }).catch((error) => {
    console.error("Could not open in the panel", error);
  });
}

// The rows of one logical line (a long line xterm wrapped), joined, plus
// the mapping back from string index to (row, column) for link ranges.
function logicalLineAt(buffer, columns, lineIndex) {
  let firstRow = lineIndex;
  while (firstRow > 0) {
    const line = buffer.getLine(firstRow);
    if (!line || !line.isWrapped) {
      break;
    }
    firstRow -= 1;
  }
  let lastRow = lineIndex;
  while (true) {
    const next = buffer.getLine(lastRow + 1);
    if (!next || !next.isWrapped) {
      break;
    }
    lastRow += 1;
  }
  let text = "";
  for (let row = firstRow; row <= lastRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      break;
    }
    text += row === lastRow ? line.translateToString(true) : line.translateToString(false).padEnd(columns, " ");
  }
  return {
    text,
    firstRow,
    lastRow,
    positionOf(index) {
      return { x: (index % columns) + 1, y: firstRow + Math.floor(index / columns) + 1 };
    }
  };
}

// xterm link provider for local .html / .md paths printed by the CLI.
function localPageLinkProvider(terminal, terminalId) {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active;
      const columns = terminal.cols;
      const lineIndex = bufferLineNumber - 1;
      const logical = logicalLineAt(buffer, columns, lineIndex);
      const links = [];
      for (const match of logical.text.matchAll(LOCAL_PAGE_PATTERN)) {
        const startIndex = match.index;
        const endIndex = startIndex + match[0].length - 1;
        const start = logical.positionOf(startIndex);
        const end = logical.positionOf(endIndex);
        if (end.y < bufferLineNumber || start.y > bufferLineNumber) {
          continue;
        }
        links.push({
          range: { start, end },
          text: match[0],
          decorations: { underline: true, pointerCursor: true },
          activate(event, text) {
            openLinkFromTerminal(terminalId, event, text);
          }
        });
      }
      callback(links.length > 0 ? links : undefined);
    }
  };
}

function cssToken(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// The xterm colours come from theme.css so the terminal matches the window.
export function terminalTheme() {
  return {
    background: cssToken("--terminal-background", "rgba(0, 0, 0, 0)"),
    foreground: cssToken("--text", "#e6ebe4"),
    cursor: cssToken("--accent", "#b9a7e6"),
    cursorAccent: cssToken("--on-accent", "#1f1a2c"),
    selectionBackground: cssToken("--terminal-selection", "rgba(185, 167, 230, 0.3)"),
    selectionInactiveBackground: cssToken("--terminal-selection-inactive", "rgba(185, 167, 230, 0.18)"),
    black: cssToken("--terminal-black", "#1b1f1c"),
    red: cssToken("--terminal-red", "#d9968a"),
    green: cssToken("--terminal-green", "#a9c7a4"),
    yellow: cssToken("--terminal-yellow", "#d6c58f"),
    blue: cssToken("--terminal-blue", "#8fa9c9"),
    magenta: cssToken("--terminal-magenta", "#c49bb8"),
    cyan: cssToken("--terminal-cyan", "#8fbcb4"),
    white: cssToken("--terminal-white", "#d5dbd3"),
    brightBlack: cssToken("--terminal-bright-black", "#6f7a6f"),
    brightRed: cssToken("--terminal-bright-red", "#e4a89c"),
    brightGreen: cssToken("--terminal-bright-green", "#b9d4b4"),
    brightYellow: cssToken("--terminal-bright-yellow", "#e2d3a4"),
    brightBlue: cssToken("--terminal-bright-blue", "#a4bbd6"),
    brightMagenta: cssToken("--terminal-bright-magenta", "#d2b0c8"),
    brightCyan: cssToken("--terminal-bright-cyan", "#a6cdc5"),
    brightWhite: cssToken("--terminal-bright-white", "#eef2ec")
  };
}

export function lastTerminalDimensions() {
  return lastKnownDimensions;
}

// Cmd+K clears like in Terminal.app. Cmd+C / Cmd+V are left to the
// application menu: Electron turns them into copy / paste events on xterm's
// hidden textarea, which xterm handles (selection out, clipboard text in).
function customKeyHandler(terminal) {
  return function handleKey(event) {
    if (event.type !== "keydown" || !event.metaKey) {
      return true;
    }
    if (event.key === "k") {
      terminal.clear();
      return false;
    }
    if (event.key === "c" || event.key === "v" || event.key === "a" || event.key === "q" || event.key === "w") {
      return false;
    }
    return true;
  };
}

export function ensureInstance(terminalId) {
  let instance = instances.get(terminalId);
  if (instance) {
    return instance;
  }
  const terminal = new Terminal({
    allowTransparency: true,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: '"SF Mono", Menlo, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.25,
    letterSpacing: 0,
    scrollback: SCROLLBACK_LINES,
    theme: terminalTheme()
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      openLinkFromTerminal(terminalId, event, uri);
    })
  );
  terminal.registerLinkProvider(localPageLinkProvider(terminal, terminalId));
  terminal.attachCustomKeyEventHandler(customKeyHandler(terminal));
  terminal.onData((data) => {
    window.clauding.writeToTerminal(terminalId, data);
  });
  terminal.onResize(({ cols, rows }) => {
    lastKnownDimensions = { columns: cols, rows };
    window.clauding.resizeTerminal(terminalId, cols, rows);
  });
  const wrapper = document.createElement("div");
  wrapper.className = "terminal-wrapper";
  instance = { terminal, fitAddon, wrapper, opened: false, pendingOutput: "" };
  instances.set(terminalId, instance);
  return instance;
}

export function hasInstance(terminalId) {
  return instances.has(terminalId);
}

// Output for a terminal whose pane has not been shown yet is kept until
// xterm is opened (opening it in a detached element measures nothing).
export function writeToInstance(terminalId, data) {
  const instance = ensureInstance(terminalId);
  if (instance.opened) {
    instance.terminal.write(data);
  } else {
    instance.pendingOutput += data;
  }
}

export function fitInstance(terminalId) {
  const instance = instances.get(terminalId);
  if (!instance || !instance.opened) {
    return;
  }
  try {
    instance.fitAddon.fit();
  } catch (error) {
    // The pane may be hidden mid-resize; the next fit will succeed.
  }
}

// Puts the terminal's wrapper into `hostElement`, opening xterm the first
// time (once the host is in the document, so character sizes measure).
export function attachInstance(terminalId, hostElement) {
  const instance = ensureInstance(terminalId);
  if (instance.wrapper.parentElement !== hostElement) {
    hostElement.appendChild(instance.wrapper);
  }
  if (!instance.opened) {
    instance.terminal.open(instance.wrapper);
    instance.opened = true;
    if (instance.pendingOutput) {
      instance.terminal.write(instance.pendingOutput);
      instance.pendingOutput = "";
    }
  }
  fitInstance(terminalId);
  instance.terminal.focus();
}

export function detachInstance(terminalId) {
  const instance = instances.get(terminalId);
  if (instance && instance.wrapper.parentElement) {
    instance.wrapper.parentElement.removeChild(instance.wrapper);
  }
}

export function focusInstance(terminalId) {
  const instance = instances.get(terminalId);
  if (instance && instance.opened) {
    instance.terminal.focus();
  }
}

export function disposeInstance(terminalId) {
  const instance = instances.get(terminalId);
  if (!instance) {
    return;
  }
  detachInstance(terminalId);
  instance.terminal.dispose();
  instances.delete(terminalId);
}
