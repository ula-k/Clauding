// Dev-only automation (CLAUDING_SMOKE_GROUPS=1) for stage 5: the user-made
// groups, the row menu, the "Hidden (N)" line and the note shown for a
// session running outside the app.
//
// It never spawns a `claude` process and never writes anywhere except
// <userData>/groups.json (through the real store, the same calls the
// renderer's IPC makes), and it puts back what it borrowed at the end: the
// two sessions it hid are unhidden again, the "Blueprint" group stays.
//
// Screenshots go to CLAUDING_SMOKE_FOLDER.
import fs from "node:fs";
import path from "node:path";
import { smokeFolderPath } from "./smokeFolder.js";

const SMOKE_DIRECTORY = smokeFolderPath();
const GROUP_NAME = process.env.CLAUDING_SMOKE_GROUP_NAME || "Blueprint";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function capture(window, fileName) {
  if (!window || window.isDestroyed()) {
    return;
  }
  fs.mkdirSync(SMOKE_DIRECTORY, { recursive: true });
  // A window that nobody is looking at can hold a stale frame: ask for a
  // repaint and give it a moment, or the capture misses the open menu.
  window.webContents.invalidate();
  await wait(400);
  const image = await window.webContents.capturePage();
  const filePath = path.join(SMOKE_DIRECTORY, fileName);
  fs.writeFileSync(filePath, image.toPNG());
  console.log(`[smoke5] screenshot written to ${filePath}`);
}

function runInWindow(window, script) {
  return window.webContents.executeJavaScript(script);
}

// The most common word in the session titles on this Mac. The list is far
// longer than the window, so the screenshots type this into the search box:
// both groups and the "Hidden (N)" line then fit on one screen.
function mostCommonTitleWord(rows) {
  const counts = new Map();
  for (const session of rows.slice(0, 60)) {
    const words = String(session.title || "").toLowerCase().match(/[a-z]{4,}/g) || [];
    for (const word of new Set(words)) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  let best = null;
  for (const [word, count] of counts) {
    if (!best || count > best.count) {
      best = { word, count };
    }
  }
  return best;
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

export async function runGroupsSmoke({ window, sessionGroups, listSessions, syncHiddenWithLiveStatus, quit }) {
  try {
    await wait(4000);
    const page = await listSessions();
    const rows = page.sessions;
    console.log(`[smoke5] ${rows.length} sessions listed`);
    if (rows.length < 5) {
      throw new Error("not enough sessions on this Mac to exercise the list");
    }

    // 1. A real group through the real store, with two sessions in it.
    //    A run that already made the group reuses it instead of piling up.
    const existing = sessionGroups.get().groups.find((entry) => entry.name === GROUP_NAME);
    const group = existing || sessionGroups.createGroup(GROUP_NAME);
    const common = mostCommonTitleWord(rows);
    const matching = common
      ? rows.filter((session) => String(session.title || "").toLowerCase().includes(common.word))
      : rows;
    console.log(`[smoke5] search word "${common ? common.word : ""}" matches ${matching.length} sessions`);
    const moved = matching.slice(0, 2);
    for (const session of moved) {
      sessionGroups.assignSession(session.sessionId, group.id);
    }
    // 2. Two other sessions hidden; neither may be running, or the
    //    auto-unhide would take them straight back out again.
    // Only recent rows: a session further down the list than the first page
    // would not be on screen, and the "Hidden (N)" line counts what is loaded.
    const hideable = rows
      .slice(0, 20)
      .filter((session) => session.statusGroup !== "running" && !moved.some((other) => other.sessionId === session.sessionId));

    const hiddenRows = hideable.slice(0, 2);
    for (const session of hiddenRows) {
      sessionGroups.setHidden(session.sessionId, true);
    }
    console.log(
      `[smoke5] group ${group.id} "${group.name}" holds ${moved.length}; hidden: ${hiddenRows.map((session) => session.sessionId).join(", ")}`
    );
    await wait(1500);
    await capture(window, "stage5-list-full.png");
    if (common) {
      await typeIntoSearch(window, common.word);
      await wait(900);
    }
    await capture(window, "stage5-list.png");

    // 3. A row menu, open.
    const menuSessionId = moved[0].sessionId;
    const openedMenu = await runInWindow(
      window,
      `(() => {
        const button = document.querySelector('[data-row-menu-button="${menuSessionId}"]');
        if (!button) { return false; }
        button.scrollIntoView({ block: "center" });
        button.click();
        return true;
      })()`
    );
    console.log(`[smoke5] row menu opened: ${openedMenu}`);
    await wait(1500);
    await capture(window, "stage5-menu.png");
    await runInWindow(window, '(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return true; })()');
    await typeIntoSearch(window, "");
    await wait(600);

    // 4. A session running in a terminal or job outside the app: the short note.
    const clickedElsewhere = await runInWindow(
      window,
      '(() => { const row = document.querySelector(\'[data-session-row][data-running-elsewhere="1"]\'); if (row) { row.click(); } return Boolean(row); })()'
    );
    console.log(`[smoke5] clicked a session running elsewhere: ${clickedElsewhere}`);
    if (!clickedElsewhere) {
      console.log("[smoke5] WARNING: no session is running outside the app right now, stage5-elsewhere.png will show the empty state");
    }
    await wait(1600);
    const noteOnScreen = await runInWindow(
      window,
      '(() => { const note = document.querySelector(\'[data-elsewhere-note="1"]\'); return note ? note.innerText.replace(/\\n/g, " | ") : null; })()'
    );
    console.log(`[smoke5] note on screen: ${noteOnScreen}`);
    await capture(window, "stage5-elsewhere.png");

    // 4b. The group management, driven through the UI the way a person does it:
    //     "+ group", the header menu, a drag and drop, then Delete group.
    const temporaryName = "Smoke group";
    // A run that died half way may have left one behind.
    for (const stale of sessionGroups.get().groups.filter((entry) => entry.name === temporaryName)) {
      sessionGroups.deleteGroup(stale.id);
    }
    await runInWindow(
      window,
      `(() => {
        const button = document.querySelector("[data-new-group]");
        if (!button) { return false; }
        button.click();
        return true;
      })()`
    );
    await wait(500);
    await runInWindow(
      window,
      `(() => {
        const field = document.querySelector(".new-group-input");
        if (!field) { return false; }
        const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setValue.call(field, ${JSON.stringify(temporaryName)});
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return true;
      })()`
    );
    await wait(900);
    const temporary = sessionGroups.get().groups.find((entry) => entry.name === temporaryName);
    console.log(`[smoke5] "+ group" created: ${temporary ? temporary.id : "NOTHING"} at order ${temporary ? temporary.order : "-"}`);
    if (!temporary) {
      throw new Error('the "+ group" button did not create a group');
    }

    // The header menu: Move down. A new group opens at the very top of the
    // list, so "Move up" is the one item that is greyed out on it — the
    // swap to check here is the other one.
    const openedGroupMenu = await runInWindow(
      window,
      `(() => {
        const button = document.querySelector('[data-group-menu-button="${temporary.id}"]');
        if (!button) { return "no button"; }
        button.scrollIntoView({ block: "center" });
        button.click();
        return "clicked";
      })()`
    );
    await wait(1500);
    const menuPlacement = await runInWindow(
      window,
      `(() => {
        const menu = document.querySelector("[data-popup-menu]");
        if (!menu) { return "no menu in the DOM"; }
        const box = menu.getBoundingClientRect();
        const styles = window.getComputedStyle(menu);
        const anchorBox = document.querySelector('[data-group-menu-button="${temporary.id}"]').getBoundingClientRect();
        return JSON.stringify({
          menu: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
          anchor: [Math.round(anchorBox.left), Math.round(anchorBox.top)],
          visibility: styles.visibility,
          opacity: styles.opacity,
          window: [window.innerWidth, window.innerHeight],
          listScrollTop: Math.round(document.querySelector(".session-list").scrollTop)
        });
      })()`
    );
    console.log(`[smoke5] group menu placement: ${menuPlacement}`);
    const menuItems = await runInWindow(
      window,
      '(() => Array.from(document.querySelectorAll(".popup-menu-item")).map((node) => node.textContent.trim() + (node.disabled ? " (disabled)" : "")).join(" | "))()'
    );
    console.log(`[smoke5] group menu: ${openedGroupMenu}; items: ${menuItems}`);
    await wait(500);
    await capture(window, "stage5-group-menu.png");
    const clickedMoveDown = await runInWindow(
      window,
      `(() => {
        const items = Array.from(document.querySelectorAll(".popup-menu-item"));
        const item = items.find((node) => node.textContent.trim() === "Move down");
        if (!item || item.disabled) { return false; }
        item.click();
        return true;
      })()`
    );
    await wait(700);
    const movedOrder = sessionGroups.get().groups.find((entry) => entry.id === temporary.id).order;
    console.log(`[smoke5] header menu "Move down" clicked=${clickedMoveDown}, order now ${movedOrder}`);
    if (movedOrder !== temporary.order + 1) {
      throw new Error("Move down did not reorder the group");
    }

    // Drag a row onto that header.
    const draggedSessionId = moved[1] ? moved[1].sessionId : moved[0].sessionId;
    const dropped = await runInWindow(
      window,
      `(() => {
        const row = document.querySelector('[data-session-row="${draggedSessionId}"]');
        const header = document.querySelector('[data-group-header="${temporary.id}"]');
        if (!row || !header) { return false; }
        const wrapper = row.closest(".session-row-wrapper");
        const transfer = new DataTransfer();
        wrapper.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
        header.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        header.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        return true;
      })()`
    );
    await wait(800);
    const afterDrop = sessionGroups.get().membership[draggedSessionId];
    console.log(`[smoke5] drag and drop onto the header: dispatched=${dropped}, membership now ${afterDrop}`);
    if (afterDrop !== temporary.id) {
      throw new Error("drag and drop did not move the session into the group");
    }

    // Delete the group again, through its menu and its confirmation.
    await runInWindow(
      window,
      `(() => {
        const button = document.querySelector('[data-group-menu-button="${temporary.id}"]');
        if (!button) { return false; }
        button.scrollIntoView({ block: "center" });
        button.click();
        return true;
      })()`
    );
    await wait(600);
    await runInWindow(
      window,
      `(() => {
        const items = Array.from(document.querySelectorAll(".popup-menu-item"));
        const item = items.find((node) => node.textContent.trim() === "Delete group");
        if (!item) { return false; }
        item.click();
        return true;
      })()`
    );
    await wait(500);
    const confirmed = await runInWindow(
      window,
      `(() => {
        const items = Array.from(document.querySelectorAll(".popup-menu-item"));
        const item = items.find((node) => node.textContent.trim() === "Delete group");
        if (!item) { return false; }
        item.click();
        return true;
      })()`
    );
    await wait(800);
    const afterDelete = sessionGroups.get();
    console.log(
      `[smoke5] delete confirmed=${confirmed}; group gone=${!afterDelete.groups.some((entry) => entry.id === temporary.id)}; the dragged session is back in Default=${!afterDelete.membership[draggedSessionId]}`
    );
    if (afterDelete.groups.some((entry) => entry.id === temporary.id) || afterDelete.membership[draggedSessionId]) {
      throw new Error("deleting the group did not put its sessions back into Default");
    }
    // Put the session back where the smoke found it.
    sessionGroups.assignSession(draggedSessionId, group.id);
    await wait(400);

    // 4c. The "+" on a group header opens the folder sheet labelled with that
    //     group. (Confirming it would spawn `claude` in one of the user's real
    //     project folders, so the smoke stops at the label.)
    await runInWindow(
      window,
      `(() => {
        const button = document.querySelector('[data-group-new="${group.id}"]');
        if (!button) { return false; }
        button.click();
        return true;
      })()`
    );
    await wait(700);
    const sheetLabel = await runInWindow(
      window,
      '(() => { const sheet = document.querySelector("[data-new-session-sheet] .sheet-group"); return sheet ? sheet.textContent : "sheet without a group label"; })()'
    );
    console.log(`[smoke5] group header "+" -> ${sheetLabel}`);
    await runInWindow(
      window,
      '(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()'
    );
    await wait(500);

    // 5. Round trip: reload the renderer and see the same groups come back,
    //    both from the file on disk and in the rebuilt DOM.
    window.webContents.reload();
    await wait(3500);
    const headersAfterReload = await runInWindow(
      window,
      '(() => Array.from(document.querySelectorAll(".group-header .group-name")).map((node) => node.textContent).join(" / "))()'
    );
    const hiddenLineAfterReload = await runInWindow(
      window,
      '(() => { const line = document.querySelector("[data-hidden-toggle]"); return line ? line.innerText.trim() : null; })()'
    );
    const stored = sessionGroups.get();
    console.log(`[smoke5] after reload, headers: ${headersAfterReload}`);
    console.log(`[smoke5] after reload, hidden line: ${hiddenLineAfterReload}`);
    console.log(
      `[smoke5] store: groups=${stored.groups.length} membership=${Object.keys(stored.membership).length} hidden=${stored.hidden.length}`
    );

    // 6. A hidden session that is busy again must come back by itself.
    //    The status is re-read now, not taken from the list above: a session
    //    that was running a minute ago may well be idle by this point.
    const freshRows = (await listSessions()).sessions;
    const runningSession = freshRows.find((session) => session.statusGroup === "running");
    if (runningSession) {
      sessionGroups.setHidden(runningSession.sessionId, true);
      const wasHidden = sessionGroups.get().hidden.includes(runningSession.sessionId);
      syncHiddenWithLiveStatus();
      const stillHidden = sessionGroups.get().hidden.includes(runningSession.sessionId);
      console.log(
        `[smoke5] auto-unhide of a running session (${runningSession.sessionId}): hidden=${wasHidden} -> hidden=${stillHidden}`
      );
      if (!wasHidden || stillHidden) {
        throw new Error("a hidden session that is running again was not unhidden");
      }
    } else {
      console.log("[smoke5] WARNING: no running session to test the auto-unhide with");
    }

    // 7. Put the borrowed sessions back on the list (the group stays).
    for (const session of hiddenRows) {
      sessionGroups.setHidden(session.sessionId, false);
    }
    await wait(600);
    console.log(`[smoke5] cleaned up, hidden now: ${sessionGroups.get().hidden.length}`);
    await wait(400);
    quit();
  } catch (error) {
    console.log(`[smoke5] failed: ${error && error.message ? error.message : error}`);
    await capture(window, "stage5-failed.png");
    await wait(600);
    quit();
  }
}
