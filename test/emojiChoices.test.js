// CL-15 — the emoji field of the agent form keeps one whole character
// (src/renderer/emojiChoices.js), and the built-in list it offers.
// Pure functions: no Electron, no files, no window.
import test from "node:test";
import assert from "node:assert/strict";
import { EMOJI_GROUPS, filterEmojiGroups, firstGrapheme } from "../src/renderer/emojiChoices.js";
import { DEFAULT_AGENT_EMOJI } from "../src/renderer/agentConstants.js";

test("a pasted emoji with text after it keeps only the emoji", () => {
  assert.equal(firstGrapheme("✅ Test"), "✅");
  assert.equal(firstGrapheme("📐 spec writer"), "📐");
  assert.equal(firstGrapheme("Test ✅"), "T", "the first character is the first character");
});

test("a joined emoji stays in one piece", () => {
  assert.equal(firstGrapheme("🧑‍💻"), "🧑‍💻");
  assert.equal(firstGrapheme("🧑‍💻 developer"), "🧑‍💻");
  assert.equal(firstGrapheme("👩🏽‍🔬"), "👩🏽‍🔬", "skin tone and the joined part both stay");
  assert.equal(firstGrapheme("👩🏽‍🔬 researcher"), "👩🏽‍🔬");
});

test("the spaces around the field's text are dropped", () => {
  assert.equal(firstGrapheme("  🧑‍💻 developer  "), "🧑‍💻");
  assert.equal(firstGrapheme("\n📐\t"), "📐");
  assert.equal(firstGrapheme("   "), "");
  assert.equal(firstGrapheme(""), "");
  assert.equal(firstGrapheme(null), "");
});

test("the built-in list is made of single whole emoji", () => {
  const choices = EMOJI_GROUPS.flatMap((group) => group.choices);
  assert.ok(choices.length > 50, "there is a list worth opening");
  for (const choice of choices) {
    assert.equal(firstGrapheme(choice.emoji), choice.emoji, `${choice.emoji} is one whole character`);
    assert.ok(choice.keywords.length > 0, `${choice.emoji} can be searched for`);
  }
  assert.ok(choices.some((choice) => choice.emoji === DEFAULT_AGENT_EMOJI), "the default is offered too");
});

test("every emoji in the list is offered only once", () => {
  const seen = new Set();
  for (const group of EMOJI_GROUPS) {
    for (const choice of group.choices) {
      assert.equal(seen.has(choice.emoji), false, `${choice.emoji} is listed twice`);
      seen.add(choice.emoji);
    }
  }
});

test("searching the list keeps only the rows that match", () => {
  assert.deepEqual(filterEmojiGroups(""), EMOJI_GROUPS, "an empty search shows everything");
  const rocket = filterEmojiGroups("rocket");
  assert.deepEqual(rocket.flatMap((group) => group.choices).map((choice) => choice.emoji), ["🚀"]);
  assert.deepEqual(filterEmojiGroups("  ROCKET "), rocket, "case and spaces do not matter");
  assert.deepEqual(filterEmojiGroups("🚀").flatMap((group) => group.choices).map((choice) => choice.emoji), ["🚀"]);
  assert.deepEqual(filterEmojiGroups("nothing matches this"), []);
});
