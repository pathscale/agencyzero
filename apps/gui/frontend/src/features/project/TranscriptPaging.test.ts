import { describe, expect, it } from "vitest";
import { transcriptTail } from "~/features/project/TranscriptPane";

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
});
