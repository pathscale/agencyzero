import { describe, expect, it } from "vitest";
import { applyTheme } from "~/lib/theme";
import type { ThemeSettings } from "~/types";

/**
 * The opacity axis has to reach `--az-glass-alpha`.
 *
 * That variable is what `body` and `.az-desk` read, and those are the two
 * surfaces covering the whole window. Writing only
 * `--glass-background-opacity` moves the cards and panels and leaves the desk,
 * the body and the titlebar exactly as solid as they were, which is a slider
 * that appears to work and changes nothing anyone was looking at.
 *
 * The stylesheet half of this lives in `windowTransparency.test.ts`, which
 * needs the node environment to read files.
 */

/** Every axis at its default, so only opacity is under test. */
function themeWith(glassOpacity: number): ThemeSettings {
  return {
    surface: "",
    accent: "",
    wash: 30,
    softness: 0,
    textBrightness: 0,
    glassOpacity,
  };
}

const alphaOf = (root: HTMLElement): string =>
  root.style.getPropertyValue("--az-glass-alpha").trim();

describe("the opacity axis reaches the window surfaces", () => {
  it("writes an alpha below 100% when turned down", () => {
    const root = document.createElement("div");
    applyTheme(themeWith(0), root);

    const alpha = alphaOf(root);
    expect(alpha, "the opacity axis never reached --az-glass-alpha").not.toBe("");
    expect(
      Number.parseFloat(alpha),
      `--az-glass-alpha was ${alpha}, which is fully opaque`,
    ).toBeLessThan(100);
  });

  /** A slider whose variable never moves is decorative. */
  it("moves the alpha as the axis moves", () => {
    const root = document.createElement("div");

    applyTheme(themeWith(0), root);
    const low = Number.parseFloat(alphaOf(root));

    applyTheme(themeWith(95), root);
    const high = Number.parseFloat(alphaOf(root));

    expect(low).toBeLessThan(high);
  });

  /*
   * The number on the slider is the number on the surface.
   *
   * The first attempt mapped the axis onto 45..100 so the desk would stay
   * readable, which made the control unable to do the one thing it is named
   * for: the default 55 wrote 75%, and the floor of 45% meant the window never
   * cleared however far the slider went. The owner reported it as "I still
   * cannot see through the app", and they were right.
   */
  it("passes the axis through rather than curving it", () => {
    const root = document.createElement("div");

    for (const value of [0, 25, 55, 95]) {
      applyTheme(themeWith(value), root);
      expect(Number.parseFloat(alphaOf(root)), `opacity ${value} should write ${value}%`).toBe(
        value,
      );
    }
  });
});
