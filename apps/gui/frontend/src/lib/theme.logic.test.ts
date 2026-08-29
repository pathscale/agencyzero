import { describe, expect, it } from "vitest";
import {
  accentOptions,
  closestColorIndex,
  DEFAULT_GLASS_BLUR,
  defaultAccent,
  glassTuning,
  isAccent,
  MAX_GLASS_BLUR,
  MAX_SOFTNESS,
  panelAxes,
  surfaceColors,
  toColorValue,
  windowChromeForTheme,
} from "~/lib/theme";

describe("theme colour calculations", () => {
  it("offers distinct valid harmonies shaped by mode and softness", () => {
    const dark = accentOptions("#3355ff", "dark", 10, 0);
    const light = accentOptions("#3355ff", "light", 10, 0);
    const soft = accentOptions("#3355ff", "dark", 100, MAX_SOFTNESS);

    expect(dark).toHaveLength(7);
    expect(dark[0]).toEqual({ value: defaultAccent(10, 0), color: defaultAccent(10, 0) });
    expect(new Set(dark.map((option) => option.color)).size).toBe(7);
    expect(dark.every((option) => isAccent(option.value) && isAccent(option.color))).toBe(true);
    expect(light.slice(1)).not.toEqual(dark.slice(1));
    expect(soft.slice(1)).not.toEqual(dark.slice(1));
  });

  it("keeps the dark flower literal, darker, and indexable", () => {
    const dark = surfaceColors("dark");
    const light = surfaceColors("light");
    const average = (colors: string[]) =>
      colors.reduce((sum, color) => sum + toColorValue(color).hsl.l, 0) / colors.length;

    expect(dark).toHaveLength(31);
    expect(dark.every(isAccent)).toBe(true);
    expect(average(dark)).toBeLessThan(average(light) - 20);
    expect(closestColorIndex(dark[7], dark)).toBe(7);
  });

  it("accepts only supported hex accents and converts them for the wheel", () => {
    expect(isAccent("#abc")).toBe(true);
    expect(isAccent(" #AABBCC ")).toBe(true);
    expect(isAccent("rgb(1,2,3)")).toBe(false);
    expect(toColorValue("#ff0000").hsl).toEqual({ h: 0, s: 100, l: 50, a: 1 });
    expect(toColorValue("#fff").rgb).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
});

describe("glass calculations", () => {
  const base = { surface: "", accent: "", softness: 0, wash: 30, textBrightness: 0 };

  it("keeps blur below the renderer's expensive library ceiling", () => {
    expect(DEFAULT_GLASS_BLUR).toBe(12);
    expect(glassTuning({ ...base, glassBlur: 50 }).blur).toBe(MAX_GLASS_BLUR);
    expect(glassTuning({ ...base, glassBlur: 8 }).blur).toBe(8);
    expect(MAX_GLASS_BLUR).toBeLessThan(50);
  });

  it("derives one bounded panel vocabulary from the library axes", () => {
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

  it("derives native tint from opacity without touching a document", () => {
    expect(windowChromeForTheme({ ...base, accent: "#3366cc" }).enabled).toBe(true);
    expect(windowChromeForTheme({ ...base, accent: "#3366cc", glassOpacity: 0 }).tint).toEqual([
      51, 102, 204, 0,
    ]);
    const dim = windowChromeForTheme({ ...base, accent: "#3366cc", glassOpacity: 20 }).tint;
    const solid = windowChromeForTheme({ ...base, accent: "#3366cc", glassOpacity: 90 }).tint;
    expect(dim?.[3]).toBeLessThan(solid?.[3] ?? 0);
  });
});
