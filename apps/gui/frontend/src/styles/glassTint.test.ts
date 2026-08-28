/*
 * @vitest-environment node
 *
 * Reads the stylesheet with `node:fs`, like `windowTransparency.test.ts`, so
 * the environment is declared per file.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the library's glass is tinted with, and what it must never be tinted
 * with.
 *
 * `applyGlassTokens` derives twenty-five numbers and leaves the six colours to
 * the theme, because only the theme knows what its glass is made of. Getting
 * those six wrong is invisible until the material flip puts them on every
 * component at once, and then it is the only thing anyone can see. Both
 * failures below shipped, one after the other, and each was reported as the
 * whole app looking broken rather than as a colour being wrong.
 *
 * Neither is catchable by rendering one component: the tokens are global, so
 * the damage is proportional to how many components read them.
 */

const SRC = join(process.cwd(), "src");
const THEME_CSS = readFileSync(join(SRC, "styles/theme.css"), "utf8");

/** The value of one custom property, as declared in the stylesheet. */
function declared(property: string): string[] {
  return [...THEME_CSS.matchAll(new RegExp(`^\\s*${property}:\\s*([^;]+);`, "gm"))].map((match) =>
    match[1].trim(),
  );
}

describe("the glass tint follows the surface, not the accent", () => {
  /*
   * The fill decides what a pane is made of, and the surface ladder is what a
   * pane is made of. `--az-surface` is the wheel's own colour and every rung
   * derives from it, so a fill on that ladder tracks the workspace colour by
   * construction.
   *
   * `--color-primary` is the *accent*: a different axis the picker moves
   * independently. Tinting the fill with it means every glass surface in the
   * app changes hue when the accent moves, which is a tint nobody asked for.
   */
  it("fills from the surface ladder", () => {
    const fills = declared("--glass-background-color");
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) {
      expect(fill).toContain("--color-az-");
      expect(fill).not.toContain("--color-primary");
      expect(fill).not.toContain("--color-accent");
    }
  });

  /*
   * The highlight is the lit top edge of the same pane, so it is the same
   * material and takes the same rung.
   */
  it("highlights from the surface ladder", () => {
    const highlights = declared("--glass-highlight-color");
    expect(highlights.length).toBeGreaterThan(0);
    for (const highlight of highlights) {
      expect(highlight).not.toContain("--color-primary");
      expect(highlight).not.toContain("--color-accent");
    }
  });

  /*
   * The border is the exception, and only for this app's own panels.
   *
   * `.az-glass` carries the accent on its outline deliberately: one ring per
   * panel, at around 12%, is the edge reading as lit. Handing that same colour
   * to `--glass-border-color` is a different thing entirely, because that
   * token is read by *every* library component, so with the flip on it put an
   * accent edge on every card, row, control and popover at once. Shipped once:
   * the app came back with a red cast over the whole transcript and icons,
   * borders and pills all glowing the accent.
   *
   * So the token stays off the accent, and the panel edge keeps its accent
   * through `.az-glass`'s own `outline-color`, where it is scoped to panels.
   */
  it("never hands the accent to every component through the border token", () => {
    for (const border of declared("--glass-border-color")) {
      expect(border).not.toContain("--color-primary");
      expect(border).not.toContain("--color-accent");
    }
  });

  /*
   * White is the library's fallback and the reason these are declared at all.
   * Frost diffuses white through a translucent layer and needs something light
   * underneath; on a dark desk a white film reads as grey haze over the colour
   * rather than as material, and at this app's 55% film it turned whole panes
   * of text illegible.
   */
  it("never falls back to a white film", () => {
    for (const property of [
      "--glass-background-color",
      "--glass-highlight-color",
      "--glass-border-color",
    ]) {
      for (const value of declared(property)) {
        expect(value).not.toBe("white");
        expect(value).not.toMatch(/^#fff(f{3})?$/i);
      }
    }
  });

  /*
   * These have to outrank the library's own themes, which declare the same
   * three under `[data-theme="dark"]`. A bare `:root` loses that comparison,
   * so the fix silently does nothing and the white film survives. Declaring
   * them on the app's own theme selector is what makes them win.
   */
  /*
   * The composer's animated ring is a gradient painted on the border box, and
   * the fill inside it is a child. Two declarations keep it visible and both
   * have been lost before: without `background-clip: border-box` the gradient
   * lands behind the fill instead of on the edge, and a translucent child
   * necessarily reveals it across the body. Native QA checks the resolved
   * alpha; this source guard keeps the intended solid token declaration.
   */
  it("keeps the composer ring on its border box, with a solid fill", () => {
    const ring = THEME_CSS.slice(
      THEME_CSS.indexOf(".az-ring-composer {"),
      THEME_CSS.indexOf(".az-ring-drift"),
    );
    expect(ring).toContain("border-box");
    expect(ring).toContain("background-color: var(--color-az-inset)");
    expect(ring).toContain("isolation: isolate");
  });

  it("declares the tint where it outranks the library's own theme", () => {
    const block = THEME_CSS.slice(
      THEME_CSS.indexOf('[data-theme="agencyzero"]'),
      THEME_CSS.indexOf('[data-theme="agencyzero"][data-color-mode="light"]'),
    );
    expect(block).toContain("--glass-background-color");
  });
});
