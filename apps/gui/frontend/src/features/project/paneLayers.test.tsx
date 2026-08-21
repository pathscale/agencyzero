/**
 * The grey window, as a test.
 *
 * Raising `RETAINED_PROJECT_LIMIT` from 2 to 5 turned the live window grey
 * while the DOM stayed intact: a VISIBLE pane at 1316x821, 4,962 nodes, no
 * errors and no `REACTIVITY_HALTED`. Every check that looks at the tree passed,
 * which is why nothing caught it. `target/blitz-frame.log` was the only thing
 * that named it:
 *
 *     layers_used_max=45 layer_depth_max=8 renderer_avg_ms=1245.99
 *     paint_avg_ms=328.43 layers_by_site=overflow:38,inset-shadow:10,...
 *
 * 38 of the 45 compositor layers came from `overflow`, one set of scroller
 * layers per retained pane, and the renderer spent 1.2 seconds a frame. The
 * binding constraint on retention is the compositor, not the ~1000 DOM nodes
 * per pane that `App.tsx` discusses, and the real ceiling is far lower than
 * "half the tree" suggests.
 *
 * A unit test cannot see Vello's layer count. What it can do is pin the input
 * that drove it: the number of scrolling containers a pane contributes, and the
 * number of panes retained at once. Both are plain numbers in this codebase,
 * and their product is what went from ~20 to ~50 and broke the compositor.
 */

import { describe, expect, it } from "vitest";
import { RETAINED_PROJECT_LIMIT } from "~/App";

/**
 * Scrolling containers per retained pane.
 *
 * Nine in `ProjectPanel` (one per section, plus the column itself) and one in
 * `TranscriptPane`. Each is an `overflow` clip, which is what the renderer
 * turns into a layer, and every retained pane holds a full set whether or not
 * anyone is looking at it.
 */
const SCROLLERS_PER_PANE = 10;

/**
 * What the renderer was measured to cope with.
 *
 * `layers_used_max=45` is where the window went grey. Thirty is the largest
 * round number comfortably under it, and it is what a limit of 2 produces
 * (2 panes x 10 scrollers, plus chrome). This is a budget, not a law of the
 * renderer: raising it is allowed, but only with a `blitz-bench paint` reading
 * and a `blitz-frame.log` layer count to back it up.
 */
const LAYER_BUDGET = 30;

describe("retained panes against the compositor's layer budget", () => {
  it("keeps the retained working set inside the layer budget", () => {
    const layers = RETAINED_PROJECT_LIMIT * SCROLLERS_PER_PANE;
    expect(layers).toBeLessThanOrEqual(LAYER_BUDGET);
  });

  /*
   * The regression itself. Five panes is 50 scroller layers, past the 45 the
   * renderer was measured failing at, and this is the arithmetic that greyed
   * the window. Written as an explicit statement about the value that broke it
   * so that raising the limit to five again fails here rather than on the
   * owner's screen.
   */
  it("rejects the retention limit that greyed the window", () => {
    const greyed = 5 * SCROLLERS_PER_PANE;
    expect(greyed).toBeGreaterThan(LAYER_BUDGET);
    expect(RETAINED_PROJECT_LIMIT).toBeLessThan(5);
  });

  /*
   * Retention is still worth having: one pane behind the active one is the
   * back-and-forth the limit exists to make cheap. A limit of 1 would mean
   * every switch rebuilds, which is the blink this all started from.
   */
  it("still retains more than the active pane", () => {
    expect(RETAINED_PROJECT_LIMIT).toBeGreaterThan(1);
  });
});
