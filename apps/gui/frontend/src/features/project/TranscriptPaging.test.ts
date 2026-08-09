import { describe, expect, it } from "vitest";
import {
  anchoredScrollTop,
  shouldRevealEarlier,
  transcriptTail,
} from "~/features/project/TranscriptPane";

describe("transcript paging", () => {
  it("mounts only the newest page until earlier messages are requested", () => {
    const entries = Array.from({ length: 65 }, (_, index) => index);

    expect(transcriptTail(entries, 12)).toEqual({
      hidden: 53,
      visible: entries.slice(53),
    });
    expect(transcriptTail(entries, 80)).toEqual({
      hidden: 0,
      visible: entries,
    });
  });

  it("reveals an earlier page when owner scrolling reaches the top", () => {
    expect(shouldRevealEarlier(32, 24, true)).toBe(true);
    expect(shouldRevealEarlier(49, 24, true)).toBe(false);
    expect(shouldRevealEarlier(0, 0, true)).toBe(false);
    expect(shouldRevealEarlier(0, 24, false)).toBe(false);
  });

  it("keeps the same content anchored after prepending an earlier page", () => {
    expect(anchoredScrollTop(0, 1796, 3993)).toBe(2197);
    expect(anchoredScrollTop(24, 1000, 900)).toBe(24);
  });
});
