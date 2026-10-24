import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import ja from "./locales/ja";

/** Languages the UI ships in. The label is always written in its own language. */
export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export const DEFAULT_LANGUAGE: LanguageCode = "en";
export const LANGUAGE_STORAGE_KEY = "printninja.language";

const resources = {
  en: { translation: en },
  ja: { translation: ja },
};

export function isSupportedLanguage(
  value: string | null | undefined,
): value is LanguageCode {
  return SUPPORTED_LANGUAGES.some((l) => l.code === value);
}

/**
 * Map a BCP-47 tag such as `ja-JP` or `en-US` to a supported language.
 * Returns null when no supported language matches.
 */
export function matchLanguage(
  tag: string | null | undefined,
): LanguageCode | null {
  if (!tag) return null;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return isSupportedLanguage(base) ? base : null;
}

function readStoredLanguage(): LanguageCode | null {
  try {
    const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Saved choice first, then the system language, then English. */
export function detectLanguage(): LanguageCode {
  const stored = readStoredLanguage();
  if (stored) return stored;
  const preferred =
    typeof navigator !== "undefined"
      ? [...(navigator.languages ?? []), navigator.language]
      : [];
  for (const tag of preferred) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}

/** The current UI language as a supported code. */
export function currentLanguage(): LanguageCode {
  return (
    matchLanguage(i18n.resolvedLanguage ?? i18n.language) ?? DEFAULT_LANGUAGE
  );
}

/** Switch the UI language and remember the choice on this device. */
export async function setLanguage(code: LanguageCode): Promise<void> {
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // Storage can be unavailable (private mode); the switch still applies.
  }
  await i18n.changeLanguage(code);
}

function syncDocumentLanguage(code: string) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = code;
  }
}

i18n.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
  interpolation: {
    escapeValue: false,
  },
});

syncDocumentLanguage(i18n.language);
i18n.on("languageChanged", syncDocumentLanguage);

export default i18n;
