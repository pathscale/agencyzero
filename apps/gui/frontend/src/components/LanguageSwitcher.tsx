import {
  LanguageSwitcher as LibraryLanguageSwitcher,
  type LanguageSwitcherProps as LibraryLanguageSwitcherProps,
} from "@pathscale/ui/components/language-switcher";
import type { Component } from "solid-js";
import { i18n } from "~/stores/i18n";

type LanguageSwitcherProps = Omit<LibraryLanguageSwitcherProps, "i18n">;

/** AgencyZero labels over the same shared control NoFilter uses. */
export const LanguageSwitcher: Component<LanguageSwitcherProps> = (props) => (
  <LibraryLanguageSwitcher
    {...props}
    i18n={i18n}
    aria-label={i18n.t("language.selector")}
    currentLanguageLabel={i18n.t("language.current")}
    optionsLabel={i18n.t("language.options")}
    loadingLabel={i18n.t("language.loading")}
  />
);

export default LanguageSwitcher;
