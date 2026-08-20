import { beforeEach, describe, expect, it } from "vitest";
import {
  accentOptions,
  applyTheme,
  closestColorIndex,
  DEFAULT_ACCENT,
  DEFAULT_GLASS_BLUR,
  DEFAULT_WASH,
  defaultAccent,
  glassTuning,
  isAccent,
  MAX_GLASS_BLUR,
  MAX_SOFTNESS,
  panelAxes,
  surfaceColors,
  toColorValue,
  WASH_STOPS,
  writePanelAxes,
} from "~/lib/theme";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
});

describe("accentOptions", () => {
  it("offers seven valid harmonies shaped by every colour axis", () => {
    const dark = accentOptions("#3355ff", "dark", 10, 0);
    const light = accentOptions("#3355ff", "light", 10, 0);
    const green = accentOptions("#22aa66", "dark", 10, 0);
    const strong = accentOptions("#3355ff", "dark", 100, 0);
    const soft = accentOptions("#3355ff", "dark", 100, MAX_SOFTNESS);

    expect(dark).toHaveLength(7);
    /*
     * The designed swatch stores its own colour, not an empty string. `""`
     * collides with "nothing has been picked", which every guard in theme.ts
     * reads as unset, so selecting this swatch after a real one wrote a value
     * the next apply treated as absent and the pick appeared to do nothing.
     */
    expect(dark[0]).toEqual({
      value: defaultAccent(10, 0),
      color: defaultAccent(10, 0),
    });
    expect(new Set(dark.map((option) => option.color)).size).toBe(7);
    expect(dark.every((option) => isAccent(option.value))).toBe(true);
    expect(dark.every((option) => isAccent(option.color))).toBe(true);
    expect(light.slice(1)).not.toEqual(dark.slice(1));
    expect(green.slice(1)).not.toEqual(dark.slice(1));
    expect(strong.slice(1)).not.toEqual(dark.slice(1));
    expect(soft.slice(1)).not.toEqual(strong.slice(1));
    expect(toColorValue(soft[1].color).hsl.l - toColorValue(strong[1].color).hsl.l).toBeGreaterThan(
      15,
    );
  });
});

describe("surfaceColors", () => {
  it("uses literal, darker values in dark mode", () => {
    const dark = surfaceColors("dark");
    const light = surfaceColors("light");

    expect(dark).toHaveLength(31);
    expect(light).toHaveLength(31);
    expect(dark.every(isAccent)).toBe(true);
    expect(light.every(isAccent)).toBe(true);
    expect(dark).not.toEqual(light);
    const average = (colors: string[]) =>
      colors.reduce((sum, color) => sum + toColorValue(color).hsl.l, 0) / colors.length;
    expect(average(dark)).toBeLessThan(average(light) - 20);
    expect(closestColorIndex(dark[7], dark)).toBe(7);
  });
});

describe("applyTheme", () => {
  it("falls back to the palette's accent when the setting is empty", () => {
    applyTheme({ surface: "", accent: "", softness: 0, wash: 0, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--color-primary")).toBe(defaultAccent(10, 0));
    expect(root.style.getPropertyValue("--az-surface")).toBe(DEFAULT_ACCENT);
  });

  /*
   * A record can come from an older build, a hand-edited store, or a future one
   * with a wider range. None of those may be able to make the app unreadable,
   * which is why the clamp is here and not at the setting.
   */
  it("clamps softness into the range the surfaces can take", () => {
    applyTheme({ surface: "", accent: "", softness: 999, wash: 0, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--az-lift")).toBe(`${MAX_SOFTNESS}%`);

    applyTheme({ surface: "", accent: "", softness: -20, wash: 0, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--az-lift")).toBe("0%");
  });

  it("ignores a value that is not a colour rather than writing it through", () => {
    applyTheme(
      {
        surface: "red; background: url(x)",
        accent: "red; background: url(x)",
        softness: 0,
        wash: 0,
        textBrightness: 0,
      },
      root,
    );
    expect(root.style.getPropertyValue("--color-primary")).toBe(defaultAccent(10, 0));
  });

  /*
   * The whole point of the pair: lifting the desk without bringing the text
   * down swaps one glare for another, so damp must move whenever lift does.
   */
  it("damps the text ladder whenever it lifts the surfaces", () => {
    applyTheme(
      { surface: "", accent: "", softness: MAX_SOFTNESS, wash: 0, textBrightness: 0 },
      root,
    );
    const lift = Number.parseFloat(root.style.getPropertyValue("--az-lift"));
    const damp = Number.parseFloat(root.style.getPropertyValue("--az-damp"));
    expect(lift).toBe(MAX_SOFTNESS);
    expect(damp).toBeGreaterThan(0);
    expect(damp).toBeLessThan(lift);
  });

  /*
   * The accent is a background for the send button's label. A dark pick with
   * the palette's dark ink left in place is an invisible button.
   */
  it("picks ink that stays legible on the chosen accent", () => {
    applyTheme({ surface: "", accent: "#101820", softness: 0, wash: 0, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--color-primary-content")).toBe("#ffffff");

    applyTheme({ surface: "", accent: "#ffee58", softness: 0, wash: 0, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--color-primary-content")).toBe("#111111");
  });

  /*
   * The axis that makes a pick read as a theme. Accent-only shipped first and
   * was wrong: the wheel recoloured buttons while the workspace stayed grey.
   */
  it("keeps the surface base independent from the interactive accent", () => {
    applyTheme(
      {
        surface: "#3355ff",
        accent: "#ffee58",
        softness: 4,
        wash: 10,
        textBrightness: 0,
      },
      root,
    );
    expect(root.style.getPropertyValue("--az-surface")).toBe("#3355ff");
    expect(root.style.getPropertyValue("--color-primary")).toBe("#ffee58");
    expect(root.style.getPropertyValue("--az-wash")).toBe("10%");
  });

  /* The designed palette is grey, not grey washed with its own yellow, so an
   * empty accent means no wash whatever the stored strength says. */
  it("applies the wash even before a colour has been picked", () => {
    applyTheme({ surface: "", accent: "#3355ff", softness: 0, wash: 20, textBrightness: 0 }, root);
    /*
     * The wash used to be forced to 0 until a surface was chosen, which held
     * while every surface was a mix into a grey anchor. Base is now the pick
     * plus both axes, so zeroing it made the strength control inert: clicking a
     * stop repainted nothing. `surface` falls back to the designed accent, so
     * there is always something for the wash to apply to.
     */
    expect(root.style.getPropertyValue("--az-wash")).toBe("20%");
  });

  it("clamps the wash to what the surface ladder survives", () => {
    applyTheme({ surface: "#3355ff", accent: "", softness: 0, wash: 999, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--az-wash")).toBe(`${WASH_STOPS[WASH_STOPS.length - 1]}%`);
  });

  it("fills all five strength choices with the useful coloured range", () => {
    expect(WASH_STOPS).toEqual([10, 20, 30, 40, 50]);
    expect(DEFAULT_WASH).toBe(30);
    applyTheme({ surface: "#3355ff", accent: "", softness: 0, wash: 100, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--az-surface")).toBe("#3355ff");
    expect(root.style.getPropertyValue("--az-wash")).toBe("50%");
  });

  it("moves the designed yellow with softness instead of keeping a harsh literal", () => {
    applyTheme({ surface: "", accent: "", softness: 0, wash: 30, textBrightness: 0 }, root);
    const firm = root.style.getPropertyValue("--color-primary");
    applyTheme(
      { surface: "", accent: "", softness: MAX_SOFTNESS, wash: 30, textBrightness: 0 },
      root,
    );
    const soft = root.style.getPropertyValue("--color-primary");
    expect(soft).not.toBe(firm);
    expect(toColorValue(soft).hsl.s).toBeLessThan(toColorValue(firm).hsl.s - 20);
  });

  /*
   * The counterweight to softness. Prose reading faded is a separate complaint
   * from surfaces glaring, and before this axis the two shared one number.
   */
  it("brightens the text ladder back up, past the designed rung if asked", () => {
    applyTheme({ surface: "", accent: "", softness: 0, wash: 0, textBrightness: 6 }, root);
    // Negative damp is a rung *above* the design's 86% title, which is the point.
    expect(Number.parseFloat(root.style.getPropertyValue("--az-damp"))).toBe(-6);
  });

  it("still lets softness dim the text when brightness is left alone", () => {
    applyTheme(
      { surface: "", accent: "", softness: MAX_SOFTNESS, wash: 0, textBrightness: 0 },
      root,
    );
    expect(Number.parseFloat(root.style.getPropertyValue("--az-damp"))).toBeGreaterThan(0);
  });

  /* The design's rule is no pure white; +6 puts the title at 92% and the clamp
   * is what keeps a hand-edited record from going past it. */
  it("clamps brightness at both ends", () => {
    applyTheme({ surface: "", accent: "", softness: 0, wash: 0, textBrightness: 99 }, root);
    expect(Number.parseFloat(root.style.getPropertyValue("--az-damp"))).toBe(-6);

    applyTheme({ surface: "", accent: "", softness: 0, wash: 0, textBrightness: -99 }, root);
    expect(Number.parseFloat(root.style.getPropertyValue("--az-damp"))).toBe(4);
  });

  /* Hue and tint stay untouched: the wash mixes the accent in, it does not
   * rotate the neutral ladder underneath. */
  it("leaves the neutral hue and chroma axes alone", () => {
    applyTheme(
      { surface: "#3355ff", accent: "#ffee58", softness: 4, wash: 10, textBrightness: 0 },
      root,
    );
    expect(root.style.getPropertyValue("--az-hue")).toBe("");
    expect(root.style.getPropertyValue("--az-tint")).toBe("");
  });
});

describe("isAccent", () => {
  it("takes both hex forms and rejects everything else", () => {
    expect(isAccent("#abc")).toBe(true);
    expect(isAccent("#AABBCC")).toBe(true);
    expect(isAccent(" #aabbcc ")).toBe(true);
    expect(isAccent("aabbcc")).toBe(false);
    expect(isAccent("rgb(1,2,3)")).toBe(false);
    expect(isAccent("")).toBe(false);
  });
});

describe("toColorValue", () => {
  /* The wheel finds the nearest petal from hsl, so a wrong conversion shows up
   * as the selection ring landing on the wrong swatch. */
  it("converts hex to the shape the wheel reads", () => {
    expect(toColorValue("#ff0000").hsl).toEqual({ h: 0, s: 100, l: 50, a: 1 });
    expect(toColorValue("#00ff00").hsl.h).toBe(120);
    expect(toColorValue("#0000ff").hsl.h).toBe(240);
    expect(toColorValue("#808080").hsl.s).toBe(0);
    expect(toColorValue("#fff").rgb).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
});

describe("glass blur bound", () => {
  const base = { surface: "", accent: "", softness: 0, wash: 30, textBrightness: 0 };

  /*
   * Blur radius decides whether the renderer can batch glass panels at all. A
   * gaussian reaches about 3 sigma, two panels share a render pass only when
   * neither blur reads the other's pixels, and this app's panels sit 12px
   * apart. The library's 50px reaches 150px, which made every panel its own
   * render pass and the renderer 119-181ms of a frame.
   */
  it("defaults blur well below the library's 50px", () => {
    applyTheme({ ...base });
    expect(DEFAULT_GLASS_BLUR).toBe(12);
    expect(DEFAULT_GLASS_BLUR).toBeLessThan(50);
  });

  it("clamps a stored blur to the ceiling", () => {
    const root = document.documentElement;
    applyTheme({ ...base, glassBlur: 50 });
    const clamped = glassTuning({ ...base, glassBlur: 50 }, root).blur;
    expect(clamped).toBe(MAX_GLASS_BLUR);
    expect(clamped).toBeLessThan(50);
  });

  it("leaves a blur inside the range alone", () => {
    expect(glassTuning({ ...base, glassBlur: 8 }, document.documentElement).blur).toBe(8);
  });
});

describe("panel axes", () => {
  const base = { surface: "", accent: "", softness: 0, wash: 30, textBrightness: 0 };

  /*
   * The panel used to carry three sliders of its own, alongside the library's
   * three, and two of the six were called "depth". They are derived from the
   * library's numbers now, so there is one place to set glass and no way to
   * put the two halves into disagreement.
   */
  it("derives the panel from the glass tuning, over the library's ranges", () => {
    // Both ends of each range, so the mapping is pinned rather than sampled.
    expect(panelAxes({ blur: 0, refraction: 0, depth: 0 })).toEqual({
      lift: 0,
      border: 16,
      shadow: 0,
    });
    expect(panelAxes({ blur: 50, refraction: 0.4, depth: 30 })).toEqual({
      lift: 60,
      border: 60,
      shadow: 0.6,
    });
  });

  /* The hairline never disappears: at rest it is the stylesheet's own 16%. */
  it("keeps a hairline at every setting", () => {
    for (const refraction of [0, 0.1, 0.2, 0.3, 0.4]) {
      expect(panelAxes({ blur: 0, refraction, depth: 0 }).border).toBeGreaterThanOrEqual(16);
    }
  });

  it("writes the derived values onto the document", () => {
    applyTheme({ ...base, glassRefraction: 0.4, glassDepth: 30 });
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--az-glass-lift")).toBe("60%");
    expect(root.getPropertyValue("--az-glass-border")).toBe("60%");
    expect(root.getPropertyValue("--az-glass-shadow")).toBe("0.6");
  });

  /*
   * The drag preview. It exists because a slider that persists on every tick
   * awaits a store write before the CSS moves, and one session's log carried 75
   * of those plus 76 native window calls at 7 and 6ms each, on the window
   * thread. This path has to reach the document with no round trip at all, and
   * has to agree with `applyTheme` about every value.
   */
  it("agrees with applyTheme for the same tuning", () => {
    const root = document.documentElement.style;
    applyTheme({ ...base, glassRefraction: 0.2, glassDepth: 15 });
    const viaTheme = [
      root.getPropertyValue("--az-glass-lift"),
      root.getPropertyValue("--az-glass-border"),
      root.getPropertyValue("--az-glass-shadow"),
    ];

    for (const property of ["--az-glass-lift", "--az-glass-border", "--az-glass-shadow"]) {
      root.removeProperty(property);
    }
    writePanelAxes({ blur: 0, refraction: 0.2, depth: 15 });

    expect([
      root.getPropertyValue("--az-glass-lift"),
      root.getPropertyValue("--az-glass-border"),
      root.getPropertyValue("--az-glass-shadow"),
    ]).toEqual(viaTheme);
  });
});

describe("window chrome bridge", () => {
  const base = { surface: "", accent: "", softness: 0, wash: 30, textBrightness: 0 };

  /*
   * Off while the window is opaque, which it is.
   *
   * Attaching a tinted glass view to an opaque window put a colour over the
   * whole app and flattened every surface under it. The frame may only be
   * glass once the window itself is transparent.
   */
  /*
   * The window is transparent now and the backdrop attaches as a sibling below
   * the content, so the chrome is live. It was off while the window was opaque,
   * because a tinted glass view over an opaque window washed the whole app out.
   */
  it("attaches native glass now that the window is transparent", () => {
    expect(applyTheme({ ...base, accent: "#3366cc" }).enabled).toBe(true);
  });

  /*
   * The tint follows the opacity axis, not the border axis.
   *
   * It used to take its alpha from `glassBorder`, the panel hairline: a number
   * with nothing to do with how solid the window should look, and one that
   * never reaches zero. So the backdrop stayed a tinted sheet at opacity 0,
   * which is the exact setting where the app should be at its clearest.
   */
  it("sends no tint at all when the opacity axis is zero", () => {
    expect(applyTheme({ ...base, accent: "#3366cc", glassOpacity: 0 }).tint).toBeUndefined();
  });

  it("scales the tint with the opacity axis", () => {
    const dim = applyTheme({ ...base, accent: "#3366cc", glassOpacity: 20 }).tint;
    const solid = applyTheme({ ...base, accent: "#3366cc", glassOpacity: 90 }).tint;
    expect(dim?.[3]).toBeLessThan(solid?.[3] ?? 0);
  });

  it("ignores the border axis for the backdrop tint", () => {
    const low = applyTheme({ ...base, accent: "#3366cc", glassBorder: 0 }).tint;
    const high = applyTheme({ ...base, accent: "#3366cc", glassBorder: 100 }).tint;
    expect(low?.[3]).toBe(high?.[3]);
  });
});
