import { describe, expect, it } from "vitest";
import type { PricingTable } from "~/types";
import { costLabel, estimate, estimateTokens, estimateTurnCost } from "./pricing";

// A small table mirroring the real one's shape and longest-key-first order.
// Claude keys are the bare picker alias (`opus`, not `claude-opus`), because a
// tab stores Claude's model as that short alias — a `claude-` prefix here would
// miss it and the estimate would never price a Claude turn.
const table: PricingTable = {
  rows: [
    { key: "opus", input: 5.0, output: 25.0, cacheRead: 0.5 },
    { key: "fable", input: 10.0, output: 50.0, cacheRead: 1.0 },
    { key: "gpt-5.4-mini", input: 0.75, output: 4.5, cacheRead: 0.075 },
    { key: "gpt-5.4", input: 2.5, output: 15.0, cacheRead: 0.25 },
  ],
  cacheWriteMultiple: 1.25,
  warnUsd: 0.5,
  highUsd: 2.0,
};

describe("estimateTokens", () => {
  it("errs high, four chars to a token", () => {
    expect(estimateTokens("0123456789012345678901234567890123456789")).toBe(10);
    // Rounds up rather than truncating — a partial token still costs.
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("estimate", () => {
  it("marks an unpriced model rather than reporting $0", () => {
    const est = estimate(table, "some-unknown-model", "hello", 1000);
    expect(est.priced).toBe(false);
    expect(est.total).toBe(0);
  });

  it("prices the bare picker alias, not only the full id", () => {
    // The bug where the estimate never appeared: the tab's model is "opus",
    // and a "claude-opus" key missed it. Both spellings must price.
    expect(estimate(table, "opus", "hi", 0, 1000).priced).toBe(true);
    expect(estimate(table, "claude-opus-4-8", "hi", 0, 1000).priced).toBe(true);
  });

  it("resolves the most specific key first", () => {
    // gpt-5.4-mini must not price as gpt-5.4.
    const mini = estimate(table, "gpt-5.4-mini", "x".repeat(400), 0, 1000);
    // 100 input tokens * 0.75/M + 1000 output * 4.5/M
    expect(mini.inputCost).toBeCloseTo((100 * 0.75) / 1_000_000, 10);
    expect(mini.outputCost).toBeCloseTo((1000 * 4.5) / 1_000_000, 10);
  });

  it("lets a big warm context dominate a short prompt", () => {
    const est = estimate(table, "claude-opus-4-8", "one line", 500_000, 1000);
    expect(est.contextCost).toBeGreaterThan(est.inputCost);
  });

  it("flags a dollar-heavy turn high and keeps a tiny one quiet", () => {
    const heavy = estimate(table, "claude-fable-5", "do a big thing", 900_000, 40_000);
    expect(heavy.severity).toBe("high");
    const tiny = estimate(table, "gpt-5.4-mini", "hi", 200, 100);
    expect(tiny.severity).toBe("low");
  });
});

describe("estimateTurnCost", () => {
  it("decomposes a finished turn from its token figures", () => {
    // 100k context, 90k of it cache reads, 10k output beyond context.
    const usd = estimateTurnCost(table, "claude-opus-4-8", {
      tokens: 110_000,
      contextTokens: 100_000,
      cacheReads: 90_000,
    });
    // 90k*0.5 + 10k*5 + 10k*25, all per million.
    const expected = (90_000 * 0.5 + 10_000 * 5.0 + 10_000 * 25.0) / 1_000_000;
    expect(usd).toBeCloseTo(expected, 10);
  });

  it("returns null for an unpriced model", () => {
    expect(
      estimateTurnCost(table, "mystery", { tokens: 1000, contextTokens: 500, cacheReads: 0 }),
    ).toBeNull();
  });
});

describe("costLabel", () => {
  it("scales precision with magnitude", () => {
    expect(costLabel(0)).toBe("$0");
    expect(costLabel(0.0042)).toBe("$0.0042");
    expect(costLabel(0.42)).toBe("$0.420");
    expect(costLabel(1.23)).toBe("$1.23");
    expect(costLabel(123.4)).toBe("$123");
  });
});
