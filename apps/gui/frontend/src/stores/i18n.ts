import { createI18n } from "@pathscale/ui/components/language-switcher";
import en from "~/i18n/en";
import es from "~/i18n/es";
import fr from "~/i18n/fr";
import pt from "~/i18n/pt";
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
