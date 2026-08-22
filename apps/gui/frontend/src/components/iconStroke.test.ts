import { describe, expect, it } from "vitest";
import { ARTWORK_FALLBACK } from "~/lib/theme";

/**
 * An icon's stroke must be a colour usvg can read, never a `var()`.
 *
 * This is the bug that made every icon in the window blank while the semantic
 * tree, the layout and the accent audit all read correct.
 *
 * Inline SVG is not painted from the DOM on this renderer. `blitz-dom`
 * serialises the `<svg>` element to a string and hands it to usvg, which has no
 * stylesheet and no custom properties. Given `stroke="var(--anything)"` usvg
 * does not fall back to anything: it drops the stroke entirely, and a `<path>`
 * with neither stroke nor fill draws nothing at all. Proven against usvg 0.48:
 *
 *     stroke="rgb(219, 172, 159)"      -> path stroke=Some(Color(...)) w=2
 *     stroke="var(--color-az-artwork)" -> path stroke=None fill=None
 *
 * `Icon.tsx` used `var(--color-az-artwork)` as its pre-theme fallback, and that
 * custom property is defined nowhere in the app. So every icon that mounted
 * before the theme resolved - which is nearly all of them, and all of them on a
 * cold start - was handed an unreadable paint and drew empty.
 *
 * Nothing else in the suite can catch this. jsdom never rasterises, so it is
 * happy with any string. `blitz-bench qa` reads boxes and roles from the
 * semantic tree, where a blank icon and a drawn one are both `16x16`, visible,
 * and reporting the accent as their colour: that is exactly how this survived a
 * live inspection pass. The only checkable invariant on this side of the
 * renderer is the *paint string*, so that is what this pins.
 */
describe("the icon stroke", () => {
  /** What usvg accepts: a hex, an `rgb()`, or the `currentColor` keyword. */
  const READABLE = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|currentColor)$/i;

  it("falls back to a literal colour, not a custom property", () => {
    expect(ARTWORK_FALLBACK).toMatch(READABLE);
    expect(ARTWORK_FALLBACK).not.toContain("var(");
  });

  it("never hands the renderer a var() as a paint", () => {
    /*
     * Read from source rather than by rendering, because rendering under jsdom
     * proves nothing here: the failure is downstream of the DOM, in a
     * rasteriser jsdom does not have. What matters is that no branch of the
     * `stroke` prop can emit a custom property.
     */
    const icon = readSource("Icon.tsx");
    const strokeProp = icon.slice(icon.indexOf("stroke={"), icon.indexOf("stroke-width"));
    const withoutComments = strokeProp
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "");
    expect(withoutComments).not.toContain("var(");
  });
});

function readSource(name: string): string {
  // Imported lazily so the module graph stays free of node builtins for the
  // browser build; this file is test-only.
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  return readFileSync(join(process.cwd(), "src/components", name), "utf8");
}
