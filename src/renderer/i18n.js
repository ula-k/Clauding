// A very small translation helper: translate("key", { count: 3 }) looks the key up
// in the active language, falling back to English, and fills {placeholders}.
import { createContext, useContext } from "react";
import englishStrings from "./locales/en.json";
import polishStrings from "./locales/pl.json";
import spanishStrings from "./locales/es.json";
import simplifiedChineseStrings from "./locales/zh-CN.json";
import { detectSystemLanguage as detectSystemLanguageFor } from "./languageDetection.js";

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

// The system-language rule itself lives in languageDetection.js; the codes it
// may answer with are the ones this file has a table for.
export function detectSystemLanguage(candidate) {
  return detectSystemLanguageFor(candidate, Object.keys(STRINGS_BY_LANGUAGE));
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
