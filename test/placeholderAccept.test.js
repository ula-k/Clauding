// Tab in an empty "Extra claude flags" field types the placeholder in
// (src/renderer/placeholderAccept.js). Nothing renders; only the decision
// behind the keystroke is checked.
import test from "node:test";
import assert from "node:assert/strict";
import { placeholderKeyDecision } from "../src/renderer/placeholderAccept.js";
import { EXTRA_FLAGS_PLACEHOLDER } from "../electron/lib/extraFlags.js";

const suggestion = EXTRA_FLAGS_PLACEHOLDER;

test("Tab in an empty field accepts the placeholder", () => {
  assert.equal(placeholderKeyDecision({ key: "Tab", value: "", placeholder: suggestion }), "accept");
});

test("the right arrow does the same thing", () => {
  assert.equal(placeholderKeyDecision({ key: "ArrowRight", value: "", placeholder: suggestion }), "accept");
});

test("Tab in a field with something in it still moves on", () => {
  assert.equal(placeholderKeyDecision({ key: "Tab", value: "--model sonnet", placeholder: suggestion }), "ignore");
});

test("Shift+Tab always moves on, so going back a field still works", () => {
  assert.equal(
    placeholderKeyDecision({ key: "Tab", value: "", placeholder: suggestion, hasModifier: true }),
    "ignore"
  );
});

test("a field with no placeholder has nothing to accept", () => {
  assert.equal(placeholderKeyDecision({ key: "Tab", value: "", placeholder: "" }), "ignore");
});

test("Escape clears a field that has something in it", () => {
  assert.equal(placeholderKeyDecision({ key: "Escape", value: "--model sonnet", placeholder: suggestion }), "clear");
});

test("Escape in an empty field is left to the sheet, which closes", () => {
  assert.equal(placeholderKeyDecision({ key: "Escape", value: "", placeholder: suggestion }), "ignore");
});

test("every other key is an ordinary keystroke", () => {
  assert.equal(placeholderKeyDecision({ key: "Enter", value: "", placeholder: suggestion }), "ignore");
  assert.equal(placeholderKeyDecision({ key: "a", value: "", placeholder: suggestion }), "ignore");
  assert.equal(placeholderKeyDecision(), "ignore");
});

test("the suggestion is the tagged form the CLI accepts", () => {
  // Untagged, the CLI answers "--channels entries must be tagged" and exits.
  assert.equal(suggestion, "--channels plugin:telegram@claude-plugins-official");
});
