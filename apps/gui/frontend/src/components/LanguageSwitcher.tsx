import {
  LanguageSwitcher as LibraryLanguageSwitcher,
  type LanguageSwitcherProps as LibraryLanguageSwitcherProps,
} from "@pathscale/ui/components/language-switcher";
import type { Component } from "solid-js";
import { i18n, type SupportedLanguage, tx } from "~/stores/i18n";
import { useWorkspace } from "~/stores/workspace";

type LanguageSwitcherProps = Omit<LibraryLanguageSwitcherProps, "i18n">;

/** AgencyZero labels over the same shared control NoFilter uses. */
export const LanguageSwitcher: Component<LanguageSwitcherProps> = (props) => {
  const { actions } = useWorkspace();
  return (
    <LibraryLanguageSwitcher
      {...props}
      i18n={i18n}
      onLanguageChange={(locale) =>
        void actions.saveSettings({ locale: locale as SupportedLanguage })
      }
      aria-label={tx("Language selector")}
      currentLanguageLabel={tx("Current language")}
      optionsLabel={tx("Language options")}
      loadingLabel={tx("Loading language")}
    />
  );
};

export default LanguageSwitcher;
