import type { I18nStore } from "@pathscale/ui/components/language-switcher";
import { createSignal } from "solid-js";
import en from "~/i18n/en";
import es from "~/i18n/es";
import fr from "~/i18n/fr";
import pt from "~/i18n/pt";
import uiEn from "~/i18n/ui/en";
import uiZh from "~/i18n/ui/zh";
import zh from "~/i18n/zh";

export const SUPPORTED_LANGUAGES = ["en", "zh", "es", "pt", "fr"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  zh: "中文",
  es: "Español",
  pt: "Português",
  fr: "Français",
};

const CATALOGUES: Record<SupportedLanguage, Record<string, unknown>> = {
  en,
  zh,
  es,
  pt,
  fr,
};

/**
 * The same store and switcher contract used by NoFilter. Catalogues are bundled
 * because this is a desktop app that must change language without a network.
 * English remains the source and fallback as more screens migrate off literals.
 */
const [locale, setLocaleSignal] = createSignal<SupportedLanguage>("en");
const [translations, setTranslations] = createSignal<Record<string, unknown>>(en);
const [isLoading, setIsLoading] = createSignal(false);

function nestedTranslation(source: unknown, path: string): string {
  let value = source;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object") return path;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" ? value : path;
}

/**
 * Language state without browser persistence.
 *
 * The shared switcher's default store writes localStorage. AgencyZero's
 * durable owner settings belong in WorkTable, so this same UI contract keeps
 * language in memory and Workspace persists each selection through
 * `set_settings`.
 */
export const i18n: I18nStore = {
  get locale() {
    return locale();
  },
  get isLoading() {
    return isLoading();
  },
  t: (key) => nestedTranslation(translations(), key),
  async setLocale(requested) {
    const selected = SUPPORTED_LANGUAGES.includes(requested as SupportedLanguage)
      ? (requested as SupportedLanguage)
      : "en";
    setIsLoading(true);
    setTranslations(CATALOGUES[selected]);
    setLocaleSignal(selected);
    setIsLoading(false);
  },
  async init() {},
  languages: SUPPORTED_LANGUAGES.map((code) => ({ code, name: NAMES[code] })),
  languageNames: NAMES,
  supportedCodes: [...SUPPORTED_LANGUAGES],
};

export const t = i18n.t;

export type UiMessage = keyof typeof uiEn;

/**
 * Broad UI catalogue used by the English-string audit.
 *
 * English source text is the stable key: migrating a literal is a one-line
 * `tx("…")`, translators work in one flat file, and interpolation stays out of
 * translated grammar. Chinese is complete; other installed catalogues fall
 * back to English until their matching UI file is added.
 */
export function tx(message: UiMessage, values: Record<string, string | number> = {}): string {
  const catalogue = i18n.locale === "zh" ? uiZh : uiEn;
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    catalogue[message],
  );
}
