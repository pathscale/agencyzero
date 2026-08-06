import { describe, expect, it } from "vitest";
import type { Message, PricingTable } from "~/types";
import {
  compactEstimate,
  compactedContextTokens,
  compactionCost,
  costLabel,
  estimate,
  estimateTokens,
  estimateTurnCost,
  thinkingCostPerThousand,
  turnCostTotals,
} from "./pricing";

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
  cacheWriteMultiple: 2.0,
  warnUsd: 0.5,
  highUsd: 2.0,
};

function turn(model: string, usage: Message["usage"]): Message {
  return {
    id: Math.random().toString(36),
    projectId: "project",
    itemId: null,
    author: "agent",
    agent: model.startsWith("gpt") ? "codex" : "claude",
    moderation: null,
    model,
    permission: "auto",
    usage,
    stop: "completed",
    exitCode: 0,
    body: "done",
    createdAt: "2026-08-06T00:00:00.000Z",
  };
}

describe("estimateTokens", () => {
  it("errs high, four chars to a token", () => {
    expect(estimateTokens("0123456789012345678901234567890123456789")).toBe(10);
    // Rounds up rather than truncating — a partial token still costs.
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("turnCostTotals", () => {
  it("does not price continued transcript chunks as extra turns", () => {
    const chunk = turn("gpt-5.4", null);
    chunk.stop = "continued";

    expect(turnCostTotals(table, [chunk])).toEqual({
      usd: null,
      estimated: false,
      missing: 0,
    });
  });

  it("combines reported costs with labeled estimates and keeps legacy gaps partial", () => {
    const totals = turnCostTotals(table, [
      turn("opus", {
        tokens: 10,
        contextTokens: 10,
        contextWindow: null,
        cacheReads: 0,
        reasoningTokens: null,
        costUsd: 0.5,
        premiumRequests: null,
        durationMs: null,
      }),
      turn("gpt-5.4", {
        tokens: 112_000,
        inputTokens: 10_000,
        outputTokens: 2_000,
        contextTokens: 110_000,
        contextWindow: null,
        cacheReads: 100_000,
        cacheWrites: 0,
        reasoningTokens: null,
        costUsd: null,
        premiumRequests: null,
        durationMs: null,
      }),
      turn("gpt-5.4", {
        tokens: 50_000,
        contextTokens: 50_000,
        contextWindow: null,
        cacheReads: 40_000,
        reasoningTokens: null,
        costUsd: null,
        premiumRequests: null,
        durationMs: null,
      }),
    ]);

    expect(totals.usd).toBeCloseTo(0.58, 8);
    expect(totals.estimated).toBe(true);
    expect(totals.missing).toBe(1);
  });

  it("leaves the total absent when no turn can be priced", () => {
    expect(turnCostTotals(null, [turn("gpt-5.4", null)])).toEqual({
      usd: null,
      estimated: false,
      missing: 1,
    });
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

  it("prices a model switch as a cold cache write", () => {
    const warm = estimate(table, "opus", "next", 500_000, 1000);
    const cold = estimate(table, "opus", "next", 500_000, 1000, true);
    expect(cold.coldContext).toBe(true);
    expect(cold.contextCost).toBeCloseTo((500_000 * 5 * 2) / 1_000_000, 10);
    expect(cold.contextCost).toBeGreaterThan(warm.contextCost);
  });

  it("matches locally observed Claude compaction costs", () => {
    // Actual completed wrapped compacts in this install, versus the
    // pre-compact processed context. The fitted curve stays within 1%.
    expect(compactionCost(table, "opus", 622_244)).toBeCloseTo(6.5101765, 1);
    expect(compactionCost(table, "opus", 867_486)).toBeCloseTo(9.130281, 1);
    expect(compactionCost(table, "opus", 32_793)).toBeCloseTo(0.36802375, 1);
    expect(compactionCost(table, "opus", 167_354)).toBeCloseTo(1.77105, 1);
  });

  it("projects the retained compact segment from the measured result", () => {
    expect(compactedContextTokens(0)).toBe(0);
    expect(compactedContextTokens(32_793)).toBe(8_000);
    expect(compactedContextTokens(167_354)).toBe(8_000);
    expect(compactedContextTokens(622_244)).toBe(12_445);
  });

  it("quotes extra thinking at the model output rate per thousand", () => {
    expect(thinkingCostPerThousand(table, "opus")).toBe(0.025);
  });

  it("prices a typed /compact as the compaction pass, not a turn", () => {
    // No drafted prompt is sent. The cost is split between rewriting the
    // eligible context and generating the retained summary/learning output.
    const est = compactEstimate(table, "opus", 500_000);
    expect(est.total).toBeCloseTo(compactionCost(table, "opus", 500_000), 10);
    expect(est.inputCost).toBe(0);
    expect(est.outputCost).toBeGreaterThan(0);
    expect(est.outputTokens).toBe(10_000);
    expect(est.contextCost + est.outputCost).toBe(est.total);
    // Severity comes from the same thresholds a turn uses: this 500k session's
    // ~$5.25 compaction is correctly flagged high instead of the old ~$0.70.
    expect(est.severity).toBe("high");
  });
});

describe("estimateTurnCost", () => {
  it("decomposes a finished turn from its token figures", () => {
    // 10k fresh input, 90k cache reads, and 10k output.
    const usd = estimateTurnCost(table, "claude-opus-4-8", {
      inputTokens: 10_000,
      outputTokens: 10_000,
      cacheReads: 90_000,
      cacheWrites: 0,
    });
    // 90k*0.5 + 10k*5 + 10k*25, all per million.
    const expected = (90_000 * 0.5 + 10_000 * 5.0 + 10_000 * 25.0) / 1_000_000;
    expect(usd).toBeCloseTo(expected, 10);
  });

  it("returns null for an unpriced model", () => {
    expect(
      estimateTurnCost(table, "mystery", {
        inputTokens: 500,
        outputTokens: 500,
        cacheReads: 0,
      }),
    ).toBeNull();
  });

  it("refuses to invent output cost for a legacy multi-call turn", () => {
    expect(estimateTurnCost(table, "gpt-5.6-sol", { cacheReads: 5_000_000 })).toBeNull();
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
