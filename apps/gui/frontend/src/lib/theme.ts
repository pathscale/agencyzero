import type { ColorValue } from "@pathscale/ui/components/color-wheel-flower";
import type { ThemeSettings } from "~/types";

/**
 * Applies the theme axes to the document.
 *
 * The stylesheet separates `--az-surface` from `--color-primary`, so the
 * workspace wash and the interactive accent can have unrelated bases.
 *
 * Deliberately *not* `@pathscale/ui`'s own `createHueShiftStore`, though the
 * wheel this drives is theirs. That store writes `--color-base-*` against
 * NoFilter's anchors. AgencyZero keeps its own surface ladder and exposes the
 * conventional light/dark `data-theme` only so the wheel renders the matching
 * swatch set.
 */

/** The palette's own accent, for when the setting is empty. Matches `theme.css`. */
export const DEFAULT_ACCENT = "#ffee58";

/** One curated control accent shown beside the surface controls. */
export interface AccentOption {
  /** Empty preserves the designed palette rather than storing its current hex. */
  value: string;
  color: string;
}

/**
 * Seven accents that stay legible on the selected workspace background.
 *
 * The surface wheel remains the expressive control. Accent is intentionally a
 * small palette: six harmonies around the selected surface hue plus the
 * product's designed yellow. Dark mode gets bright controls and light mode gets
 * dark controls, so every option reads as an action rather than another patch
 * of background colour.
 */
export function accentOptions(
  surface: string,
  mode: "light" | "dark",
  wash: number,
  softness: number,
): AccentOption[] {
  const base = toColorValue(isAccent(surface) ? surface : DEFAULT_ACCENT).hsl.h;
  const strength = Math.min(Math.max(wash, 0), 100) / 100;
  const lift = Math.min(Math.max(softness, 0), MAX_SOFTNESS);
  const saturation = 52 + strength * 38;
  const lightness = mode === "light" ? 42 - lift * 0.5 : 62 + lift * 0.65;
  const harmonies = [0, 35, 95, 155, 180, 250].map((offset) => {
    const color = hslToHex((base + offset) % 360, saturation, lightness);
    return { value: color, color };
  });
  return [{ value: "", color: DEFAULT_ACCENT }, ...harmonies];
}

/**
 * How far the softness axis may travel, in oklch percentage points.
 *
 * 12 lands the desk near 22% — dark still, but off the near-black floor that
 * makes bright text glare. Past that the surface ladder starts colliding with
 * the card tier above it and the depth cues the layout relies on flatten out.
 */
export const MAX_SOFTNESS = 12;

/** Text comes down more gently than surfaces go up; equal amounts wash it out. */
const DAMP_RATIO = 0.45;

/**
 * How much of the accent washes into the surfaces, in percent.
 *
 * The axis that makes a pick read as a *theme* rather than a highlight: without
 * it the wheel recolours buttons and rings while the workspace stays the same
 * grey, which is exactly how this first shipped and exactly what was wrong with
 * it. nofilter.io mixes 8–11% into its base tiers; the stops below bracket that,
 * with `0` kept reachable because the designed palette is a legitimate choice.
 *
 * The final stop is deliberately literal: at 100% the selected wheel colour is
 * the surface colour, not an approximation hidden behind another mix. The
 * intermediate stops keep the useful neutral-to-colour progression.
 */
export const WASH_STOPS = [0, 10, 25, 50, 100] as const;

/** What a freshly picked colour washes at, before anyone touches the strength. */
export const DEFAULT_WASH = 10;

/**
 * How far the text ladder can be pushed back up, in oklch percentage points.
 *
 * Softness dims the text as it lifts the surfaces — right for glare, and the
 * reason prose can end up reading faded. This is the counterweight, so the two
 * wants stop being one number.
 *
 * The ceiling is 6: the design's top rung is 86% and its stated rule is that
 * nothing reaches pure white, so +6 puts the title at 92% and leaves the rule
 * intact. The floor is symmetric for anyone who wants prose quieter still.
 */
export const BRIGHTNESS_STOPS = [-4, -2, 0, 3, 6] as const;

/** `#rgb` and `#rrggbb`, the two forms the wheel emits. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isAccent(value: string): boolean {
  return HEX.test(value.trim());
}

/**
 * Write the axes onto `:root`.
 *
 * Clamped here rather than at the setting, so a record written by a build with
 * a wider range renders at this build's edge instead of making the app
 * unreadable — the stylesheet has no opinion about how far is too far.
 */
export function applyTheme(
  theme: ThemeSettings,
  root: HTMLElement = document.documentElement,
): void {
  const surfaceChosen = isAccent(theme.surface);
  const surface = surfaceChosen ? theme.surface.trim() : DEFAULT_ACCENT;
  const accent = isAccent(theme.accent) ? theme.accent.trim() : DEFAULT_ACCENT;
  const softness = Math.min(Math.max(theme.softness || 0, 0), MAX_SOFTNESS);
  /*
   * No accent means the designed palette, and the designed palette is not a
   * yellow-washed one — so the wash applies only once something has actually
   * been picked. Reset therefore returns the workspace to grey, rather than to
   * grey plus whatever wash was last set.
   */
  const wash = surfaceChosen
    ? Math.min(Math.max(theme.wash ?? DEFAULT_WASH, 0), WASH_STOPS[WASH_STOPS.length - 1])
    : 0;
  const brightness = Math.min(
    Math.max(theme.textBrightness || 0, BRIGHTNESS_STOPS[0]),
    BRIGHTNESS_STOPS[BRIGHTNESS_STOPS.length - 1],
  );

  root.style.setProperty("--az-surface", surface);
  root.style.setProperty("--color-primary", accent);
  root.style.setProperty("--color-accent", accent);
  root.style.setProperty("--az-wash", `${wash}%`);
  /*
   * What sits *on* the accent. A picked colour can be anything from near-black
   * to near-white, so the label has to be chosen against it rather than left at
   * the palette's dark ink — otherwise the send button's text disappears the
   * moment someone picks a dark blue.
   */
  const ink = readableInk(accent);
  root.style.setProperty("--color-primary-content", ink);
  root.style.setProperty("--color-accent-content", ink);

  root.style.setProperty("--az-lift", `${softness}%`);
  /*
   * Damp is what softness takes off the text; brightness gives it back, and may
   * overshoot into negative damp — that is the point, since the complaint that
   * produced this axis was prose reading washed out at the *designed* palette,
   * before any softness was applied at all.
   */
  root.style.setProperty("--az-damp", `${(softness * DAMP_RATIO - brightness).toFixed(2)}%`);
}

/**
 * The wheel's `ColorValue` for a hex string.
 *
 * Written here rather than imported from the package's own `ColorUtils`: that
 * module sits one level below `./components/*`, which the export map resolves to
 * a directory index, so the deep path resolves to nothing. The wheel reads
 * `hsl.s`, `hsl.l` and `hsl.a` to find the nearest petal and to keep the
 * selection ring in place, so all three parts have to be real.
 */
export function toColorValue(hex: string): ColorValue {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));

  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const span = max - min;
  const l = (max + min) / 2;

  let hue = 0;
  if (span !== 0) {
    if (max === rn) hue = ((gn - bn) / span) % 6;
    else if (max === gn) hue = (bn - rn) / span + 2;
    else hue = (rn - gn) / span + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const saturation = span === 0 ? 0 : span / (1 - Math.abs(2 * l - 1));

  return {
    rgb: { r, g, b, a: 1 },
    hsl: { h: hue, s: saturation * 100, l: l * 100, a: 1 },
    hex: `#${full}`,
  };
}

/** Convert one generated HSL harmony to the persisted `#rrggbb` shape. */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const sector = hue / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r1, g1, b1] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const match = l - chroma / 2;
  return `#${[r1, g1, b1]
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Black or white ink for a background, by WCAG relative luminance.
 *
 * The same rule `@pathscale/ui`'s store uses, reimplemented because it is four
 * lines and importing it would drag in the application layer this module exists
 * to avoid.
 */
function readableInk(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const channel = (at: number) => {
    const srgb = Number.parseInt(full.slice(at, at + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // Against #111111 rather than pure black: the palette's own ink, and a hair
  // softer than the maximum contrast the pairing would otherwise reach for.
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.062 ? "#ffffff" : "#111111";
}
