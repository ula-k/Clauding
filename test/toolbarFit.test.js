// The terminal header's one line: which controls stay on it and which fall
// into the "…" (src/renderer/toolbarFit.js). Nothing renders here — the
// fitting is a pure function of measured widths, so it can be checked dry.
import test from "node:test";
import assert from "node:assert/strict";
import { fitToolbar, HEADER_ITEM_PRIORITY } from "../src/renderer/toolbarFit.js";

const wideEnoughForEverything = 1000;

function headerItems() {
  return [
    { id: "agent", width: 120, priority: HEADER_ITEM_PRIORITY.agentChip },
    { id: "status", width: 100, priority: HEADER_ITEM_PRIORITY.statusPill },
    { id: "fork", width: 90, priority: HEADER_ITEM_PRIORITY.fork },
    { id: "createAgent", width: 140, priority: HEADER_ITEM_PRIORITY.createAgent },
    { id: "harvestSkills", width: 140, priority: HEADER_ITEM_PRIORITY.harvestSkills }
  ];
}

test("a wide header keeps every control, in the order it is drawn", () => {
  const fitted = fitToolbar({
    availableWidth: wideEnoughForEverything,
    items: headerItems(),
    overflowButtonWidth: 40
  });
  assert.deepEqual(fitted.visible, ["agent", "status", "fork", "createAgent", "harvestSkills"]);
  assert.deepEqual(fitted.overflowed, []);
});

test("the “…” width is reserved only when something overflows", () => {
  const items = headerItems();
  const exactWidth = items.reduce((total, item) => total + item.width, 0);
  // Room for the controls and not a pixel more: the "…" would not be shown,
  // so its width must not push a control off the line.
  const exactly = fitToolbar({ availableWidth: exactWidth, items, overflowButtonWidth: 40 });
  assert.deepEqual(exactly.overflowed, []);
  assert.equal(exactly.visible.length, items.length);

  // One pixel less, and the "…" appears — so its width is now part of the
  // bill, and 40 + 1 pixels' worth of controls have to go.
  const oneLess = fitToolbar({ availableWidth: exactWidth - 1, items, overflowButtonWidth: 40 });
  assert.deepEqual(oneLess.overflowed, ["harvestSkills"]);
  assert.equal(
    oneLess.visible.reduce((total, id) => total + items.find((item) => item.id === id).width, 0),
    exactWidth - 140
  );
});

test("what stays follows priority, not the order the controls are drawn in", () => {
  // Drawn low priority first, high priority last — the opposite of the
  // priority order, so a naive left-to-right fit would keep the wrong ones.
  const items = [
    { id: "harvestSkills", width: 140, priority: HEADER_ITEM_PRIORITY.harvestSkills },
    { id: "createAgent", width: 140, priority: HEADER_ITEM_PRIORITY.createAgent },
    { id: "fork", width: 90, priority: HEADER_ITEM_PRIORITY.fork },
    { id: "status", width: 100, priority: HEADER_ITEM_PRIORITY.statusPill },
    { id: "agent", width: 120, priority: HEADER_ITEM_PRIORITY.agentChip }
  ];
  const fitted = fitToolbar({ availableWidth: 300, items, overflowButtonWidth: 40 });
  // 260 of the 260 available (300 - 40 for the "…"): the agent chip and the
  // status pill, the two that matter most — although they are drawn last.
  assert.deepEqual(fitted.visible, ["status", "agent"]);
  assert.deepEqual(fitted.overflowed, ["fork", "createAgent", "harvestSkills"]);
});

test("the “…” lists what overflowed in priority order, most important first", () => {
  const fitted = fitToolbar({ availableWidth: 260, items: headerItems(), overflowButtonWidth: 40 });
  assert.deepEqual(fitted.visible, ["agent", "status"]);
  assert.deepEqual(fitted.overflowed, ["fork", "createAgent", "harvestSkills"]);
});

test("a control refused for its size does not make room for a smaller, lesser one", () => {
  const items = [
    { id: "wideAndImportant", width: 200, priority: 90 },
    { id: "narrowAndNot", width: 20, priority: 10 }
  ];
  const fitted = fitToolbar({ availableWidth: 100, items, overflowButtonWidth: 40 });
  assert.deepEqual(fitted.visible, []);
  assert.deepEqual(fitted.overflowed, ["wideAndImportant", "narrowAndNot"]);
});

test("a header with no room at all puts everything in the “…”", () => {
  const fitted = fitToolbar({ availableWidth: 10, items: headerItems(), overflowButtonWidth: 40 });
  assert.deepEqual(fitted.visible, []);
  assert.deepEqual(fitted.overflowed, ["agent", "status", "fork", "createAgent", "harvestSkills"]);
});

test("no controls at all is not an overflow", () => {
  const fitted = fitToolbar({ availableWidth: 0, items: [], overflowButtonWidth: 40 });
  assert.deepEqual(fitted.visible, []);
  assert.deepEqual(fitted.overflowed, []);
});

test("controls of equal priority fall out from the right, the way they are drawn", () => {
  const items = [
    { id: "first", width: 100, priority: 50 },
    { id: "second", width: 100, priority: 50 },
    { id: "third", width: 100, priority: 50 }
  ];
  const fitted = fitToolbar({ availableWidth: 240, items, overflowButtonWidth: 40 });
  assert.deepEqual(fitted.visible, ["first", "second"]);
  assert.deepEqual(fitted.overflowed, ["third"]);
});

test("every header control has a priority of its own", () => {
  const priorities = Object.values(HEADER_ITEM_PRIORITY);
  assert.equal(new Set(priorities).size, priorities.length);
  // Ula's order: the agent chip outranks the status pill, which outranks
  // Fork, which outranks the two meta actions.
  assert.ok(HEADER_ITEM_PRIORITY.agentChip > HEADER_ITEM_PRIORITY.statusPill);
  assert.ok(HEADER_ITEM_PRIORITY.statusPill > HEADER_ITEM_PRIORITY.fork);
  assert.ok(HEADER_ITEM_PRIORITY.fork > HEADER_ITEM_PRIORITY.createAgent);
  assert.ok(HEADER_ITEM_PRIORITY.createAgent > HEADER_ITEM_PRIORITY.harvestSkills);
});
