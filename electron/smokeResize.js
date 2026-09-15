// Dev-only automation (CLAUDING_SMOKE_RESIZE=1): the two drag handles, with
// a real page loaded in the right panel and without spawning a single
// `claude` (it only ever clicks a row that already runs somewhere else).
//
// What it proves:
//   1. a width stored while the window was wider is corrected on start, so
//      the panel handle is always reachable (it was not: the panel then
//      "could not be moved at all");
//   2. the panel can be dragged **wider** and, the direction that was broken,
//      **narrower** — the pointer then travels over the panel's <webview>,
//      a separate guest process that used to swallow the move events;
//   3. the left column handle still works the same way.
// The drags go through webContents.sendInputEvent, so they take the path a
// real mouse takes (hit testing included), not synthetic DOM events.
// Everything it borrows — the stored widths, the tab it opens — is put back.
import fs from "node:fs";
import path from "node:path";
import { describeTarget } from "./panelTabs.js";
import { smokeFolderPath } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
const SMOKE_PAGE = process.env.CLAUDING_SMOKE_PAGE || path.join(SMOKE_DIRECTORY, "smoke-page.html");
const STORED_TOO_WIDE_PANEL = 1180;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function capture(window, fileName) {
  if (!window || window.isDestroyed()) {
    return;
  }
  fs.mkdirSync(SMOKE_DIRECTORY, { recursive: true });
  const image = await window.webContents.capturePage();
  const filePath = path.join(SMOKE_DIRECTORY, fileName);
  fs.writeFileSync(filePath, image.toPNG());
  console.log(`[resize-smoke] screenshot written to ${filePath}`);
}

function readNumber(window, expression) {
  return window.webContents.executeJavaScript(expression).then((value) => Math.round(Number(value)));
}

function panelWidthNow(window) {
  return readNumber(window, "document.querySelector('.column-right').getBoundingClientRect().width");
}

function leftWidthNow(window) {
  return readNumber(window, "document.querySelector('.column-left').getBoundingClientRect().width");
}

function handleCenter(window, which) {
  return window.webContents.executeJavaScript(
    `(() => {
      const handle = document.querySelector('[data-resize-handle="${which}"]');
      if (!handle) { return null; }
      const box = handle.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`
  );
}

// A mouse drag the way the operating system delivers one: press, a run of
// moves, release — every step through the browser process, so a pointer that
// ends up over the <webview> really is a pointer over the guest.
async function dragHorizontally(window, fromPoint, toX) {
  const steps = 12;
  window.webContents.sendInputEvent({ type: "mouseDown", x: fromPoint.x, y: fromPoint.y, button: "left", clickCount: 1 });
  await wait(100);
  for (let step = 1; step <= steps; step += 1) {
    const stepX = Math.round(fromPoint.x + ((toX - fromPoint.x) * step) / steps);
    window.webContents.sendInputEvent({ type: "mouseMove", x: stepX, y: fromPoint.y, button: "left" });
    await wait(40);
  }
  window.webContents.sendInputEvent({ type: "mouseUp", x: toX, y: fromPoint.y, button: "left", clickCount: 1 });
  await wait(400);
}

export async function runResizeSmoke({ window, panelTabs, quit }) {
  let borrowedSessionId = null;
  let borrowedTabId = null;
  let storedWidths = null;
  try {
    fs.mkdirSync(SMOKE_DIRECTORY, { recursive: true });
    if (!fs.existsSync(SMOKE_PAGE)) {
      fs.writeFileSync(SMOKE_PAGE, "<!doctype html><title>Clauding smoke</title><h1>Clauding smoke page</h1>\n");
    }
    await wait(2500);

    // 1. A width from a bigger window, then a reload so the renderer reads it.
    // Only the widths are stored per window; whether the panel is up belongs
    // to the session, and opening a page in it below is what raises it.
    storedWidths = await window.webContents.executeJavaScript(
      `(() => {
        const previous = {
          panelWidth: window.localStorage.getItem("clauding.panelWidth"),
          leftWidth: window.localStorage.getItem("clauding.leftWidth")
        };
        window.localStorage.setItem("clauding.panelWidth", "${STORED_TOO_WIDE_PANEL}");
        window.localStorage.setItem("clauding.leftWidth", "300");
        return previous;
      })()`
    );
    window.webContents.reload();
    await wait(3500);

    // A row that already runs in another terminal or job: clicking it can
    // never start a `claude` of its own.
    borrowedSessionId = await window.webContents.executeJavaScript(
      `(() => {
        const row = document.querySelector('[data-session-row][data-running-elsewhere="1"]');
        if (!row) { return null; }
        row.click();
        return row.getAttribute("data-session-row");
      })()`
    );
    if (!borrowedSessionId) {
      throw new Error("no session is running outside the app, so the panel has nowhere to draw a page");
    }
    await wait(1500);
    const opened = panelTabs.open(borrowedSessionId, describeTarget(SMOKE_PAGE, null), { reveal: true });
    borrowedTabId = opened.tabId;
    await wait(3000);

    const windowWidth = await readNumber(window, "window.innerWidth");
    console.log(
      `[resize-smoke] window ${windowWidth}px; stored panel width ${STORED_TOO_WIDE_PANEL} -> ${await panelWidthNow(window)} on load (left column ${await leftWidthNow(window)})`
    );

    // 2. Narrower first, from the widest the window allows: the pointer
    // crosses the <webview>, which is the direction that was broken.
    const narrowFrom = await handleCenter(window, "panel");
    if (!narrowFrom) {
      throw new Error("the panel's resize handle is not on screen");
    }
    const beforeNarrow = await panelWidthNow(window);
    await dragHorizontally(window, narrowFrom, narrowFrom.x + 260);
    const afterNarrow = await panelWidthNow(window);
    console.log(`[resize-smoke] drag right by 260 (over the page): panel ${beforeNarrow} -> ${afterNarrow}`);
    await wait(1000);
    await capture(window, "panel-resize.png");

    // 3. And wider again, where the pointer stays over ordinary DOM.
    const widenFrom = await handleCenter(window, "panel");
    const beforeWiden = await panelWidthNow(window);
    await dragHorizontally(window, widenFrom, widenFrom.x - 160);
    const afterWiden = await panelWidthNow(window);
    console.log(`[resize-smoke] drag left by 160: panel ${beforeWiden} -> ${afterWiden}`);

    // 4. The left column handle, the same way.
    const leftFrom = await handleCenter(window, "left");
    const beforeLeft = await leftWidthNow(window);
    await dragHorizontally(window, leftFrom, leftFrom.x + 90);
    const afterLeft = await leftWidthNow(window);
    console.log(`[resize-smoke] left handle dragged right by 90: left column ${beforeLeft} -> ${afterLeft}`);

    const storedAfter = await window.webContents.executeJavaScript(
      '(() => window.localStorage.getItem("clauding.panelWidth"))()'
    );
    console.log(`[resize-smoke] stored panel width after the drags: ${storedAfter}`);

    const problems = [];
    if (afterWiden <= beforeWiden) {
      problems.push("the panel did not get wider");
    }
    if (afterNarrow >= beforeNarrow) {
      problems.push("the panel did not get narrower");
    }
    if (afterLeft <= beforeLeft) {
      problems.push("the left column did not get wider");
    }
    console.log(problems.length === 0 ? "[resize-smoke] both handles move in both directions" : `[resize-smoke] PROBLEMS: ${problems.join("; ")}`);
    if (problems.length > 0) {
      await capture(window, "panel-resize-failed.png");
    }
  } catch (error) {
    console.log(`[resize-smoke] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "panel-resize-failed.png");
  }
  // Put back what was borrowed: the tab and the stored widths.
  try {
    if (borrowedSessionId && borrowedTabId) {
      panelTabs.close(borrowedSessionId, borrowedTabId);
    }
    if (storedWidths && window && !window.isDestroyed()) {
      await window.webContents.executeJavaScript(
        `(() => {
          const previous = ${JSON.stringify(storedWidths)};
          if (previous.panelWidth === null) { window.localStorage.removeItem("clauding.panelWidth"); }
          else { window.localStorage.setItem("clauding.panelWidth", previous.panelWidth); }
          if (previous.leftWidth === null) { window.localStorage.removeItem("clauding.leftWidth"); }
          else { window.localStorage.setItem("clauding.leftWidth", previous.leftWidth); }
          return true;
        })()`
      );
    }
  } catch (error) {
    console.log(`[resize-smoke] could not put everything back: ${error && error.message ? error.message : error}`);
  }
  await wait(800);
  quit();
}
