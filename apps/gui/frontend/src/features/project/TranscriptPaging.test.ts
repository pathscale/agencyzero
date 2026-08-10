import { describe, expect, it } from "vitest";
import {
  anchoredScrollTop,
  anchoredToRow,
  shouldRevealEarlier,
  shouldRevealLater,
  TRANSCRIPT_MAX_ENTRIES,
  transcriptTail,
  viewportAnchor,
} from "~/features/project/TranscriptPane";

describe("transcript paging", () => {
  it("mounts only the newest page until earlier messages are requested", () => {
    const entries = Array.from({ length: 65 }, (_, index) => index);

    expect(transcriptTail(entries, 12)).toEqual({
      hidden: 53,
      trailing: 0,
      visible: entries.slice(53),
    });
  });

  it("never mounts more rows than the ceiling, whatever it is asked for", () => {
    const entries = Array.from({ length: 400 }, (_, index) => index);

    // The old contract grew without limit, so a reader who paged up through a
    // long thread kept every row they passed mounted for the session.
    expect(transcriptTail(entries, 400).visible).toHaveLength(TRANSCRIPT_MAX_ENTRIES);
    expect(transcriptTail(entries, 400).hidden).toBe(400 - TRANSCRIPT_MAX_ENTRIES);
    expect(transcriptTail(entries, Number.MAX_SAFE_INTEGER).visible).toHaveLength(
      TRANSCRIPT_MAX_ENTRIES,
    );
  });

  it("evicts the newest rows to pay for earlier ones once the window is full", () => {
    const entries = Array.from({ length: 400 }, (_, index) => index);
    const slid = transcriptTail(entries, TRANSCRIPT_MAX_ENTRIES, 24);

    expect(slid.visible).toHaveLength(TRANSCRIPT_MAX_ENTRIES);
    expect(slid.trailing).toBe(24);
    expect(slid.hidden).toBe(400 - 24 - TRANSCRIPT_MAX_ENTRIES);
    expect(slid.visible[0]).toBe(400 - 24 - TRANSCRIPT_MAX_ENTRIES);
    expect(slid.visible.at(-1)).toBe(400 - 24 - 1);
  });

  it("clamps a window edge that would run off the start of the thread", () => {
    const entries = Array.from({ length: 30 }, (_, index) => index);

    // A short thread cannot drop 28 rows and still mount a full window, so the
    // trailing count gives way and the window stays anchored at the start.
    expect(transcriptTail(entries, TRANSCRIPT_MAX_ENTRIES, 28)).toEqual({
      hidden: 0,
      trailing: 0,
      visible: entries,
    });
    expect(transcriptTail(entries, 12, 25)).toEqual({
      hidden: 0,
      trailing: 18,
      visible: entries.slice(0, 12),
    });
  });

  it("reveals an earlier page when owner scrolling reaches the top", () => {
    expect(shouldRevealEarlier(32, 24, true)).toBe(true);
    expect(shouldRevealEarlier(49, 24, true)).toBe(false);
    expect(shouldRevealEarlier(0, 0, true)).toBe(false);
    expect(shouldRevealEarlier(0, 24, false)).toBe(false);
  });

  it("reveals a newer page when owner scrolling reaches the bottom of a slid window", () => {
    expect(shouldRevealLater(12, 24, true)).toBe(true);
    expect(shouldRevealLater(-4, 24, true)).toBe(true);
    expect(shouldRevealLater(80, 24, true)).toBe(false);
    expect(shouldRevealLater(0, 0, true)).toBe(false);
    expect(shouldRevealLater(0, 24, false)).toBe(false);
  });

  it("keeps the same content anchored after prepending an earlier page", () => {
    expect(anchoredScrollTop(0, 1796, 3993)).toBe(2197);
    expect(anchoredScrollTop(24, 1000, 900)).toBe(24);
  });

  it("anchors on the topmost row in view and never on a reveal affordance", () => {
    // The scroller's own top edge is 0, so a row whose bottom is negative has
    // been scrolled out of view above it.
    const scroller = (...rows: [number, number, boolean?][]): HTMLElement => {
      const section = document.createElement("section");
      section.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as unknown as DOMRect;
      for (const [top, height, edge] of rows) {
        const node = document.createElement("div");
        if (edge) node.setAttribute("data-transcript-edge", "");
        node.getBoundingClientRect = () => ({ top, bottom: top + height }) as unknown as DOMRect;
        section.append(node);
      }
      return section;
    };

    // Sitting at the top, which is the only place a reveal earlier ever fires:
    // the affordance is the first thing the viewport touches, and anchoring on
    // it would hold the button still and push the prose down a whole page.
    const atTop = scroller([0, 24, true], [30, 300], [340, 300]);
    expect(viewportAnchor(atTop)?.row).toBe(atTop.children[1]);
    expect(viewportAnchor(atTop)?.gap).toBe(30);

    // Mid-thread, the row straddling the top edge is the one to keep still.
    const midway = scroller([-1200, 24, true], [-900, 300], [-40, 300], [300, 300]);
    expect(viewportAnchor(midway)?.row).toBe(midway.children[2]);
    expect(viewportAnchor(midway)?.gap).toBe(-40);

    expect(viewportAnchor(scroller())).toBeUndefined();
  });

  it("keeps the anchor row still when the window slides in both directions", () => {
    // A page arrived above the reader: the row moved down, so the offset grows.
    expect(anchoredToRow(600, -40, 380)).toBe(1020);
    // A page was dropped above the reader: the row moved up by the same rule.
    expect(anchoredToRow(600, 380, -40)).toBe(180);
    expect(anchoredToRow(600, 12, 12)).toBe(600);
    // Never past the top, whatever layout reported.
    expect(anchoredToRow(20, 400, 0)).toBe(0);
  });
});
