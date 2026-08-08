import { describe, expect, it } from "vitest";
import {
  clockTime,
  countdown,
  duration,
  elapsed,
  formatBytes,
  isCybersecurityRefusal,
  isRetryableStop,
  isSuccessfulStop,
  isTransientStop,
  relativeTime,
  taskMeta,
  usageLabel,
} from "~/lib/format";

const NOW = Date.parse("2026-07-29T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("relativeTime", () => {
  it("coarsens as it goes back", () => {
    expect(relativeTime(ago(20_000), NOW)).toBe("just now");
    expect(relativeTime(ago(4 * 60_000), NOW)).toBe("4 min ago");
    expect(relativeTime(ago(60 * 60_000), NOW)).toBe("1 hour ago");
    expect(relativeTime(ago(5 * 60 * 60_000), NOW)).toBe("5 hours ago");
    expect(relativeTime(ago(26 * 60 * 60_000), NOW)).toBe("yesterday");
    expect(relativeTime(ago(3 * 24 * 60 * 60_000), NOW)).toBe("3 days ago");
  });

  it("does not render an unparseable timestamp as a date near 1970", () => {
    expect(relativeTime("not a date", NOW)).toBe("—");
  });
});

describe("elapsed", () => {
  it("counts up as m:ss with a padded second", () => {
    expect(elapsed(ago(0), NOW)).toBe("0:00");
    expect(elapsed(ago(41_000), NOW)).toBe("0:41");
    expect(elapsed(ago(72_000), NOW)).toBe("1:12");
    expect(elapsed(ago(9 * 60_000 + 5_000), NOW)).toBe("9:05");
  });

  it("clamps rather than counting backwards when a start time is in the future", () => {
    expect(elapsed(new Date(NOW + 5_000).toISOString(), NOW)).toBe("0:00");
  });
});

describe("countdown", () => {
  const inMs = (ms: number) => new Date(NOW + ms).toISOString();

  it("changes unit with magnitude", () => {
    expect(countdown(inMs(14 * 60_000), NOW)).toBe("14m");
    expect(countdown(inMs(2 * 60 * 60_000 + 14 * 60_000), NOW)).toBe("2h 14m");
    expect(countdown(inMs(30 * 60 * 60_000), NOW)).toBe("1d 6h");
  });

  it("rounds the last partial minute up rather than saying now early", () => {
    expect(countdown(inMs(20_000), NOW)).toBe("1m");
  });

  it("says now for a deadline already passed, and nothing for garbage", () => {
    expect(countdown(inMs(-5_000), NOW)).toBe("now");
    expect(countdown(null, NOW)).toBe("");
    expect(countdown("not a date", NOW)).toBe("");
  });
});

describe("isTransientStop", () => {
  it("recognises the provider's own outage messages", () => {
    // Verbatim shape from a real outage: the vendor CLI quotes the status.
    expect(
      isTransientStop(
        "claude-code reported a failed turn (status 529): API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
      ),
    ).toBe(true);
    expect(isTransientStop("API Error: 500 Internal server error")).toBe(true);
    expect(isTransientStop("API Error: 503 Service unavailable")).toBe(true);
  });

  it("does not soften real failures", () => {
    expect(isTransientStop("error")).toBe(false);
    expect(isTransientStop("could not start the agent: spawn failed")).toBe(false);
    // A 4xx is the request being wrong, which resending will not fix.
    expect(isTransientStop("API Error: 401 Unauthorized")).toBe(false);
    // A 5xx mentioned as ordinary text is not a status the turn reported.
    expect(isTransientStop("the parser failed at line 512")).toBe(false);
  });
});

describe("isRetryableStop", () => {
  it("does not offer Retry after completion or a deliberate cancellation", () => {
    expect(isRetryableStop("completed")).toBe(false);
    expect(isRetryableStop("canceled")).toBe(false);
    expect(isRetryableStop("imported")).toBe(false);
    expect(isRetryableStop("reconnected")).toBe(false);
    expect(isSuccessfulStop("reconnected")).toBe(true);
  });

  it("keeps Retry for failures and interrupted runs", () => {
    expect(isRetryableStop("error")).toBe(true);
    expect(isRetryableStop("interrupted")).toBe(true);
    expect(isRetryableStop("API Error: 503 Service unavailable")).toBe(true);
  });

  it("keeps cybersecurity refusals visible without replaying the same prompt", () => {
    const refusal =
      "codex reported a failed turn: This content was flagged for possible cybersecurity risk.";
    expect(isCybersecurityRefusal(refusal)).toBe(true);
    expect(isRetryableStop(refusal)).toBe(false);
  });
});

describe("isSuccessfulStop", () => {
  it("renders imported replies as successful completed history", () => {
    expect(isSuccessfulStop("imported")).toBe(true);
    expect(isSuccessfulStop("error")).toBe(false);
  });
});

describe("duration", () => {
  it("changes unit with magnitude", () => {
    expect(duration(600)).toBe("600ms");
    expect(duration(41_200)).toBe("41.2s");
    expect(duration(134_000)).toBe("2m 14s");
  });
});

describe("taskMeta", () => {
  it("shows the exit code for a failure, because that is the useful number", () => {
    expect(taskMeta({ durationMs: 400, exitCode: 101 })).toBe("exit 101");
  });

  it("shows the duration when the tool exited cleanly", () => {
    expect(taskMeta({ durationMs: 41_200, exitCode: 0 })).toBe("41.2s");
  });

  it("says nothing rather than guessing when neither was reported", () => {
    expect(taskMeta({ durationMs: null, exitCode: null })).toBe("—");
  });

  /*
   * An agent that reports no duration sends no field at all, not a null. The
   * arithmetic on `undefined` produces "NaNm NaNs" rather than throwing, which
   * is worse: it renders, so nobody notices it is meaningless.
   */
  it("renders an em dash for a missing duration rather than NaN", () => {
    const missing = {} as unknown as Parameters<typeof taskMeta>[0];
    expect(taskMeta(missing)).toBe("—");
  });
});

describe("usageLabel", () => {
  /*
   * Absent usage means "the agent did not say", which is not the same as zero.
   * Rendering it as "0 tok · $0.000" would be an invented number.
   */
  it("renders absent usage as an em dash, never as zero", () => {
    expect(usageLabel(null)).toBe("—");
  });

  it("abbreviates thousands and pairs them with the cost", () => {
    expect(usageLabel({ tokens: 18_700, costUsd: 0.017, premiumRequests: null })).toBe(
      "18.7k tok · $0.017",
    );
  });

  it("keeps small counts exact", () => {
    expect(usageLabel({ tokens: 420, costUsd: null, premiumRequests: null })).toBe("420 tok");
  });

  it("falls back to premium requests, which is how Copilot bills", () => {
    expect(usageLabel({ tokens: 2_000, costUsd: null, premiumRequests: 3 })).toBe(
      "2.0k tok · 3 premium",
    );
  });

  /*
   * The shape a previous build persisted: `agent-abstraction`'s own `Usage`,
   * written to the row verbatim. Its fields are snake_case and it has no
   * `tokens` at all, so every field the label reads comes back `undefined` —
   * and `undefined !== null`, which is what let `.toFixed()` be called on it.
   *
   * This threw during render, so it did not blank a chip; it killed the
   * transcript and left the window on "Loading workspace…" with no error
   * anywhere. Rows in that shape are still on disk, so this has to hold.
   */
  it("survives a usage blob written in the crate's shape rather than the UI's", () => {
    const fromAnOlderBuild = {
      input_tokens: 1_200,
      output_tokens: 300,
      cache_read_tokens: 4_096,
      cost_usd: 0.017,
    } as unknown as Parameters<typeof usageLabel>[0];

    expect(() => usageLabel(fromAnOlderBuild)).not.toThrow();
    expect(usageLabel(fromAnOlderBuild)).toBe("0 tok");
  });

  it("does not render a NaN or an infinity as a number", () => {
    expect(usageLabel({ tokens: Number.NaN, costUsd: null, premiumRequests: null })).toBe("0 tok");
    expect(
      usageLabel({ tokens: 500, costUsd: Number.POSITIVE_INFINITY, premiumRequests: null }),
    ).toBe("500 tok");
  });
});

describe("clockTime", () => {
  it("zero-pads both halves", () => {
    const at = new Date(2026, 6, 29, 9, 5).toISOString();
    expect(clockTime(at)).toBe("09:05");
  });

  it("renders nothing when the provider did not say when the limit resets", () => {
    expect(clockTime(null)).toBe("");
    expect(clockTime("nonsense")).toBe("");
  });
});

describe("formatBytes", () => {
  it("reads the way a disk figure is quoted", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(2_411_724)).toBe("2.4 MB");
    expect(formatBytes(430_080)).toBe("430 KB");
    expect(formatBytes(3_200_000_000)).toBe("3.20 GB");
  });

  /* A store that cannot be measured reports nothing rather than "NaN B". */
  it("refuses a figure it cannot render", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});
