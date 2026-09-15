// Dev-only automation (CLAUDING_SMOKE_COLLAPSE=1) for folding a group shut.
// The point of the feature is a group like "PRIV" that shows nothing of
// itself on a shared screen — so a collapsed group must still say that
// something inside needs an answer or is busy, still take a dragged row, and
// still come back collapsed after a reload.
//
// It never spawns a `claude` process and writes nowhere except
// <userData>/groups.json, through the real store — and it puts everything
// back at the end: the group is expanded again and every row it borrowed
// goes back to the group it came from.
//
//   1. makes (or reuses) a group and moves a session that needs an answer
//      and a session that is busy into it;
//   2. clicks the header's chevron -> groups-collapsed.png: that group folded
//      shut with its count, its badge and its running dot, the other groups
//      still open;
//   3. types a search word: the match inside the collapsed group shows again,
//      and the stored state does not change;
//   4. drops a row on the collapsed header and checks it joined the group;
//   5. reloads the renderer and checks the group is still collapsed.
//
// Screenshots go to CLAUDING_SMOKE_FOLDER.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
const GROUP_NAME = process.env.CLAUDING_SMOKE_GROUP_NAME || "PRIV";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function capture(window, fileName) {
  if (!window || window.isDestroyed()) {
    return;
  }
  fs.mkdirSync(SMOKE_DIRECTORY, { recursive: true });
  // A window nobody is looking at can hold a stale frame.
  window.webContents.invalidate();
  await wait(400);
  const image = await window.webContents.capturePage();
  const filePath = path.join(SMOKE_DIRECTORY, fileName);
  fs.writeFileSync(filePath, image.toPNG());
  console.log(`[collapse] screenshot written to ${filePath}`);
}

function runInWindow(window, script) {
  return window.webContents.executeJavaScript(script);
}

// Types into the search box the way a person would (React listens for the
// input event, so the native value setter is used to get there).
function typeIntoSearch(window, searchText) {
  return runInWindow(
    window,
    `(() => {
      const field = document.querySelector(".search-box input");
      if (!field) { return false; }
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setValue.call(field, ${JSON.stringify(searchText)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`
  );
}

export async function runCollapseSmoke({ window, sessionGroups, listSessions, quit }) {
  const membershipBefore = { ...sessionGroups.get().membership };
  const borrowedSessions = [];
  let group = null;
  let groupWasCreatedHere = false;
  try {
    await wait(4000);
    const rows = (await listSessions()).sessions;
    console.log(`[collapse] ${rows.length} sessions listed`);
    if (rows.length < 5) {
      throw new Error("not enough sessions on this Mac to exercise the list");
    }

    // 1. A group with something worth noticing inside it.
    const existing = sessionGroups.get().groups.find((entry) => entry.name === GROUP_NAME);
    group = existing || sessionGroups.createGroup(GROUP_NAME);
    groupWasCreatedHere = !existing;
    const needsAnswerSession = rows.find((session) => session.needsAnswer) || null;
    const runningSession = rows.find((session) => session.statusGroup === "running") || null;
    for (const session of [needsAnswerSession, runningSession]) {
      if (session && !borrowedSessions.some((other) => other.sessionId === session.sessionId)) {
        borrowedSessions.push(session);
        sessionGroups.assignSession(session.sessionId, group.id);
      }
    }
    console.log(
      `[collapse] group "${group.name}" (${group.id}); needs answer: ${needsAnswerSession ? needsAnswerSession.title : "none on this Mac"}; ` +
        `running: ${runningSession ? runningSession.title : "none on this Mac"}`
    );
    await wait(1500);

    // 2. The chevron.
    const clickedChevron = await runInWindow(
      window,
      `(() => {
        const chevron = document.querySelector('[data-group-chevron="${group.id}"]');
        if (!chevron) { return false; }
        chevron.scrollIntoView({ block: "center" });
        chevron.click();
        return true;
      })()`
    );
    await wait(1000);
    const storedCollapsed = sessionGroups.get().collapsed;
    console.log(`[collapse] chevron clicked=${clickedChevron}; collapsed in the store: ${JSON.stringify(storedCollapsed)}`);
    if (!storedCollapsed.includes(group.id)) {
      throw new Error("the chevron did not collapse the group");
    }
    const headerReport = await runInWindow(
      window,
      `(() => {
        const header = document.querySelector('[data-group-header="${group.id}"]');
        if (!header) { return null; }
        const section = header.closest(".group-section");
        return JSON.stringify({
          text: header.innerText.replace(/\\n/g, " "),
          collapsedAttribute: header.getAttribute("data-group-collapsed"),
          rowsStillDrawn: section.querySelectorAll("[data-session-row]").length,
          needsAnswerBadge: Boolean(header.querySelector(".group-needs-answer")),
          runningDot: Boolean(header.querySelector(".group-running-dot"))
        });
      })()`
    );
    console.log(`[collapse] collapsed header: ${headerReport}`);
    if (!headerReport || JSON.parse(headerReport).rowsStillDrawn !== 0) {
      throw new Error("a collapsed group is still drawing its rows");
    }
    await capture(window, "groups-collapsed.png");

    // 3. A typed search finds matches inside a collapsed group, and leaves
    //    the stored state alone.
    if (needsAnswerSession) {
      const searchWord = (String(needsAnswerSession.title).match(/[a-zA-Z]{4,}/) || [""])[0];
      await typeIntoSearch(window, searchWord);
      await wait(1000);
      const foundWhileCollapsed = await runInWindow(
        window,
        `(() => Boolean(document.querySelector('[data-session-row="${needsAnswerSession.sessionId}"]')))()`
      );
      console.log(`[collapse] search "${searchWord}" finds the row inside the collapsed group: ${foundWhileCollapsed}`);
      if (!foundWhileCollapsed) {
        throw new Error("a search match stayed hidden inside a collapsed group");
      }
      await capture(window, "groups-collapsed-search.png");
      await typeIntoSearch(window, "");
      await wait(800);
      if (!sessionGroups.get().collapsed.includes(group.id)) {
        throw new Error("searching wrote the temporary expansion back to groups.json");
      }
      console.log("[collapse] the search did not change the stored state");
    }

    // 4. A row dropped on the collapsed header still joins the group.
    const rowToDrop = rows.find(
      (session) =>
        membershipBefore[session.sessionId] !== group.id && !borrowedSessions.some((other) => other.sessionId === session.sessionId)
    );
    if (rowToDrop) {
      const dispatched = await runInWindow(
        window,
        `(() => {
          const row = document.querySelector('[data-session-row="${rowToDrop.sessionId}"]');
          const header = document.querySelector('[data-group-header="${group.id}"]');
          if (!row || !header) { return false; }
          const wrapper = row.closest(".session-row-wrapper");
          const transfer = new DataTransfer();
          wrapper.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
          header.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
          header.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
          return true;
        })()`
      );
      await wait(900);
      borrowedSessions.push(rowToDrop);
      const landedIn = sessionGroups.get().membership[rowToDrop.sessionId];
      console.log(`[collapse] drop onto the collapsed header: dispatched=${dispatched}, membership now ${landedIn}`);
      if (landedIn !== group.id) {
        throw new Error("a row dropped on a collapsed header did not join the group");
      }
    } else {
      console.log("[collapse] WARNING: no spare row to drop on the collapsed header");
    }

    // 5. A reload brings the same folded group back.
    window.webContents.reload();
    await wait(3500);
    const afterReload = await runInWindow(
      window,
      `(() => {
        const header = document.querySelector('[data-group-header="${group.id}"]');
        return header ? header.getAttribute("data-group-collapsed") : "no header";
      })()`
    );
    console.log(`[collapse] after reload, "${group.name}" still collapsed: ${afterReload}`);
    if (afterReload !== "1") {
      throw new Error("the collapsed group came back expanded after a reload");
    }

    // The chevron opens it again, from the UI.
    await runInWindow(
      window,
      `(() => { const chevron = document.querySelector('[data-group-chevron="${group.id}"]'); if (chevron) { chevron.click(); } return Boolean(chevron); })()`
    );
    await wait(900);
    console.log(`[collapse] expanded again from the UI: ${JSON.stringify(sessionGroups.get().collapsed)}`);
    await capture(window, "groups-expanded.png");
    await wait(400);
  } catch (error) {
    console.log(`[collapse] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "groups-collapsed-failed.png");
  }
  // Put everything back: the group open, every borrowed row where it was,
  // and a group this run created removed again.
  if (group) {
    sessionGroups.setCollapsed(group.id, false);
    for (const session of borrowedSessions) {
      sessionGroups.assignSession(session.sessionId, membershipBefore[session.sessionId] || "default");
    }
    if (groupWasCreatedHere) {
      sessionGroups.deleteGroup(group.id);
    }
    console.log(`[collapse] borrowed rows put back; group removed again: ${groupWasCreatedHere}`);
  }
  await wait(600);
  quit();
}
