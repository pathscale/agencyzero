import { describe, expect, it } from "vitest";
import { compactCount, contextUsed, costLabel, usageTotals } from "~/lib/stats";
import type { Message } from "~/types";

function usage(partial: Partial<NonNullable<Message["usage"]>>): Message["usage"] {
  return {
    tokens: 0,
    contextTokens: null,
    contextWindow: null,
    cacheReads: null,
    reasoningTokens: null,
    costUsd: null,
    premiumRequests: null,
    durationMs: null,
    ...partial,
  };
}

function turn(
  author: Message["author"],
  usage: Message["usage"] = null,
  id = Math.random().toString(36),
): Message {
  return {
    id,
    projectId: "proj_1",
    itemId: null,
    author,
    agent: "claude",
    moderation: null,
    model: "claude-opus-5",
    permission: "read_only",
    usage,
    stop: "completed",
    exitCode: 0,
    body: "…",
    createdAt: "2026-07-29T12:00:00.000Z",
  };
}

describe("usageTotals", () => {
  /*
   * Only agent turns carry usage. Counting the user's messages would double
   * every conversation's turn count, which is the number people read first.
   */
  it("counts agent turns only", () => {
    const totals = usageTotals([
      turn("user"),
      turn("agent", usage({ tokens: 100, cacheReads: 10, costUsd: 0.01, premiumRequests: null })),
      turn("user"),
      turn("agent", usage({ tokens: 200, cacheReads: 20, costUsd: 0.02, premiumRequests: null })),
    ]);

    expect(totals.turns).toBe(2);
    expect(totals.tokens).toBe(300);
    expect(totals.costUsd).toBeCloseTo(0.03, 6);
    // Latest, not 30: see the accumulation test below.
    expect(totals.cacheReads).toBe(20);
  });

  /*
   * The distinction the whole module turns on: a run that reported nothing is
   * not a free run. Summing absent costs into 0 would say the session cost
   * nothing, which is a number someone might actually act on.
   */
  it("leaves cost null when no turn priced itself, rather than reporting zero", () => {
    const totals = usageTotals([turn("agent"), turn("agent")]);

    expect(totals.turns).toBe(2);
    expect(totals.reported).toBe(0);
    expect(totals.costUsd).toBeNull();
    expect(costLabel(totals.costUsd)).toBe("—");
  });

  it("flags a partial total when only some turns reported", () => {
    const totals = usageTotals([
      turn("agent", usage({ tokens: 100, cacheReads: 0, costUsd: 0.01, premiumRequests: null })),
      turn("agent"),
    ]);

    expect(totals.turns).toBe(2);
    expect(totals.reported).toBe(1);
    expect(totals.costUsd).toBeCloseTo(0.01, 6);
  });

  /*
   * Rows written by an older build carry `agent-abstraction`'s own shape, whose
   * fields are snake_case and have no `tokens` at all. Adding `undefined` gives
   * NaN, which renders as "NaN tok" rather than failing loudly.
   */
  it("ignores a usage blob in the crate's shape instead of totalling NaN", () => {
    const fromAnOlderBuild = {
      input_tokens: 1_200,
      output_tokens: 300,
      cost_usd: 0.017,
    } as unknown as Message["usage"];

    const totals = usageTotals([turn("agent", fromAnOlderBuild)]);

    expect(totals.turns).toBe(1);
    expect(Number.isNaN(totals.tokens)).toBe(false);
    expect(totals.tokens).toBe(0);
    expect(totals.costUsd).toBeNull();
  });

  it("counts Copilot's premium requests separately from a dollar cost", () => {
    const totals = usageTotals([
      turn("agent", usage({ tokens: 10, cacheReads: 0, costUsd: null, premiumRequests: 2 })),
      turn("agent", usage({ tokens: 10, cacheReads: 0, costUsd: null, premiumRequests: 3 })),
    ]);

    expect(totals.premiumRequests).toBe(5);
    expect(totals.costUsd).toBeNull();
  });
});

describe("compactCount", () => {
  it("abbreviates at each order without losing the small numbers", () => {
    expect(compactCount(412)).toBe("412");
    expect(compactCount(18_700)).toBe("18.7k");
    expect(compactCount(2_400_000)).toBe("2.4M");
  });

  it("never renders a negative or a NaN as a count", () => {
    expect(compactCount(Number.NaN)).toBe("0");
    expect(compactCount(-5)).toBe("0");
  });
});

describe("the accumulation rule", () => {
  /*
   * This is the bug the crate's `Usage::accumulate` doc warns about, and which
   * this module had: summing the context-shaped fields.
   *
   * The agent re-sends the whole conversation each turn and reports it, mostly
   * as cache reads. Adding those up counts the same conversation once per turn,
   * so the error grows with the session — by turn ten a 30k-token conversation
   * reads as 300k. Additive fields add; context-shaped fields take the latest.
   */
  it("takes the latest context figure rather than summing it", () => {
    const totals = usageTotals([
      turn("agent", usage({ tokens: 100, contextTokens: 10_000, cacheReads: 9_000 })),
      turn("agent", usage({ tokens: 100, contextTokens: 22_000, cacheReads: 20_000 })),
      turn("agent", usage({ tokens: 100, contextTokens: 31_000, cacheReads: 29_000 })),
    ]);

    // New work each turn, so this one does add.
    expect(totals.tokens).toBe(300);
    expect(totals.contextTokens).toBe(31_000);
    expect(totals.cacheReads).toBe(29_000);
  });

  it("reports the share of the context window in use", () => {
    const totals = usageTotals([
      turn("agent", usage({ tokens: 100, contextTokens: 50_000, contextWindow: 200_000 })),
    ]);

    expect(contextUsed(totals)).toBeCloseTo(0.25, 6);
  });

  /*
   * Only Claude reports a window. Without one there is no share to show, and a
   * bar drawn from a guess is exactly the number someone would act on.
   */
  it("has no share when the agent reported no window", () => {
    const totals = usageTotals([turn("agent", usage({ tokens: 100, contextTokens: 50_000 }))]);
    expect(contextUsed(totals)).toBeNull();
  });

  it("has no share when the window is zero rather than dividing by it", () => {
    const totals = usageTotals([
      turn("agent", usage({ tokens: 1, contextTokens: 10, contextWindow: 0 })),
    ]);
    expect(contextUsed(totals)).toBeNull();
  });
});
