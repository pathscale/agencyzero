/**
 * Changing accent 2 repaints the icons that are already on screen.
 *
 * This is the reported bug, and it has now been introduced twice by two
 * different routes, so the assertion here is deliberately the crude one: put a
 * real `<svg>` in the document, change the accent, and read the attribute back
 * off that element.
 *
 * Every test that existed while it was broken passed. `glassSwitch.test.ts`
 * asserts `--color-accent-2` resolves, and asserts `iconStrokeColor()` returns
 * the picked value. Both were true both times. Neither says anything about an
 * element that is already mounted, which is the only thing the owner can see.
 *
 * Why the token is not enough, and why this cannot be tested through CSS:
 * inline SVG is not painted from the DOM on this renderer. `blitz-dom`
 * serialises the element, substitutes the computed `currentColor` into the
 * string, and hands it to usvg, which has no stylesheet. The resolved colour is
 * baked into the parsed tree at construction time, and that tree is rebuilt only
 * when the node carries *construction* damage. Writing a custom property on the
 * root is a restyle that produces repaint damage, so the tree is never rebuilt
 * and the icon keeps the colour it was first built with. Writing the `stroke`
 * attribute is what damages the node for construction.
 *
 * The two regressions, both of which this file catches:
 *
 *   1. The colour only reached icons through `applyTheme`, so chrome that
 *      mounted later kept `currentColor` until some unrelated setting changed.
 *   2. `writeAccentPreview` stopped calling `repaintIconStrokes` while fixing a
 *      startup hang, so a pick updated the tokens and left every mounted icon
 *      on its old colour. That is this file's reason to exist.
 */

import { describe, expect, it } from "vitest";
import { applyTheme, writeAccentPreview } from "~/lib/theme";
import type { ThemeSettings } from "~/types";

function themeWith(overrides: Partial<ThemeSettings> = {}): ThemeSettings {
  return {
    surface: "",
    accent: "",
    wash: 30,
    softness: 0,
    textBrightness: 0,
    ...overrides,
  };
}

/** A fresh root, so one case cannot inherit another's custom properties. */
function root(): HTMLElement {
  const element = document.createElement("div");
  element.dataset.colorMode = "dark";
  document.body.append(element);
  return element;
}

/** An icon as {@link Icon} renders one, mounted inside `root`. */
function mountIcon(within: HTMLElement, className = ""): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("stroke", "currentColor");
  if (className) svg.setAttribute("class", className);
  within.append(svg);
  return svg;
}

describe("changing accent 2 repaints the icons already on screen", () => {
  it("restrokes a mounted icon when the pick is previewed", () => {
    const element = root();
    const icon = mountIcon(element);

    // The path a click takes: paint first, persist after.
    writeAccentPreview("#3366cc", { accentTwo: "#cc3366", root: element });

    expect(icon.getAttribute("stroke")).toBe("#cc3366");
  });

  it("restrokes a mounted icon when the settings write lands", () => {
    const element = root();
    const icon = mountIcon(element);

    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "#cc3366" }), element);

    expect(icon.getAttribute("stroke")).toBe("#cc3366");
  });

  it("moves an icon again on a second pick, not only the first", () => {
    const element = root();
    const icon = mountIcon(element);

    writeAccentPreview("#3366cc", { accentTwo: "#cc3366", root: element });
    writeAccentPreview("#3366cc", { accentTwo: "#22aa44", root: element });

    expect(icon.getAttribute("stroke")).toBe("#22aa44");
  });

  it("does not take the first accent when the second is cleared", () => {
    const element = root();
    const icon = mountIcon(element);

    writeAccentPreview("#3366cc", { accentTwo: "#cc3366", root: element });
    writeAccentPreview("#3366cc", { root: element });

    /*
     * Artwork is a separate axis from the control accent. `text-primary` marks
     * every active tab, selected row and focused control, and icons stroke with
     * `currentColor`, so letting the control accent reach a stroke repainted
     * every icon in the window: the gear in the title bar turned accent 1
     * simply because Settings was the open tab.
     */
    expect(icon.getAttribute("stroke")).not.toBe("#3366cc");
  });

  it("leaves an icon that follows its label alone", () => {
    const element = root();
    const optedOut = mountIcon(element, "az-icon-inherit");

    writeAccentPreview("#3366cc", { accentTwo: "#cc3366", root: element });

    expect(optedOut.getAttribute("stroke")).toBe("currentColor");
  });

  /*
   * The startup hang this walk caused, guarded so the repair cannot be to
   * delete the walk again.
   *
   * `writeAccentPreview` is reached from the rebase effect that keeps a harmony
   * selected across a palette change, and that effect also runs while the tree
   * is still being built. Walking the whole document there rendered zero frames
   * and the window had to be killed. Scoping the walk to the root it was handed
   * is what makes it safe: a preview writing into a settings pane cannot cost a
   * traversal of the entire application.
   */
  it("only walks the tree it was handed", () => {
    const outside = root();
    const stranger = mountIcon(outside);
    const inside = root();
    const icon = mountIcon(inside);

    writeAccentPreview("#3366cc", { accentTwo: "#cc3366", root: inside });

    expect(icon.getAttribute("stroke")).toBe("#cc3366");
    expect(stranger.getAttribute("stroke")).toBe("currentColor");
  });
});

/*
 * The startup hang, which is the other half of this bug and the reason the
 * repair keeps oscillating.
 *
 * `applyTheme` runs once during startup, before any icon has mounted, and it is
 * handed the document root. Walking the whole tree there finds nothing and can
 * only block the first frame: the window reported its refresh rate and rendered
 * zero frames, twice, and A/B rebuilding with that walk removed is what
 * identified it.
 *
 * So the first call skips the traversal and every later one performs it. Both
 * halves are asserted here, because fixing either one alone is exactly how this
 * broke twice: removing the walk stopped the hang and left the icons stale,
 * restoring it repainted the icons and hung the window.
 */
describe("the first theme application does not walk the tree", () => {
  it("repaints on the calls that follow it", () => {
    const element = root();
    const icon = mountIcon(element);

    // Whatever this module's state, one application settles it, and the next
    // one is a real pick that has to land.
    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "#111111" }), element);
    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "#cc3366" }), element);

    expect(icon.getAttribute("stroke")).toBe("#cc3366");
  });
});
