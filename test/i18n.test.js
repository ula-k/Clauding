// CL-18 — four languages that say the same things, and the language the app
// starts in (src/renderer/locales/*.json, src/renderer/languageDetection.js).
// The locale files are read from disk; nothing renders and no window is opened.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LANGUAGE_CODES, detectSystemLanguage } from "../src/renderer/languageDetection.js";

const localesFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "locales");

function tableFor(languageCode) {
  return JSON.parse(fs.readFileSync(path.join(localesFolder, `${languageCode}.json`), "utf8"));
}

test("there is one locale file per supported language, and no others", () => {
  const files = fs.readdirSync(localesFolder).filter((fileName) => fileName.endsWith(".json")).sort();
  assert.deepEqual(files, SUPPORTED_LANGUAGE_CODES.slice().sort().map((code) => `${code}.json`));
});

test("every language has exactly the keys English has", () => {
  const english = tableFor("en");
  const englishKeys = Object.keys(english).sort();
  assert.ok(englishKeys.length > 50, "there is a real interface to translate");
  for (const languageCode of SUPPORTED_LANGUAGE_CODES) {
    const table = tableFor(languageCode);
    const missing = englishKeys.filter((key) => !(key in table));
    const extra = Object.keys(table).filter((key) => !(key in english));
    assert.deepEqual(missing, [], `${languageCode} is missing keys`);
    assert.deepEqual(extra, [], `${languageCode} has keys English does not`);
  }
});

test("no translation is left as an empty string", () => {
  for (const languageCode of SUPPORTED_LANGUAGE_CODES) {
    for (const [key, text] of Object.entries(tableFor(languageCode))) {
      assert.equal(typeof text, "string", `${languageCode}.${key}`);
      assert.notEqual(text.trim(), "", `${languageCode}.${key} is empty`);
    }
  }
});

test("a placeholder used in English is used in every language too", () => {
  const english = tableFor("en");
  const placeholdersOf = (text) => (text.match(/\{[a-zA-Z]+\}/g) || []).sort();
  for (const languageCode of SUPPORTED_LANGUAGE_CODES) {
    const table = tableFor(languageCode);
    for (const [key, text] of Object.entries(english)) {
      assert.deepEqual(placeholdersOf(table[key]), placeholdersOf(text), `${languageCode}.${key}`);
    }
  }
});

test("the group Default is translated and the fork marker is not", () => {
  const defaults = SUPPORTED_LANGUAGE_CODES.map((languageCode) => tableFor(languageCode)["groups.default"]);
  assert.equal(new Set(defaults).size, SUPPORTED_LANGUAGE_CODES.length, "each language says it its own way");
  for (const languageCode of SUPPORTED_LANGUAGE_CODES) {
    const table = tableFor(languageCode);
    for (const [key, text] of Object.entries(table)) {
      assert.equal(text.includes("(fork)"), false, `${languageCode}.${key} should not carry the fork marker`);
    }
  }
});

test("the system language is matched by its whole tag, then by its language", () => {
  assert.equal(detectSystemLanguage("pl"), "pl");
  assert.equal(detectSystemLanguage("pl-PL"), "pl");
  assert.equal(detectSystemLanguage("es-419"), "es");
  assert.equal(detectSystemLanguage("en-US"), "en");
});

test("every Chinese variant lands on the one Chinese translation", () => {
  assert.equal(detectSystemLanguage("zh"), "zh-CN");
  assert.equal(detectSystemLanguage("zh-CN"), "zh-CN");
  assert.equal(detectSystemLanguage("zh-Hans"), "zh-CN");
  assert.equal(detectSystemLanguage("zh-Hans-CN"), "zh-CN");
  assert.equal(detectSystemLanguage("zh-SG"), "zh-CN");
  assert.equal(detectSystemLanguage("zh-TW"), "zh-CN", "no Traditional translation yet, Simplified is closer");
  assert.equal(detectSystemLanguage("zh-Hant-HK"), "zh-CN");
});

test("a language the app has no strings for falls back to English", () => {
  assert.equal(detectSystemLanguage("de"), "en");
  assert.equal(detectSystemLanguage("ja-JP"), "en");
  assert.equal(detectSystemLanguage(""), "en");
  assert.equal(detectSystemLanguage(null), "en");
  assert.equal(detectSystemLanguage(undefined), "en");
});
