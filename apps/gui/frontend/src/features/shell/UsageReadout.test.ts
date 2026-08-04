import { describe, expect, it } from "vitest";
import { windowTitle, windowValue } from "~/features/shell/UsageReadout";
import type { QuotaWindow } from "~/types";

const NOW = Date.parse("2026-08-04T00:00:00Z");

describe("Codex account usage", () => {
  it("presents the provider percentage as amount used, not amount remaining", () => {
    const window: QuotaWindow = {
      window: "primary",
      usedFraction: 0.45,
      windowMinutes: 10_080,
      resetsAt: null,
    };

    expect(windowValue(window, NOW)).toBe("45% used");
    expect(windowTitle("Codex", window)).toContain("45% used");
  });
});
