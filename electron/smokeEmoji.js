// Dev-only automation (CLAUDING_SMOKE_EMOJI=1) for the agent form's emoji
// field. It spawns no `claude` and writes nothing to the store: it opens the
// Agents tab, opens "+ Add agent", and drives the field itself.
//
//   1. asks the main process whether the native macOS emoji panel exists
//      (app.isEmojiPanelSupported) and opens it once through the same IPC
//      call the "🙂" button uses;
//   2. pastes text into the field with webContents.insertText — the same
//      path a real Cmd+V takes — and checks only the first whole emoji is
//      kept ("✅ Test" -> "✅", "🧑‍💻 dev" -> "🧑‍💻", "👩🏽‍🔬" whole);
//   3. opens the built-in list, picks an emoji from it, and checks Escape
//      closes the list without closing the form -> emoji-field.png.
// Screenshots go to CLAUDING_SMOKE_FOLDER.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
const PASTE_CHECKS = [
  { pasted: "✅ Test", expected: "✅" },
  { pasted: "  🧑‍💻 developer  ", expected: "🧑‍💻" },
  { pasted: "👩🏽‍🔬", expected: "👩🏽‍🔬" },
  { pasted: "📐", expected: "📐" }
];

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runInWindow(window, script) {
  return window.webContents.executeJavaScript(script);
}

function clickInWindow(window, selector) {
  return runInWindow(
    window,
    `(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (target) { target.click(); } return Boolean(target); })()`
  );
}

async function capture(window, fileName) {
  if (!window || window.isDestroyed()) {
    return;
  }
  fs.mkdirSync(SMOKE_DIRECTORY, { recursive: true });
  window.webContents.invalidate();
  await wait(400);
  const image = await window.webContents.capturePage();
  const filePath = path.join(SMOKE_DIRECTORY, fileName);
  fs.writeFileSync(filePath, image.toPNG());
  console.log(`[emoji-smoke] screenshot written to ${filePath}`);
}

function readEmojiField(window) {
  return runInWindow(
    window,
    '(() => { const field = document.querySelector("[data-agent-emoji-input]"); return field ? field.value : null; })()'
  );
}

async function clearEmojiField(window) {
  await runInWindow(
    window,
    `(() => {
      const field = document.querySelector("[data-agent-emoji-input]");
      if (!field) { return false; }
      field.focus();
      field.setSelectionRange(0, field.value.length);
      return true;
    })()`
  );
}

export async function runEmojiSmoke({ window, quit }) {
  let failures = 0;
  try {
    await wait(3500);

    // The Agents tab, then the empty "+ Add agent" form.
    await clickInWindow(window, "[data-agents-tab]");
    await wait(900);
    const formOpened = await clickInWindow(window, "[data-add-agent]");
    if (!formOpened) {
      throw new Error("the \"+ Add agent\" button is not there");
    }
    await wait(900);

    // 1. The native panel, through the same call the "🙂" button makes.
    const panelAnswer = await runInWindow(window, "window.clauding.showEmojiPanel()");
    console.log(`[emoji-smoke] showEmojiPanel answered ${JSON.stringify(panelAnswer)}`);
    if (!panelAnswer.supported) {
      failures += 1;
      console.log("[emoji-smoke] FAIL: this Electron reports no native emoji panel");
    }
    await wait(1200);

    // 2. Pasting, the way Cmd+V reaches the field.
    for (const check of PASTE_CHECKS) {
      await clearEmojiField(window);
      window.webContents.insertText(check.pasted);
      await wait(500);
      const stored = await readEmojiField(window);
      const passed = stored === check.expected;
      if (!passed) {
        failures += 1;
      }
      console.log(
        `[emoji-smoke] ${passed ? "ok" : "FAIL"}: pasted ${JSON.stringify(check.pasted)} -> ` +
          `${JSON.stringify(stored)} (expected ${JSON.stringify(check.expected)})`
      );
    }

    // 3. The built-in list: open it, search, pick, and close it with Escape.
    await clickInWindow(window, "[data-agent-emoji-list]");
    await wait(700);
    const groupCount = await runInWindow(
      window,
      '(() => document.querySelectorAll("[data-emoji-picker] .emoji-picker-group").length)()'
    );
    const choiceCount = await runInWindow(
      window,
      '(() => document.querySelectorAll("[data-emoji-choice]").length)()'
    );
    console.log(`[emoji-smoke] the list draws ${choiceCount} emoji in ${groupCount} rows`);
    if (choiceCount < 60) {
      failures += 1;
      console.log("[emoji-smoke] FAIL: the built-in list is shorter than expected");
    }
    await capture(window, "emoji-field.png");

    // The search box narrows the list.
    await runInWindow(
      window,
      `(() => {
        const search = document.querySelector("[data-emoji-search]");
        if (!search) { return false; }
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(search, "rocket");
        search.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`
    );
    await wait(500);
    const filteredCount = await runInWindow(
      window,
      '(() => document.querySelectorAll("[data-emoji-choice]").length)()'
    );
    console.log(`[emoji-smoke] searching "rocket" leaves ${filteredCount} emoji`);
    if (filteredCount !== 1) {
      failures += 1;
      console.log("[emoji-smoke] FAIL: the search box did not narrow the list to the rocket");
    }
    await clickInWindow(window, '[data-emoji-choice="🚀"]');
    await wait(500);
    const afterPick = await readEmojiField(window);
    console.log(`[emoji-smoke] after picking from the list the field holds ${JSON.stringify(afterPick)}`);
    if (afterPick !== "🚀") {
      failures += 1;
      console.log("[emoji-smoke] FAIL: picking from the list did not set the field");
    }
    const listClosed = await runInWindow(
      window,
      '(() => document.querySelector("[data-emoji-picker]") === null)()'
    );
    if (!listClosed) {
      failures += 1;
      console.log("[emoji-smoke] FAIL: the list stayed open after a pick");
    }

    // Escape closes the list first and leaves the form standing.
    await clickInWindow(window, "[data-agent-emoji-list]");
    await wait(600);
    await runInWindow(
      window,
      '(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()'
    );
    await wait(600);
    const afterEscape = await runInWindow(
      window,
      `(() => JSON.stringify({
        list: document.querySelector("[data-emoji-picker]") !== null,
        form: document.querySelector("[data-agent-form]") !== null
      }))()`
    );
    console.log(`[emoji-smoke] after Escape: ${afterEscape}`);
    if (afterEscape !== JSON.stringify({ list: false, form: true })) {
      failures += 1;
      console.log("[emoji-smoke] FAIL: Escape should close the list only");
    }

    console.log(failures === 0 ? "[emoji-smoke] all checks passed" : `[emoji-smoke] ${failures} check(s) failed`);
  } catch (error) {
    console.log(`[emoji-smoke] failed: ${error.message}`);
    await capture(window, "emoji-failed.png");
  } finally {
    quit();
  }
}
