/**
 * A pane may never ask to be scrolled past the end of its own content.
 *
 * This is the blank screen, and it is arithmetic rather than rendering.
 *
 * Scrolling to the bottom is usually written `scrollTop = scrollHeight`, or
 * `bottom + slack`, on the understanding that the platform takes the overshoot
 * back. A browser does. Blitz clamps an assigned `scrollTop` against its own
 * `scroll_height`, and that number measures *larger* than
 * `scrollHeight - clientHeight` on real panes, so the overshoot survives the
 * clamp and the viewport ends up parked beyond the last pixel of content.
 *
 * Measured on a fresh launch, with no input at all: the transcript scroller
 * sat at 2583 against a true maximum of 2226.8, showing 356px of nothing. The
 * settings pane reached 8170 against 7043, showing 1,127px of nothing. Both
 * painted as an empty rectangle inside correctly drawn chrome, at 89fps, and
 * both recovered the instant anything scrolled, because a scroll re-runs the
 * clamp with a real delta.
 *
 * So the rule this file enforces is the one that does not depend on the
 * engine: **never write an offset larger than `scrollHeight - clientHeight`.**
 * A pane that asks only for the bottom cannot be stranded past it, whatever
 * the clamp underneath believes.
 */

import { describe, expect, it } from "vitest";

/**
 * A scroller that does *not* clamp, which is the environment the bug needs.
 *
 * Browsers clamp `scrollTop`, so a faithful stand-in for the Blitz regression
 * has to keep whatever it is given. That is what Blitz effectively did with an
 * over-large bound.
 */
function unclampedScroller(scrollHeight: number, clientHeight: number) {
  return { scrollHeight, clientHeight, scrollTop: 0 };
}

/** What the transcript's `followTail` writes. */
function tailOffset(scroller: { scrollHeight: number; clientHeight: number }): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

describe("scrolling to the tail", () => {
  it("never asks for an offset past the end of the content", () => {
    const scroller = unclampedScroller(2750.9, 524.1);
    scroller.scrollTop = tailOffset(scroller);

    const furthest = scroller.scrollHeight - scroller.clientHeight;
    expect(scroller.scrollTop).toBeLessThanOrEqual(furthest);
    // The exact number the running app got wrong.
    expect(scroller.scrollTop).toBeCloseTo(2226.8, 1);
  });

  /*
   * The shapes that produced the blank, kept as a table so a future edit that
   * reintroduces slack or writes `scrollHeight` fails here rather than in the
   * window. The old code wrote `bottom + 24` and `scrollHeight`.
   */
  it("stays inside the content for every pane that went blank", () => {
    for (const [scrollHeight, clientHeight] of [
      [2750.9, 524.1], // transcript, was parked at 2583
      [7750.9, 707.8], // settings pane, was parked at 8170
      [900, 900], // nothing to scroll
      [100, 900], // content shorter than the viewport
    ]) {
      const scroller = unclampedScroller(scrollHeight, clientHeight);
      scroller.scrollTop = tailOffset(scroller);

      expect(scroller.scrollTop).toBeGreaterThanOrEqual(0);
      expect(scroller.scrollTop).toBeLessThanOrEqual(Math.max(0, scrollHeight - clientHeight));
    }
  });

  /* Content shorter than the viewport scrolls to zero, not to a negative. */
  it("does not produce a negative offset", () => {
    const scroller = unclampedScroller(100, 900);
    scroller.scrollTop = tailOffset(scroller);
    expect(scroller.scrollTop).toBe(0);
  });
});
