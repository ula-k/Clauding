// A very small translation helper: translate("key", { count: 3 }) looks the key up
// in the active language, falling back to English, and fills {placeholders}.
import { createContext, useContext } from "react";
import englishStrings from "./locales/en.json";
import polishStrings from "./locales/pl.json";
import spanishStrings from "./locales/es.json";
import simplifiedChineseStrings from "./locales/zh-CN.json";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "pl", label: "Polski" },
  { code: "es", label: "Español" },
  { code: "zh-CN", label: "简体中文" }
];

const STRINGS_BY_LANGUAGE = {
  en: englishStrings,
  pl: polishStrings,
  es: spanishStrings,
  "zh-CN": simplifiedChineseStrings
};

const STORAGE_KEY = "clauding.language";

// What the operating system reports ("pl", "es-ES", "zh-Hans-CN") mapped onto
// the codes above. Chinese needs the whole tag, not just the first two
// letters, so every Simplified variant lands on one file. A Traditional tag
// ("zh-TW", "zh-Hant") lands there too, through the bare "zh" entry: there is
// no Traditional translation yet, and Simplified reads closer to it than
// English does. Anything the app has no strings for falls back to English.
const SYSTEM_LANGUAGE_ALIASES = {
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-sg": "zh-CN"
};

export function detectSystemLanguage(candidate) {
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
  return STRINGS_BY_LANGUAGE[languagePart] ? languagePart : "en";
}

export function loadSavedLanguage() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved && STRINGS_BY_LANGUAGE[saved] ? saved : null;
  } catch (error) {
    return null;
  }
}

export function saveLanguage(languageCode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, languageCode);
  } catch (error) {
    // Storage may be unavailable; the choice simply will not persist.
  }
}

export function translateInLanguage(languageCode, key, values) {
  const table = STRINGS_BY_LANGUAGE[languageCode] || englishStrings;
  let text = table[key] || englishStrings[key] || key;
  if (values) {
    for (const [name, value] of Object.entries(values)) {
      text = text.replace(`{${name}}`, String(value));
    }
  }
  return text;
}

export const LanguageContext = createContext({
  language: "en",
  setLanguage: () => {}
});

export function useTranslation() {
  const { language, setLanguage } = useContext(LanguageContext);
  function translate(key, values) {
    return translateInLanguage(language, key, values);
  }
  return { translate, language, setLanguage };
}
