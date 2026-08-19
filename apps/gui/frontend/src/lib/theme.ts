import {
  applyGlassTokens,
  GLASS_DEFAULTS,
  GLASS_LIMITS,
  type GlassMode,
  type GlassTuning,
} from "@pathscale/ui";
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

  /*
   * The second accent, for the things that are drawn rather than operated.
   *
   * Icons and SVG fills take this one, so artwork can be livelier than the
   * chrome without dragging a focused ring or a filled slider along with it.
   * Empty follows the first accent, which is what a record that never chose
   * one should look like: one accent behaves exactly as it did before this
   * axis existed.
   *
   * Its own ink for the same reason the first has one: a picked colour can be
   * anything from near-black to near-white, so a label sitting on it has to be
   * chosen against it rather than assumed.
   */
  const accentTwo = isAccent(theme.accentTwo ?? "") ? theme.accentTwo!.trim() : accent;
  root.style.setProperty("--color-accent-2", accentTwo);
  root.style.setProperty("--color-accent-2-content", readableInk(accentTwo));

  root.style.setProperty("--az-lift", `${softness}%`);
  /*
   * Damp is what softness takes off the text; brightness gives it back, and may
   * overshoot into negative damp — that is the point, since the complaint that
   * produced this axis was prose reading washed out at the *designed* palette,
   * before any softness was applied at all.
   */
  root.style.setProperty("--az-damp", `${(softness * DAMP_RATIO - brightness).toFixed(2)}%`);

  /*
   * The panel axes, derived from the same three numbers the library's glass
   * takes rather than set from three sliders of their own.
   *
   * Applied here rather than from a module of their own so they travel with
   * every other theme value — one call site, so there is no second place a
   * stale value could come from.
   */
  writePanelAxes(glassTuning(theme, root));
  writeGlassTuning(theme, root);

  return windowChrome(accent, theme);
}

/**
 * The library's glass, from the three numbers it derives everything else from.
 *
 * `@pathscale/ui` styles `material="glass"` off a family of `--glass-*` custom
 * properties and ships `applyGlassTokens` to write the twenty-five derived ones
 * from `blur`, `refraction` and `depth`. Calling it here rather than keeping a
 * local copy of the curves means the app and the library cannot disagree about
 * what glass looks like, and a library that retunes them retunes this too.
 *
 * An axis the settings leave undefined falls to `GLASS_DEFAULTS` for the
 * current colour mode, so this is always a complete set: three of the tokens
 * are read by the component CSS without a fallback, and a partial set gives a
 * card with no background rather than a plainer one.
 *
 * Blur used to be excluded here, on the grounds that neither shipping renderer
 * could carry `backdrop-filter`. That stopped being true: vello now has a real
 * backdrop pass (`record_backdrop`), so the blur axis reaches the screen.
 */
function writeGlassTuning(theme: ThemeSettings, root: HTMLElement): void {
  const mode: GlassMode = root.dataset.colorMode === "light" ? "light" : "dark";
  applyGlassTokens(glassTuning(theme, root), mode, root);

  /*
   * How opaque the surface's own film is, as its own axis.
   *
   * The library derives `--glass-background-opacity` from refraction alone,
   * and on a dark surface that curve is `7 * refraction`: at the shipped 0.31
   * it lands on about 5%, which is a film nobody can see. Raising it meant
   * raising refraction, which also drives the border, the highlight, the rim
   * and the inner glow, so "make the glass more solid" arrived as "make every
   * edge shout".
   *
   * Written after `applyGlassTokens` so it overrides that one derived token
   * and leaves the other twenty-four alone. Undefined means untouched, so a
   * theme that never sets it keeps exactly the library's look.
   */
  /*
   * The off switch, ahead of every axis.
   *
   * `glassEnabled: false` means no translucent surfaces anywhere, so it has to
   * suppress the film, the control tint, the desk alpha and the library's root
   * class together. Expressed by forcing the opacity axis out of the finite
   * range every branch below already tests, so there is one condition deciding
   * this rather than two that can disagree.
   *
   * Absent means on, so a record written before the switch existed keeps the
   * appearance it already had.
   */
  const opacity =
    theme.glassEnabled === false ? Number.NaN : (theme.glassOpacity ?? DEFAULT_GLASS_OPACITY);

  /*
   * The library's material flip, thrown from the same test that decides whether
   * this app writes its own glass at all.
   *
   * `@pathscale/ui` components default to `material="solid"`, so before 2.7.0
   * glass reached the surfaces styled here and stopped dead at every library
   * control. In a light palette their `base-100` fill is white, so the language
   * button, the model pickers, every radio and the analytics tab strip painted
   * bright slabs on a dark glass panel. One class turns the default over for all
   * of them, which is why nothing here enumerates components: a control added
   * next month follows without this file changing.
   *
   * Sharing the condition rather than repeating it is the point. Two separate
   * tests for "is glass on" is how they drift apart and the app ends up with
   * library controls glassed while its own panels are not.
   */
  root.classList.toggle("glass", Number.isFinite(opacity));

  if (Number.isFinite(opacity)) {
    root.style.setProperty("--glass-background-opacity", `${Number(opacity)}%`);

    /*
     * Controls take part of the film rather than none of it.
     *
     * The library defaults `--glass-control-opacity` to 100%, so that flipping
     * glass on cannot make a switch or a select trigger unreadable in an app
     * that has not thought about it. This app has. Its controls sit on glass
     * panels over a translucent desk, and held fully opaque they are the only
     * solid things in the window: the language button, the model pickers and
     * the segmented pills all read as bright slabs rather than as chrome.
     *
     * A third of the way from opaque toward the panel, not the whole way. A
     * control still has to say it is live and keep its label legible against
     * whatever passes behind it, so it takes just enough of the film to stop
     * reading as a foreign material. At the default 55% panel that is 85%.
     */
    const film = Math.min(Math.max(Number(opacity), 0), 100);
    root.style.setProperty("--glass-control-opacity", `${Math.round(100 - (100 - film) * 0.33)}%`);

    /*
     * The same axis, applied to the two surfaces that cover the whole window.
     *
     * `--glass-background-opacity` only reaches panels, so on its own the
     * slider moved the cards and left the desk, the body and the titlebar
     * exactly as solid as before: the app could not be seen through at any
     * setting, which is not what a control called opacity promises.
     *
     * `--az-glass-alpha` is the knob the stylesheet already had for that, on
     * `body` and `.az-desk`, and nothing had ever written it. It runs the
     * other way round: 100% is the flat colour, lower lets the window behind
     * show through.
     *
     * Passed straight through rather than through a curve. The first attempt
     * mapped the axis onto 45..100 so the desk would stay readable, and the
     * result was a control that could not do the one thing it is named for:
     * at the default 55 it wrote 75%, which is a desk nobody would call
     * transparent, and its floor of 45% meant the window never cleared however
     * far the slider went. Readability is the owner's call at this point, and
     * the number on the slider is now the number on the surface.
     */
    const solid = Math.min(Math.max(Number(opacity), 0), 100);
    root.style.setProperty("--az-glass-alpha", `${Math.round(solid)}%`);
  } else {
    root.style.removeProperty("--glass-background-opacity");
    root.style.removeProperty("--glass-control-opacity");
    root.style.removeProperty("--az-glass-alpha");
  }

  /*
   * The scrim: how much the surface darkens what it sits over.
   *
   * Separate from the film because they pull in opposite directions. The film
   * is the surface's own colour and lightens a dark desk; the scrim is a wash
   * under it that holds contrast for text when the backdrop is busy.
   */
  const scrim = theme.glassScrim ?? DEFAULT_GLASS_SCRIM;
  if (Number.isFinite(scrim)) {
    root.style.setProperty("--az-glass-scrim-opacity", `${Number(scrim)}%`);
    /*
     * The film colour with the scrim already mixed in.
     *
     * Written here rather than composed in CSS. Nesting a `color-mix` inside
     * the `rgb(from …)` that carries the alpha made Lightning CSS split the
     * declaration and emit `rgb(0 0 0 / …)` as the fallback, which is a plain
     * black panel. One variable is a value no minifier rewrites.
     */
    root.style.setProperty(
      "--az-glass-film",
      `color-mix(in oklab, black ${Number(scrim)}%, var(--color-az-badge))`,
    );
  } else {
    root.style.removeProperty("--az-glass-scrim-opacity");
    root.style.removeProperty("--az-glass-film");
  }
}

/**
 * The three numbers glass is made of, with every unset axis resolved.
 *
 * Read the colour mode from the root rather than importing the prefs store:
 * this module is a pure function of the theme it is handed, and `stores/prefs`
 * already writes the mode here on every change.
 *
 * Always a complete set. Three of the library's tokens are read by component
 * CSS without a fallback, and an undefined custom property drops the whole
 * declaration rather than falling back to an initial value, so a partial
 * tuning gives a card with no background rather than a plainer one.
 */
export function glassTuning(theme: ThemeSettings, root: HTMLElement): GlassTuning {
  const mode: GlassMode = root.dataset.colorMode === "light" ? "light" : "dark";
  const defaults = GLASS_DEFAULTS[mode];
  const resolve = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) ? Number(value) : fallback;

  return {
    blur: Math.min(resolve(theme.glassBlur, DEFAULT_GLASS_BLUR), MAX_GLASS_BLUR),
    refraction: resolve(theme.glassRefraction, defaults.refraction),
    depth: resolve(theme.glassDepth, defaults.depth),
  };
}

/**
 * How far a glass surface smears what is behind it, and the ceiling on it.
 *
 * Blur radius is the single biggest cost in a frame this app draws, and not
 * because blurring is expensive. `backdrop-filter` cannot read a scene that
 * has not been rasterised, so the renderer cuts the frame into segments, and
 * each segment costs a full-frame render, a full-frame texture copy into the
 * atlas, a blur, and a full-frame draw. Two panels can share one segment only
 * when neither one's blur can read a pixel the other painted, and a gaussian
 * reaches about 3σ past its own edge.
 *
 * The library ships 50px, which reaches 150px. This app's panels sit 12px
 * apart, so at that radius **nothing can ever batch**: six panels cost seven
 * render passes where six spaced-out ones cost two
 * (`blitz-tests --test glass_pass_count`). Measured on the running app that
 * was 119-181ms of renderer per frame against 1.7ms of layout, a window
 * repainting two or three times a second and reading as blank.
 *
 * 12 keeps the reach at 36px, which is still more than the gap, so panels in a
 * column do not batch either. It is chosen as the point where the blur still
 * reads as glass while costing a quarter of the bandwidth, and the ceiling
 * stops a slider drag from walking back into the pathological range. Widening
 * the gaps past 3σ is the change that would let batching work at all, and it
 * belongs to the layout rather than here.
 */
/**
 * How solid a glass surface's own film is, as a percentage.
 *
 * The library derives this from refraction, and on a dark surface that curve
 * is `7 * refraction`: at the shipped 0.31 it lands near 5%, which is a film
 * nobody can see. 55% is the value the stylesheet already carried as its
 * fallback for `--glass-background-opacity`, so an untouched theme now renders
 * what that fallback always described.
 */
export const DEFAULT_GLASS_OPACITY = 55;

/**
 * How much a glass surface darkens what it sits over, as a percentage.
 *
 * Zero by default: the scrim exists for a busy backdrop, and adding one to a
 * quiet desk only makes the panel muddier than the design asks for.
 */
export const DEFAULT_GLASS_SCRIM = 0;

export const DEFAULT_GLASS_BLUR = 12;
export const MAX_GLASS_BLUR = 24;

/**
 * AgencyZero's own panel, expressed in the library's three numbers.
 *
 * `.az-panel` is opaque and leans on the hue ladder rather than white, so it
 * cannot use the library's tokens directly: frost needs something light
 * beneath it to diffuse, and on a dark surface a white film reads as grey haze
 * on the colour rather than as material. It still describes the same three
 * physical properties, so it is derived from them rather than given a second
 * set of sliders.
 *
 * That it *had* a second set is the bug this replaces. Six sliders where the
 * library says three, and two of them named "depth" — one moving the panel's
 * drop shadow and one moving glass's glow and sheen — so setting the two
 * against each other was not just possible, it was the default state after
 * touching either.
 *
 * The three mappings, each over the library's own range:
 *
 *   lift    from refraction, since both say how much the surface asserts
 *           itself over what is behind it.
 *   border  from refraction too, which is what drives the library's own border
 *           and rim tokens. Held at the stylesheet's 16% hairline at rest so
 *           an untouched theme looks untouched.
 *   shadow  from depth, which is the axis that means "off the page".
 */
const PANEL_AXES = {
  lift: "--az-glass-lift",
  border: "--az-glass-border",
  shadow: "--az-glass-shadow",
} as const;

export type GlassAxisName = keyof typeof PANEL_AXES;

/** The panel values a tuning implies, in the units the stylesheet reads. */
export function panelAxes(tuning: GlassTuning): Record<GlassAxisName, number> {
  const refraction = tuning.refraction / GLASS_LIMITS.refraction.max;
  const depth = tuning.depth / GLASS_LIMITS.depth.max;

  return {
    // 0 to 60%, the range the panel lift slider used to offer.
    lift: Math.round(refraction * 60),
    // The hairline never disappears entirely; it runs from the stylesheet's
    // 16% up to 60% as the surface asserts itself.
    border: Math.round(16 + refraction * 44),
    // A 0..1 alpha rather than a percentage, as the box-shadow reads it.
    shadow: Number((depth * 0.6).toFixed(3)),
  };
}

/**
 * Write the derived panel axes onto the root.
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
export function writePanelAxes(tuning: GlassTuning, root?: HTMLElement): void {
  const target = root ?? document.documentElement;
  const values = panelAxes(tuning);
  target.style.setProperty(PANEL_AXES.lift, `${values.lift}%`);
  target.style.setProperty(PANEL_AXES.border, `${values.border}%`);
  target.style.setProperty(PANEL_AXES.shadow, `${values.shadow}`);
}

/**
 * Whether the native glass view should be attached at all.
 *
 * True, now that the backdrop is attached correctly.
 *
 * This was off because `window_vibrancy::apply_liquid_glass` inserts its glass
 * view as a *subview of the renderer's own view*, so the glass landed on top of
 * everything drawn and frosted the whole application, text included. That was
 * not a reason to give up the effect, it was the wrong attachment.
 *
 * `tauri-runtime-blitz` now attaches an `NSGlassEffectView` as a *sibling*
 * below the renderer's view, in the window's content view, so it blurs what is
 * behind the window and the content draws over it untouched.
 *
 * This is the only thing that can blur the desktop. `backdrop-filter` samples
 * pixels the renderer drew, and behind a transparent window there are none: the
 * desktop is composited by macOS, out of reach of anything in CSS. So the two
 * blurs do different jobs. This one frosts what is behind the window; the CSS
 * one frosts what the app itself painted behind a panel.
 */
const WINDOW_GLASS_ENABLED = true;

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
  const rgb = hexToRgb(accent);
  /*
   * The backdrop's tint follows the opacity axis, not the border axis.
   *
   * It used to take its alpha from `glassBorder`, which is the panel hairline:
   * a number that has nothing to do with how solid the window should look, and
   * one that never reaches zero. The result was a tinted sheet filling the
   * window that stayed put at opacity 0, so the app read as solid at the exact
   * setting where it should have been clearest.
   *
   * At zero the view is left untinted rather than tinted with zero alpha, so
   * the backdrop is the blurred desktop and nothing else.
   */
  const filmOpacity = Number.isFinite(theme.glassOpacity)
    ? Number(theme.glassOpacity)
    : DEFAULT_GLASS_OPACITY;
  const tintAlpha = Math.round((Math.min(Math.max(filmOpacity, 0), 100) / 100) * 255);
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
    tint: tintAlpha > 0 ? [rgb[0], rgb[1], rgb[2], tintAlpha] : undefined,
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
  /*
   * White unless it is genuinely unreadable, rather than whichever scores higher.
   *
   * Picking the larger of the two contrast ratios is defensible arithmetic and
   * wrong to look at. A mid-tone accent hands the win to black — measured on
   * the pink the owner reported, black scores 7.83 against white's 2.16 — so
   * the selected pill rendered as black text on a pink fill. Filled controls
   * across the rest of this app carry light ink, so the one that flipped read
   * as a rendering fault rather than as a contrast decision.
   *
   * 3.4:1 is the threshold, a little above the 3:1 that WCAG asks of large
   * text: these are pills and badges, short and set in a semibold face at
   * 11-12px. Below it the accent is light enough that white really is illegible
   * and the dark ink is the honest answer.
   */
  const onWhite = 1.05 / (luminance + 0.05);
  return onWhite >= 3.4 ? "#ffffff" : "#111111";
}
