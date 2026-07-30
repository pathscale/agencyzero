import type { ColorValue } from "@pathscale/ui/components/color-wheel-flower";
import type { ThemeSettings } from "~/types";

/**
 * Applies the theme axes to the document.
 *
 * The stylesheet writes every colour as an expression over `--az-hue`,
 * `--az-tint`, `--az-lift` and `--az-damp` (see `styles/theme.css`), so
 * retinting the workspace is four `setProperty` calls rather than a second
 * palette. Nothing else in the app writes those variables.
 *
 * Deliberately *not* `@pathscale/ui`'s own `createHueShiftStore`, though the
 * wheel this drives is theirs. That store writes `--color-base-*` against
 * NoFilter's anchors and picks its light/dark set by reading `data-theme` for
 * the literal strings "light" or "dark" — this app's is `agencyzero`, so it
 * falls through to the OS preference and would paint 98%-white surfaces over a
 * dark workspace on any Mac set to Light. The wheel is reusable; its
 * application layer is not.
 */

/** The palette's own accent, for when the setting is empty. Matches `theme.css`. */
export const DEFAULT_ACCENT = "#ffee58";

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
  const accent = isAccent(theme.accent) ? theme.accent.trim() : DEFAULT_ACCENT;
  const softness = Math.min(Math.max(theme.softness || 0, 0), MAX_SOFTNESS);

  root.style.setProperty("--color-primary", accent);
  root.style.setProperty("--color-accent", accent);
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
  root.style.setProperty("--az-damp", `${(softness * DAMP_RATIO).toFixed(2)}%`);
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
