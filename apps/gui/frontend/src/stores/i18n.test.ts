import { describe, expect, it } from "vitest";
import en from "~/i18n/en";
import es from "~/i18n/es";
import fr from "~/i18n/fr";
import pt from "~/i18n/pt";
import uiEn from "~/i18n/ui/en";
import uiZh from "~/i18n/ui/zh";
import zh from "~/i18n/zh";
import { i18n, SUPPORTED_LANGUAGES, tx } from "~/stores/i18n";

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

  it("keeps the complete Chinese UI catalogue aligned with its English source", () => {
    expect(Object.keys(uiZh).sort()).toEqual(Object.keys(uiEn).sort());
  });

  it("switches translations in memory", async () => {
    await i18n.setLocale("es");

    expect(i18n.locale).toBe("es");
    expect(i18n.t("appearance.light")).toBe("Claro");

    await i18n.setLocale("en");
  });

  it("publishes the five languages used by the settings picker", () => {
    expect(i18n.supportedCodes).toEqual([...SUPPORTED_LANGUAGES]);
  });

  it("renders project chrome from the complete Chinese UI catalogue", async () => {
    await i18n.setLocale("zh");

    expect(tx("Task log")).toBe("任务日志");
    expect(tx("{count} tasks are still running", { count: 3 })).toBe("仍有 3 个任务在运行");

    await i18n.setLocale("en");
  });
});
