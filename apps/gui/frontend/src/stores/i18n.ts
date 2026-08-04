import { createI18n } from "@pathscale/ui/components/language-switcher";
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
export const i18n = createI18n({
  languages: SUPPORTED_LANGUAGES.map((code) => ({ code, name: NAMES[code] })),
  defaultLanguage: "en",
  storageKey: "agencyzero:locale",
  initialTranslations: en,
  loadTranslations: async (locale) => CATALOGUES[locale as SupportedLanguage] ?? CATALOGUES.en,
});

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
