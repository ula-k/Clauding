// The text appended to the CLI's system prompt in every terminal the app
// opens (`claude --append-system-prompt`), so each session knows it runs
// inside Clauding and how to open something in the right panel. It lives in
// <userData>/preamble.md, written with the default below on first use and
// read again at every spawn, so it can be edited by hand.
//
// The default text itself is `electron/preamble-default.md` next to this
// file, not a string in here: it is content, it is easier to read and edit
// there, and it may contain words (the Spanish "en el panel") that the naming
// rules of `npm run check` reject inside JavaScript.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const electronFolder = path.dirname(fileURLToPath(import.meta.url));
const defaultPreamblePath = path.join(electronFolder, "preamble-default.md");

// Used only when preamble-default.md cannot be read at all (it ships with the
// app, so this should never happen). It says the same thing as the file, minus
// the translated example phrases, some of which are words the naming rules of
// `npm run check` reject inside JavaScript.
const FALLBACK_PREAMBLE = `You are running inside Clauding, a desktop app for Claude Code. Your terminal is the middle column. On the right there is Clauding's own side panel with tabs that can show a local HTML file, a Markdown file, or a web URL next to your terminal.
When the user asks to open, show, or preview something "on the right", "in the panel" or "in the side window" (also in their own language), run the Bash command:  clauding open <absolute path or URL>
That command is available in this terminal, opens one tab in the side panel and does not block. Do NOT publish a claude.ai Artifact for this and do not tell the user to press ctrl+] — an Artifact is not the side panel and the user will not see it there. Use \`clauding open\` also after you create or update an HTML or Markdown page the user should look at. \`clauding panel hide\` hides the panel; \`clauding tabs\` lists open tabs. If \`clauding open\` fails, say so verbatim instead of claiming the page is open.
When you produce a plan, a proposal, or anything the user should review or approve, write it as an HTML page (a readable, well-spaced document, not a wall of text) and open it in the side panel right away with \`clauding open\`, then summarise it in one or two sentences in the terminal and wait for the decision; edit the same file after feedback — the panel reloads it automatically. If a skill for reading pages exists in the user's Claude Code setup (for example one describing their preferred document style), follow it.
Paths and URLs you print are also clickable and open in the same panel.
`;

// Every default text this app has ever written into <userData>/preamble.md,
// as a SHA-256 of the exact bytes. A stored file that still hashes to one of
// them was never touched by the user, so it is replaced with the current
// default on start (see refreshStoredPreamble); anything else is the user's
// own edit and stays. Hashes rather than the old texts themselves: the whole
// point is to recognise a file byte for byte, and a list of hashes says that
// without carrying three versions of the same paragraph around.
//
// When the default changes, add the hash of the text being replaced here:
//   shasum -a 256 electron/preamble-default.md
const PREVIOUS_DEFAULT_PREAMBLE_HASHES = [
  // The first default: one paragraph about `clauding open`.
  "e20d26345578584cd8d76981e8a0333606ce1b98ddb459b433a67340cdd7725d",
  // Added `clauding tabs`, the "not an Artifact" warning and the translated
  // phrases the user might ask with.
  "072c3abb262e05532ce7642b54fe365d361ae90ac17344db66d25bc685634324"
];

function hashOf(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The current default text, read from preamble-default.md.
export function defaultPreamble() {
  try {
    return fs.readFileSync(defaultPreamblePath, "utf8");
  } catch (error) {
    return FALLBACK_PREAMBLE;
  }
}

export function readPreamble(preamblePath) {
  try {
    const text = fs.readFileSync(preamblePath, "utf8");
    return text.trim() ? text : defaultPreamble();
  } catch (error) {
    try {
      fs.writeFileSync(preamblePath, defaultPreamble());
    } catch (writeError) {
      // The folder may be missing at the very first start; the default still applies.
    }
    return defaultPreamble();
  }
}

// Called once at startup. A preamble.md that is still one of our own old
// defaults is brought up to date (otherwise every session opened before this
// version would keep the old text forever); a file the user edited is never
// overwritten, only mentioned in the log.
export function refreshStoredPreamble(preamblePath, log) {
  function report(line) {
    if (log) {
      log(`[preamble] ${line}`);
    }
  }
  const current = defaultPreamble();
  let stored = null;
  try {
    stored = fs.readFileSync(preamblePath, "utf8");
  } catch (error) {
    stored = null;
  }
  if (stored === null) {
    try {
      fs.writeFileSync(preamblePath, current);
      report(`wrote the default preamble to ${preamblePath}`);
      return { status: "created" };
    } catch (writeError) {
      report(`could not write ${preamblePath}: ${writeError.message}`);
      return { status: "failed" };
    }
  }
  if (stored === current) {
    return { status: "current" };
  }
  if (PREVIOUS_DEFAULT_PREAMBLE_HASHES.includes(hashOf(stored))) {
    try {
      fs.writeFileSync(preamblePath, current);
      report(`replaced the previous default preamble in ${preamblePath} with the new default`);
      return { status: "refreshed" };
    } catch (writeError) {
      report(`could not refresh ${preamblePath}: ${writeError.message}`);
      return { status: "failed" };
    }
  }
  report(`${preamblePath} was edited by hand — left untouched; the new default text is in electron/preamble-default.md`);
  return { status: "kept" };
}
