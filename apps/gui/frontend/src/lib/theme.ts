import type { ColorValue } from "@pathscale/ui/components/color-wheel-flower";
import type { ThemeSettings } from "~/types";

/**
 * Applies the theme axes to the document.
 *
 * The stylesheet separates `--az-surface` from `--color-primary`, so the
 * workspace wash and the interactive accent can have unrelated bases.
 *
 * Deliberately *not* `@pathscale/ui`'s own `createHueShiftStore` or contrast
 * palette. Those write NoFilter's base tokens and brighten dark-mode swatches;
 * AgencyZero needs literal dark-oriented values feeding its own surface ladder.
 */

/** The palette's own accent, for when the setting is empty. Matches `theme.css`. */
export const DEFAULT_ACCENT = "#d2ad3f";

/** One curated control accent shown beside the surface controls. */
export interface AccentOption {
  /** Empty preserves the designed palette rather than storing its current hex. */
  value: string;
  color: string;
}

/**
 * The 31 literal wheel values, from the outside ring to the centre.
 *
 * These are intentionally *not* the upstream wheel's contrast palettes. Its
 * dark-theme set is pastel so the dots pop against black; the owner wants the
 * chosen colours themselves to be dark-oriented. Every button displays and
 * stores the same generated hex, so selection can never drift from its swatch.
 */
export function surfaceColors(mode: "light" | "dark"): string[] {
  const ringHues = [42, 24, 4, 336, 300, 268, 238, 210, 184, 162, 132, 94];
  const innerHues = [30, 330, 270, 210, 150, 90];
  const levels = mode === "dark" ? [22, 33, 44] : [52, 66, 80];
  return [
    ...ringHues.map((hue) => hslToHex(hue, 72, levels[0])),
    ...ringHues.map((hue) => hslToHex(hue, 68, levels[1])),
    ...innerHues.map((hue) => hslToHex(hue, 55, levels[2])),
    mode === "dark" ? "#30343b" : "#f1f3f5",
  ];
}

/**
 * Seven accents that stay legible on the selected workspace background.
 *
 * The surface wheel remains the expressive control. Accent is intentionally a
 * small palette: six harmonies around the selected surface hue plus the
 * product's designed yellow. Softness moves the accents visibly toward the
 * middle from opposite sides in light and dark mode, while strength controls
 * saturation.
 */
export function accentOptions(
  surface: string,
  mode: "light" | "dark",
  wash: number,
  softness: number,
): AccentOption[] {
  const base = toColorValue(isAccent(surface) ? surface : DEFAULT_ACCENT).hsl.h;
  const strength = normalizeWash(wash) / 50;
  const lift = Math.min(Math.max(softness, 0), MAX_SOFTNESS);
  const saturation = 50 + strength * 32 - lift * 2;
  const lightness = mode === "light" ? 54 - lift * 2.3 : 44 + lift * 2.5;
  const harmonies = [0, 35, 95, 155, 180, 250].map((offset) => {
    const color = hslToHex((base + offset) % 360, saturation, lightness);
    return { value: color, color };
  });
  return [{ value: "", color: defaultAccent(wash, softness) }, ...harmonies];
}

/** The designed yellow follows softness too; empty is a semantic choice, not a frozen hex. */
export function defaultAccent(wash: number, softness: number): string {
  const hue = toColorValue(DEFAULT_ACCENT).hsl.h;
  const strength = normalizeWash(wash) / 50;
  const lift = Math.min(Math.max(softness, 0), MAX_SOFTNESS);
  return hslToHex(hue, 58 + strength * 10 - lift * 2, 52 + lift * 0.9);
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
 * it. nofilter.io mixes roughly 8–11% into its base tiers; the first stop keeps
 * that restrained floor while the remaining four make the useful range visible.
 *
 * Every stop carries colour. The old zero stop always produced grey, while
 * values beyond fifty percent erased the neutral foundation. Five even steps
 * across the useful 10–50% interval make the whole control meaningful.
 */
export const WASH_STOPS = [10, 20, 30, 40, 50] as const;

/** What a freshly picked colour washes at, before anyone touches the strength. */
export const DEFAULT_WASH = 30;

/**
 * Where the glass slider starts when it is switched on.
 *
 * A visible amount rather than a token one: turning glass on and seeing almost
 * nothing reads as a broken switch. Tunable straight afterwards.
 */
export const DEFAULT_GLASS = 45;

/** Map records from earlier stop layouts onto the nearest current choice. */
export function normalizeWash(value: number): number {
  const safe = Number.isFinite(value) ? value : DEFAULT_WASH;
  return WASH_STOPS.reduce((closest, stop) =>
    Math.abs(stop - safe) < Math.abs(closest - safe) ? stop : closest,
  );
}

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

/** Nearest literal palette entry for one older or mode-shifted hex value. */
export function closestColorIndex(value: string, colors: string[]): number {
  if (!isAccent(value) || colors.length === 0) return -1;
  const current = toColorValue(value).hsl;
  let closest = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < colors.length; index += 1) {
    const candidate = toColorValue(colors[index]).hsl;
    const rawHue = Math.abs(current.h - candidate.h) % 360;
    const hue = Math.min(rawHue, 360 - rawHue);
    const score = hue * 2 + Math.abs(current.s - candidate.s) + Math.abs(current.l - candidate.l);
    if (score < best) {
      closest = index;
      best = score;
    }
  }
  return closest;
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
): { tint?: [number, number, number, number]; radius?: number; enabled: boolean } {
  const surfaceChosen = isAccent(theme.surface);
  const surface = surfaceChosen ? theme.surface.trim() : DEFAULT_ACCENT;
  const softness = Math.min(Math.max(theme.softness || 0, 0), MAX_SOFTNESS);
  /*
   * No accent means the designed palette, and the designed palette is not a
   * yellow-washed one — so the wash applies only once something has actually
   * been picked. Reset therefore returns the workspace to grey, rather than to
   * grey plus whatever wash was last set.
   */
  const configuredWash = normalizeWash(theme.wash ?? DEFAULT_WASH);
  const wash = surfaceChosen ? configuredWash : 0;
  const accent = isAccent(theme.accent)
    ? theme.accent.trim()
    : defaultAccent(configuredWash, softness);
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

  /*
   * The three glass axes, written straight onto the root.
   *
   * Applied here rather than from a module of their own so they travel with
   * every other theme value — one call site, so there is no second place a
   * stale value could come from.
   *
   * Each default is the untouched look: no lift, the 16% hairline, no shadow.
   * A property is removed rather than written at its default, so the
   * stylesheet's own value applies and nothing inline needs explaining later.
   *
   * There is no blur axis. Blur belongs to the compositor's glass view, and CSS
   * `backdrop-filter` cannot drive it on either shipping renderer, so a blur
   * slider would move nothing.
   */
  writeGlassAxis("lift", theme.glassLift);
  writeGlassAxis("border", theme.glassBorder);
  writeGlassAxis("shadow", theme.glassShadow);

  return windowChrome(accent, theme);
}

/**
 * The three glass axes, and their defaults.
 *
 * The default is the untouched look: no lift, the 16% hairline, no shadow.
 * A property is *removed* rather than written at its default, so the
 * stylesheet's own value applies and nothing inline needs explaining later.
 *
 * There is no blur axis. Blur belongs to the compositor's glass view, and CSS
 * `backdrop-filter` cannot drive it on either shipping renderer, so a blur
 * slider would move nothing.
 */
const GLASS_AXES = {
  lift: { property: "--az-glass-lift", fallback: 0, unit: "%" },
  border: { property: "--az-glass-border", fallback: 16, unit: "%" },
  shadow: { property: "--az-glass-shadow", fallback: 0, unit: "" },
} as const;

export type GlassAxisName = keyof typeof GLASS_AXES;

/**
 * Write one axis straight onto the root.
 *
 * Exported so a slider can paint while it is being dragged. `applyTheme` is
 * reached only after a settings round trip has returned, which for a drag meant
 * every tick queued behind a store write and a native call: the log for one
 * session held 75 `set_settings` and 76 `set_window_chrome` calls, at 7 and 6ms
 * each, all on the window thread. The knob moved and the panel followed a beat
 * later, and dragging depth starved paint badly enough to blank the window.
 *
 * A custom property costs one style invalidation, so a preview is free by
 * comparison and the persist can wait until the drag settles.
 */
export function writeGlassAxis(axis: GlassAxisName, value: number | undefined): void {
  const root = document.documentElement;
  const { property, fallback, unit } = GLASS_AXES[axis];
  const resolved = Number.isFinite(value) ? Number(value) : fallback;
  if (resolved === fallback) {
    root.style.removeProperty(property);
    return;
  }
  root.style.setProperty(property, `${resolved}${unit}`);
}

/**
 * Whether the native glass view should be attached at all.
 *
 * False while the window is opaque. Turning this on requires `transparent: true`
 * back in the window config *and* the transparent-composite path proven, or the
 * glass simply covers the app.
 */
const WINDOW_GLASS_ENABLED = false;

/**
 * The window chrome the native frame should wear, derived from the same values
 * the page just took.
 *
 * Returned rather than sent from here so this stays a pure function of the
 * theme: the caller owns the round trip to Rust. The accent is already resolved
 * above, so the frame and the page cannot disagree about what the accent is.
 *
 * The edge axis becomes the tint's alpha, so one slider moves the panel
 * hairline and the window's own border together.
 */
export function windowChrome(
  accent: string,
  theme: ThemeSettings,
): { tint?: [number, number, number, number]; radius?: number; enabled: boolean } {
  const border = Number.isFinite(theme.glassBorder) ? Number(theme.glassBorder) : 16;
  const rgb = hexToRgb(accent);
  /*
   * Off unless the window is actually glass, and it is not: the transparent
   * flag was removed from the window config, so there is nothing behind the
   * page to show through.
   *
   * Enabling it anyway put a tinted `NSGlassEffectView` over an opaque window
   * and washed the entire app out — every surface flattened under one colour.
   * The tint is still computed, so the frame is ready the moment glass is real;
   * it just is not attached to an opaque window.
   */
  if (!rgb || !WINDOW_GLASS_ENABLED) return { enabled: false };
  return {
    tint: [rgb[0], rgb[1], rgb[2], Math.round((border / 100) * 255)],
    // macOS 26's own window radius. Stated rather than left to the effect view,
    // which otherwise squares off against a rounded frame.
    radius: 12,
    enabled: true,
  };
}

/** `#rgb` / `#rrggbb` to bytes. Anything else is not a colour we can send. */
function hexToRgb(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
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
