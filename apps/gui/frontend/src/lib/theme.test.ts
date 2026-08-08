import { beforeEach, describe, expect, it } from "vitest";
import {
  accentOptions,
  applyTheme,
  DEFAULT_ACCENT,
  isAccent,
  MAX_SOFTNESS,
  toColorValue,
  WASH_STOPS,
} from "~/lib/theme";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
});

describe("accentOptions", () => {
  it("offers seven valid harmonies shaped by surface and mode", () => {
    const dark = accentOptions("#3355ff", "dark");
    const light = accentOptions("#3355ff", "light");
    const green = accentOptions("#22aa66", "dark");

    expect(dark).toHaveLength(7);
    expect(dark[0]).toEqual({ value: "", color: DEFAULT_ACCENT });
    expect(new Set(dark.map((option) => option.color)).size).toBe(7);
    expect(dark.every((option) => isAccent(option.color))).toBe(true);
    expect(light.slice(1)).not.toEqual(dark.slice(1));
    expect(green.slice(1)).not.toEqual(dark.slice(1));
  });
});

describe("applyTheme", () => {
  it("falls back to the palette's accent when the setting is empty", () => {
    applyTheme({ surface: "", accent: "", softness: 0, wash: 0, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--color-primary")).toBe(DEFAULT_ACCENT);
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
    expect(root.style.getPropertyValue("--color-primary")).toBe(DEFAULT_ACCENT);
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
  it("ignores the wash while no colour has been picked", () => {
    applyTheme({ surface: "", accent: "#3355ff", softness: 0, wash: 20, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--az-wash")).toBe("0%");
  });

  it("clamps the wash to what the surface ladder survives", () => {
    applyTheme({ surface: "#3355ff", accent: "", softness: 0, wash: 90, textBrightness: 0 }, root);
    expect(root.style.getPropertyValue("--az-wash")).toBe(`${WASH_STOPS[WASH_STOPS.length - 1]}%`);
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
