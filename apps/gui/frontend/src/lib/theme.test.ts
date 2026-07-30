import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, DEFAULT_ACCENT, isAccent, MAX_SOFTNESS, toColorValue } from "~/lib/theme";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
});

describe("applyTheme", () => {
  it("falls back to the palette's accent when the setting is empty", () => {
    applyTheme({ accent: "", softness: 0 }, root);
    expect(root.style.getPropertyValue("--color-primary")).toBe(DEFAULT_ACCENT);
  });

  /*
   * A record can come from an older build, a hand-edited store, or a future one
   * with a wider range. None of those may be able to make the app unreadable,
   * which is why the clamp is here and not at the setting.
   */
  it("clamps softness into the range the surfaces can take", () => {
    applyTheme({ accent: "", softness: 999 }, root);
    expect(root.style.getPropertyValue("--az-lift")).toBe(`${MAX_SOFTNESS}%`);

    applyTheme({ accent: "", softness: -20 }, root);
    expect(root.style.getPropertyValue("--az-lift")).toBe("0%");
  });

  it("ignores a value that is not a colour rather than writing it through", () => {
    applyTheme({ accent: "red; background: url(x)", softness: 0 }, root);
    expect(root.style.getPropertyValue("--color-primary")).toBe(DEFAULT_ACCENT);
  });

  /*
   * The whole point of the pair: lifting the desk without bringing the text
   * down swaps one glare for another, so damp must move whenever lift does.
   */
  it("damps the text ladder whenever it lifts the surfaces", () => {
    applyTheme({ accent: "", softness: MAX_SOFTNESS }, root);
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
    applyTheme({ accent: "#101820", softness: 0 }, root);
    expect(root.style.getPropertyValue("--color-primary-content")).toBe("#ffffff");

    applyTheme({ accent: "#ffee58", softness: 0 }, root);
    expect(root.style.getPropertyValue("--color-primary-content")).toBe("#111111");
  });

  it("leaves the hue and tint axes alone — the accent does not wash the surfaces", () => {
    applyTheme({ accent: "#3355ff", softness: 4 }, root);
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
