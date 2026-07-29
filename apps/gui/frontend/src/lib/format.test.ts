import { describe, expect, it } from "vitest";
import { clockTime, duration, elapsed, relativeTime, taskMeta, usageLabel } from "~/lib/format";

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
