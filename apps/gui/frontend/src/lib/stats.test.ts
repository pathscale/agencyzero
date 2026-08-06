import { describe, expect, it } from "vitest";
import {
  cacheBreak,
  claudeWindowKind,
  compactCount,
  contextUsed,
  costLabel,
  usageTotals,
  withLiveContext,
} from "~/lib/stats";
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
    // Summed: a turn's cache figure is what that turn read, not the size of
    // the conversation, so the session's reads add up.
    expect(totals.cacheReads).toBe(30);
  });

  it("does not count continued transcript chunks as extra turns", () => {
    const chunk = turn("agent", null, "chunk");
    chunk.stop = "continued";
    const completed = turn("agent", usage({ tokens: 100 }), "completed");

    const totals = usageTotals([chunk, completed]);

    expect(totals.turns).toBe(1);
    expect(totals.reported).toBe(1);
    expect(totals.tokens).toBe(100);
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
   * `contextTokens` is the conversation's size as the model last saw it. Adding
   * those up counts the same conversation once per turn, so the error grows
   * with the session — by turn ten a 30k-token conversation reads as 300k.
   *
   * `cacheReads` looks like it belongs with them and does not. A turn's figure
   * is what that turn's calls actually read, already summed across them by
   * Claude's terminal record, and every read is billed. Taking the latest
   * reported the last turn's reads as the whole session's. The two rules are
   * tested together because the difference between them is the whole point.
   */
  it("takes the latest context figure, but sums what each turn processed", () => {
    const totals = usageTotals([
      turn("agent", usage({ tokens: 100, contextTokens: 10_000, cacheReads: 9_000 })),
      turn("agent", usage({ tokens: 100, contextTokens: 22_000, cacheReads: 20_000 })),
      turn("agent", usage({ tokens: 100, contextTokens: 31_000, cacheReads: 29_000 })),
    ]);

    // Processed each turn, so these add.
    expect(totals.tokens).toBe(300);
    expect(totals.cacheReads).toBe(58_000);
    // The conversation's size, not a running tally.
    expect(totals.contextTokens).toBe(31_000);
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

  it("bounds inconsistent provider figures instead of displaying over 100 percent", () => {
    const totals = usageTotals([
      turn("agent", usage({ tokens: 1, contextTokens: 220_000, contextWindow: 200_000 })),
    ]);
    expect(contextUsed(totals)).toBe(1);
  });
});

/*
 * A row is written when a turn lands, so a readout built only from rows stands
 * still for the length of a run. Reported as "the context after compact doesn't
 * appear to be growing" — the compaction had worked, cutting 942k to 31k, and
 * the figure then sat there because nothing was redrawing it.
 */
describe("withLiveContext", () => {
  const history = () =>
    usageTotals([
      turn("agent", usage({ tokens: 100, contextTokens: 31_000, contextWindow: 200_000 })),
      turn("agent", usage({ tokens: 100, contextTokens: 44_000, contextWindow: 200_000 })),
    ]);

  it("prefers what the turn in flight reports", () => {
    const standing = withLiveContext(history(), {
      contextTokens: 57_000,
      contextWindow: 200_000,
    });
    expect(standing.contextTokens).toBe(57_000);
    expect(contextUsed(standing)).toBeCloseTo(0.285, 6);
  });

  /*
   * The session's consumption is not the current turn's, and this is the shape
   * of mistake that put "60 tokens" on a ten-minute run: one turn's figure
   * standing in for the whole conversation's.
   */
  it("leaves the summed history alone", () => {
    const standing = withLiveContext(history(), {
      contextTokens: 57_000,
      contextWindow: 200_000,
    });
    expect(standing.tokens).toBe(200);
    expect(standing.turns).toBe(2);
  });

  it("keeps the stored figure when no run is in flight", () => {
    expect(withLiveContext(history(), undefined).contextTokens).toBe(44_000);
  });

  /*
   * An agent that reports tokens without a window, or reports neither, must not
   * blank a readout that was right a moment ago.
   */
  it("does not blank a good figure with a run that reports none", () => {
    const standing = withLiveContext(history(), { contextTokens: null, contextWindow: null });
    expect(standing.contextTokens).toBe(44_000);
    expect(standing.contextWindow).toBe(200_000);
  });
});

describe("claudeWindowKind", () => {
  it("files each provider wording under its fixed line", () => {
    expect(claudeWindowKind("allowed (five_hour)")).toBe("session");
    expect(claudeWindowKind("weekly limit reached")).toBe("weekly");
    expect(claudeWindowKind("allowed (seven_day)")).toBe("weekly");
    expect(claudeWindowKind("rejected (opus_weekly)")).toBe("fable");
    expect(claudeWindowKind("fable usage cap")).toBe("fable");
  });

  // "opus_weekly" contains "weekly" too; the model-specific cap must win.
  it("prefers the fable cap when the wording names both", () => {
    expect(claudeWindowKind("opus_weekly")).toBe("fable");
  });

  it("declines to guess when the wording names no window", () => {
    expect(claudeWindowKind("Rate limited")).toBeNull();
  });
});

describe("cacheBreak", () => {
  it("flags an explicit zero after a substantial comparable cache read", () => {
    expect(
      cacheBreak([
        turn("agent", usage({ cacheReads: 40_000, contextTokens: 60_000 })),
        turn("agent", usage({ cacheReads: 0, contextTokens: 62_000 })),
      ]),
    ).toBe(true);
  });

  it("does not flag a compaction or a provider that omitted cache usage", () => {
    expect(
      cacheBreak([
        turn("agent", usage({ cacheReads: 40_000, contextTokens: 60_000 })),
        turn("agent", usage({ cacheReads: 0, contextTokens: 10_000 })),
      ]),
    ).toBe(false);
    expect(
      cacheBreak([
        turn("agent", usage({ cacheReads: 40_000, contextTokens: 60_000 })),
        turn("agent", usage({ cacheReads: null, contextTokens: 62_000 })),
      ]),
    ).toBe(false);
  });
});
