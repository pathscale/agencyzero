import { describe, expect, it } from "vitest";
import en from "~/i18n/en";
import es from "~/i18n/es";
import fr from "~/i18n/fr";
import pt from "~/i18n/pt";
import zh from "~/i18n/zh";
import { i18n, SUPPORTED_LANGUAGES } from "~/stores/i18n";

function keysOf(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];

  return Object.entries(value)
    .flatMap(([key, child]) => keysOf(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

describe("interface languages", () => {
  it("keeps every bundled catalogue aligned with English", () => {
    const englishKeys = keysOf(en);
    for (const catalogue of [zh, es, pt, fr]) {
      expect(keysOf(catalogue)).toEqual(englishKeys);
    }
  });

  it("switches translations and persists the selected language", async () => {
    await i18n.setLocale("es");

    expect(i18n.locale).toBe("es");
    expect(i18n.t("appearance.light")).toBe("Claro");
    expect(localStorage.getItem("agencyzero:locale")).toBe("es");

    await i18n.setLocale("en");
  });

  it("publishes the five languages used by the settings picker", () => {
    expect(i18n.supportedCodes).toEqual([...SUPPORTED_LANGUAGES]);
  });
});
