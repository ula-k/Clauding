// Which of the app's four languages the operating system is asking for.
// Kept apart from i18n.js because that file imports React and the locale
// JSON the way Vite loads them, and this rule is worth checking on its own
// (test/i18n.test.js).

// The codes there are translations for; the same four files live in locales/.
export const SUPPORTED_LANGUAGE_CODES = ["en", "pl", "es", "zh-CN"];

// What the operating system reports ("pl", "es-ES", "zh-Hans-CN") mapped onto
// the codes above. Chinese needs the whole tag, not just the first two
// letters, so every Simplified variant lands on one file. A Traditional tag
// ("zh-TW", "zh-Hant") lands there too, through the bare "zh" entry: there is
// no Traditional translation yet, and Simplified reads closer to it than
// English does. Anything the app has no strings for falls back to English.
export const SYSTEM_LANGUAGE_ALIASES = {
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-sg": "zh-CN"
};

export function detectSystemLanguage(candidate, supportedCodes = SUPPORTED_LANGUAGE_CODES) {
  const source = String(candidate || (typeof navigator !== "undefined" ? navigator.language : "en") || "en");
  const fullTag = source.toLowerCase();
  if (SYSTEM_LANGUAGE_ALIASES[fullTag]) {
    return SYSTEM_LANGUAGE_ALIASES[fullTag];
  }
  // "zh-Hans-CN" and friends: try the language plus the script or region.
  const [languagePart, secondPart] = fullTag.split("-");
  if (secondPart && SYSTEM_LANGUAGE_ALIASES[`${languagePart}-${secondPart}`]) {
    return SYSTEM_LANGUAGE_ALIASES[`${languagePart}-${secondPart}`];
  }
  if (SYSTEM_LANGUAGE_ALIASES[languagePart]) {
    return SYSTEM_LANGUAGE_ALIASES[languagePart];
  }
  return supportedCodes.includes(languagePart) ? languagePart : "en";
}
