import type { ColorValue } from "@pathscale/ui/components/color-wheel-flower";
import {
  applyGlassTokens,
  GLASS_DEFAULTS,
  GLASS_LIMITS,
  type GlassMode,
  type GlassTuning,
} from "@pathscale/ui/styles/glass.js";
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

/*
 * Every default a theme starts from lives in `themeDefaults.ts`, so a generator
 * can emit one file and get a complete theme. They are re-exported here because
 * this module was where callers found them, and moving the values without
 * moving the import surface would be a rename dressed up as a refactor.
 */
export {
  BRIGHTNESS_STOPS,
  DEFAULT_ACCENT,
  DEFAULT_ACCENT_TWO,
  DEFAULT_GLASS,
  DEFAULT_GLASS_BLUR,
  DEFAULT_GLASS_OPACITY,
  DEFAULT_GLASS_SCRIM,
  DEFAULT_SOFTNESS,
  DEFAULT_SURFACE,
  DEFAULT_TEXT_BRIGHTNESS,
  DEFAULT_WASH,
  MAX_GLASS_BLUR,
  MAX_SOFTNESS,
  WASH_STOPS,
} from "~/lib/themeDefaults";

import {
  BRIGHTNESS_STOPS,
  DEFAULT_ACCENT,
  DEFAULT_ACCENT_TWO,
  DEFAULT_GLASS_BLUR,
  DEFAULT_GLASS_OPACITY,
  DEFAULT_GLASS_SCRIM,
  DEFAULT_WASH,
  MAX_GLASS_BLUR,
  MAX_SOFTNESS,
  WASH_STOPS,
} from "~/lib/themeDefaults";

/** One curated control accent shown beside the surface controls. */
export interface AccentOption {
  /**
   * Always a hex colour, including the designed swatch.
   *
   * This was once empty for the designed entry, which collides with "nothing
   * has been picked" - the state every guard in this file tests for - so
   * selecting that swatch stored a value the next apply treated as absent.
   */
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
  /*
   * The designed accent carries its own colour, like every other swatch.
   *
   * It used to store `""`, which collides with "nothing has been picked": every
   * guard in this file reads an empty accent as unset, so selecting the
   * left-hand swatch after picking a real one wrote a value that the next apply
   * treated as absent. Selecting it appeared to do nothing, and it was worse
   * after swapping quickly because the preview and the settings write disagreed
   * about whether an accent existed at all.
   *
   * What is shown is what is stored, so the swatch and the persisted value
   * cannot drift apart.
   */
  const designed = defaultAccent(wash, softness);
  return [{ value: designed, color: designed }, ...harmonies];
}

/** The designed yellow follows softness too, so it is derived rather than frozen. */
export function defaultAccent(wash: number, softness: number): string {
  const hue = toColorValue(DEFAULT_ACCENT).hsl.h;
  const strength = normalizeWash(wash) / 50;
  const lift = Math.min(Math.max(softness, 0), MAX_SOFTNESS);
  return hslToHex(hue, 58 + strength * 10 - lift * 2, 52 + lift * 0.9);
}

/** Text comes down more gently than surfaces go up; equal amounts wash it out. */
const DAMP_RATIO = 0.45;

/** Map records from earlier stop layouts onto the nearest current choice. */
export function normalizeWash(value: number): number {
  const safe = Number.isFinite(value) ? value : DEFAULT_WASH;
  return WASH_STOPS.reduce((closest, stop) =>
    Math.abs(stop - safe) < Math.abs(closest - safe) ? stop : closest,
  );
}

/** `#rgb` and `#rrggbb`, the two forms the wheel emits. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isAccent(value: string): boolean {
  return HEX.test(value.trim());
}

/**
 * Set a custom property, but only when it would actually change.
 *
 * A custom property on the root invalidates every element that inherits it, and
 * this file writes twenty-five of them on every `applyTheme`. Picking an accent
 * changes two or three; the rest are rewritten with the value they already
 * hold, and each of those still pays for a document-wide restyle.
 *
 * Measured on the running app during rapid picks, with the frame log cleared
 * after startup so the numbers are the interaction rather than the launch:
 * `resolve_avg_ms` reached 82.48 with sixteen restyles over 20ms, while
 * `paint_avg_ms` and `renderer_avg_ms` were 0.00 for the same frames. The cost
 * was never drawing and never the store: it was style resolution.
 *
 * Reading a property back before writing it is cheap next to that, because the
 * value is already resolved on the declaration and needs no recomputation.
 */
function setToken(root: HTMLElement, property: string, value: string): void {
  if (root.style.getPropertyValue(property) === value) return;
  root.style.setProperty(property, value);
}

/**
 * Restroke the icons, because a custom property alone does not reach them.
 *
 * Inline SVG is not painted from the DOM on this renderer. `blitz-dom`
 * serialises the `<svg>` element to a string, substitutes the computed
 * `currentColor` into it, and hands that to usvg, which has no stylesheet: the
 * resolved colour is baked into the parsed tree at construction time.
 *
 * That tree is rebuilt only when a node carries *construction* damage. Picking
 * a second accent writes `--color-accent-2` on the root, which is a restyle
 * that changes the inherited `color` and nothing else, so it produces repaint
 * damage and the icons keep stroking the colour they were first built with.
 * Verified against the renderer rather than assumed: with the property written
 * on the root the cached tree's stroke stayed at its original value, while the
 * same change made through a class attribute rebuilt it.
 *
 * Writing the `stroke` attribute is what closes that gap. It is an attribute
 * mutation, so it damages the node for construction, the SVG is re-serialised,
 * and the colour reaches the paint. The value is written literally rather than
 * as `var(--color-accent-2)` because usvg cannot read custom properties either.
 *
 * `.az-icon-inherit` and icons on filled surfaces are skipped: those follow
 * their label's ink deliberately, and `theme.css` already says so.
 */
/**
 * The colour the icons are currently stroked with.
 *
 * An icon that mounts *after* a pick has to be stroked too. `applyTheme` only
 * runs when a theme setting changes, so without this the chrome that mounts
 * later keeps `currentColor` and paints black until some unrelated setting
 * happens to re-run the theme: the reported symptom was the top-right icons
 * refusing to follow accent 2 until the base colour was changed.
 *
 * Not a `MutationObserver`: this renderer has none, and constructing one threw
 * during startup, which surfaced as the workspace failing to load rather than
 * as anything about icons.
 *
 * Not a Solid signal either, though that was the obvious answer. `applyTheme`
 * is called from an effect but also directly, and a `createSignal` setter
 * called outside a reactive root does not update the value in this version:
 * verified in isolation, where `set("a")` followed by a read returned `null`.
 * A signal here reads as reactive and silently is not, which is worse than a
 * plain variable that never pretended.
 *
 * So {@link Icon} reads this while rendering. An icon that mounts after a pick
 * takes the current accent; the ones already mounted are restroked directly by
 * {@link repaintIconStrokes}, because nothing re-renders them.
 */
let iconStroke: string | null = null;

/** The tree the current {@link iconStroke} was actually painted onto. */
let iconStrokeRoot: HTMLElement | null = null;

/**
 * The stroke to paint an icon with before any theme has resolved.
 *
 * A literal colour, because this string is handed to usvg by way of
 * `blitz-dom`'s serialiser. usvg has no stylesheet and no custom properties:
 * given a `var()` it does not fall back, it drops the stroke, and a path with
 * neither stroke nor fill draws nothing. The previous fallback was
 * `var(--color-az-artwork)`, a token defined nowhere in the app, so every icon
 * that mounted before the theme resolved painted blank.
 */
export const ARTWORK_FALLBACK: string = DEFAULT_ACCENT_TWO;

/** The stroke an icon should paint with, or `null` before a theme is applied. */
export function iconStrokeColor(): string | null {
  return iconStroke;
}

/**
 * Stroke one icon, if it is one of the ones the artwork accent owns.
 *
 * Still needed alongside the signal: icons already in the document when a pick
 * happens are not re-rendered by it, because their `stroke` prop is read once
 * per render and nothing about them changed.
 */
function strokeIcon(svg: Element, accentTwo: string): void {
  // Only the icons that stroke with the artwork accent. A sprite root, a
  // decorative shape with its own fill, or anything that never asked for
  // `currentColor` is left exactly as authored.
  const current = svg.getAttribute("stroke");
  if (current === null) return;
  /*
   * The two cheap string comparisons run before the ancestor walk.
   *
   * `closest()` against a three-selector list is by far the most expensive
   * thing here and it used to run first, on every icon, on every tick - so the
   * common case of "this icon is already the right colour" paid full price
   * before being discarded. Ordering it after the equality check means a
   * repeated apply costs one string compare per icon.
   */
  if (current === accentTwo) return;
  if (
    svg.closest(".az-icon-inherit, [class*='text-primary-content'], [class*='text-accent-content']")
  ) {
    return;
  }
  /*
   * The equality check above is load-bearing rather than tidy, which is why it
   * guards the write and not just the cost.
   *
   * `applyTheme` runs from a reactive effect, and writing an attribute mutates
   * the DOM, which restyles, which runs the effect again: an unconditional
   * write is a loop that never yields to paint. Measured as exactly that - the
   * window reported its refresh rate and then rendered zero frames.
   */
  svg.setAttribute("stroke", accentTwo);
}

function repaintIconStrokes(root: HTMLElement, accentTwo: string): void {
  /*
   * Nothing to do when the artwork accent did not move, and that is the whole
   * cost control here.
   *
   * `applyTheme` runs on every settings round trip, so dragging the colour
   * wheel reaches this once per tick. Walking every `<svg>` in a document of
   * ~5000 nodes per tick is work the wheel does not need: the wheel writes
   * `surface` and `accent`, and the artwork accent usually resolves to exactly
   * what it already was. Comparing first turns those ticks into one string
   * comparison.
   */
  /*
   * The published value and the tree that was actually painted, together.
   *
   * A bare `accentTwo === iconStroke` check is wrong once the walk is scoped:
   * the value is module-global while the traversal is per-root, so painting one
   * subtree marked the colour as done and every other root was skipped. The
   * settings write then found nothing to do because the preview had already
   * claimed the colour, and the icons outside the pane kept the old one.
   *
   * Remembering which root was painted keeps the cheap path for the case it
   * exists for - the wheel writing `surface` and `accent` while the artwork
   * accent does not move - without letting one subtree answer for another.
   */
  if (accentTwo === iconStroke && root === iconStrokeRoot) return;
  /*
   * Published before the walk on purpose: an icon that mounts *during* it reads
   * this and strokes itself correctly, so the two paths cannot disagree.
   *
   * The guard above is what makes that safe. It compares the value *and* the
   * root, and both are assigned together here, so a second call with a
   * different colour never matches and always walks. Swapping accents quickly
   * used to drop updates for a different reason - `strokeIcon` skipped any svg
   * whose attribute already matched, while the attribute it compared against
   * was the one the *previous* walk had written.
   */
  iconStroke = accentTwo;
  iconStrokeRoot = root;
  /*
   * Scoped to the root it was handed, not to the whole document.
   *
   * This used to walk `root.ownerDocument`, which is what made calling it from
   * the preview path unsafe: the accent rows reach that path through the rebase
   * effect that keeps a harmony selected across a palette change, and that
   * effect also runs while the tree is still being built, so a traversal of the
   * entire application ran during startup and the window rendered zero frames.
   *
   * The repair at the time was to stop calling this from the preview, which
   * fixed the hang and broke the feature: a pick updated the tokens and left
   * every icon already on screen at its old colour. `iconAccent.test.ts` exists
   * because both of those shipped with the suite green.
   *
   * Honouring the argument fixes both. `applyTheme` passes the document root,
   * so a settings write still reaches every icon; a preview scoped to a subtree
   * pays only for that subtree.
   *
   * The query is the guard, rather than a count of how many times this has run.
   * Startup applies the theme before any icon has mounted, so the walk finds
   * nothing and the only thing it can do is block the first frame: with it, the
   * window reported its refresh rate and rendered zero frames, and A/B
   * rebuilding with the document-root walk removed was what identified it.
   * Nothing is missed, because an icon that mounts after this reads
   * `iconStrokeColor()` as it renders.
   *
   * Asking the tree rather than counting calls keeps this honest in both
   * directions: a startup with no icons costs one empty query, and a pick after
   * the app has mounted walks normally without depending on how many times the
   * theme happened to be applied first.
   */
  /*
   * `svg[stroke]`, not `svg`.
   *
   * `strokeIcon` discards anything without a `stroke` attribute anyway, so
   * selecting them was work the engine could do for free in the query instead.
   * The document runs to ~5000 nodes and this reaches once per settings tick,
   * and the discarded ones were the majority: sprite roots, decorative shapes,
   * anything that never asked for `currentColor`. Each one still paid a
   * `closest()` ancestor walk against a three-selector list before being
   * dropped, which is what made a fast swap between accents stutter.
   */
  const icons = root.querySelectorAll("svg[stroke]");
  for (const svg of icons) {
    strokeIcon(svg, accentTwo);
  }
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
   * The wash applies whether or not a colour has been picked.
   *
   * This used to force it to 0 unless `theme.surface` was set, on the reasoning
   * that no pick means the designed palette and the designed palette is not
   * washed. That held while every surface was a mix into a grey anchor. It does
   * not hold now: base *is* pick + strength + softness, so zeroing the wash
   * makes the strength control inert - clicking a stop repaints nothing until a
   * colour happens to be chosen, which is exactly how it presented.
   *
   * `surface` already falls back to `DEFAULT_ACCENT` on the line above, so the
   * wash has something real to apply to either way.
   */
  const wash = normalizeWash(theme.wash ?? DEFAULT_WASH);
  const accent = resolvedInteractiveAccent(theme);
  const brightness = Math.min(
    Math.max(theme.textBrightness || 0, BRIGHTNESS_STOPS[0]),
    BRIGHTNESS_STOPS[BRIGHTNESS_STOPS.length - 1],
  );

  setToken(root, "--az-surface", surface);
  setToken(root, "--color-primary", accent);
  setToken(root, "--color-accent", accent);
  setToken(root, "--az-wash", `${wash}%`);
  /*
   * What sits *on* the accent. A picked colour can be anything from near-black
   * to near-white, so the label has to be chosen against it rather than left at
   * the palette's dark ink — otherwise the send button's text disappears the
   * moment someone picks a dark blue.
   */
  const ink = readableInk(accent);
  setToken(root, "--color-primary-content", ink);
  setToken(root, "--color-accent-content", ink);

  /*
   * The accent as *text*, which is a different colour from the accent as fill.
   *
   * `text-primary` on `bg-primary/8` is an accent chip, and it is the shape
   * that fails: both sides resolve to the same hue, so a dark accent gives a
   * contrast ratio of 1.00 and the label disappears into its own background.
   * Measured through the renderer's computed styles at accent `#662d21`: four
   * elements at exactly 1.00 and 97 under 3.0.
   *
   * Only lightness moves and only as far as the 4.5 floor demands, so a picked
   * accent still reads as the colour that was picked.
   */
  const mode = root.dataset.colorMode === "light" ? "light" : "dark";
  const accentText = legibleAccent(accent, mode);
  setToken(root, "--color-primary-text", accentText);

  /*
   * The accent Tailwind's own utilities read, lifted at the source.
   *
   * A rule of ours cannot win this: `text-primary`, `text-primary/70` and the
   * hover variants are generated into a later layer, so an app-authored
   * override loses however it is spelled - measured, after trying exactly
   * that: eight selectors still painting the raw accent and 195 elements at
   * contrast ratios between 1.00 and 2.58.
   *
   * `--color-primary` and `--color-accent` are what those utilities resolve,
   * so the lift goes there and every spelling inherits it, alpha variants
   * included. The *fill* keeps the picked colour through `--color-primary-fill`,
   * which is what `bg-primary`, the borders and the rings are pointed at, so
   * this only changes the accent where it is being read.
   */
  setToken(root, "--color-primary-fill", accent);

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
  const accentTwoChosen = isAccent(theme.accentTwo ?? "");
  /*
   * The artwork accent never derives from the control accent.
   *
   * It used to fall back to `accent`, and `svg:not(.az-icon-inherit)` colours
   * every icon from `--color-accent-2`, so picking a control colour repainted
   * every icon in the window including the gear in the title bar. That is the
   * coupling the two accents exist to prevent, so there is no fallback: unset
   * means the token is cleared and icons keep the colour the stylesheet gives
   * them.
   */
  const accentTwo = accentTwoChosen ? theme.accentTwo!.trim() : "";
  if (accentTwoChosen) {
    repaintIconStrokes(root, accentTwo);
    setToken(root, "--color-accent-2", accentTwo);
    setToken(root, "--color-accent-2-content", readableInk(accentTwo));
  } else {
    // Cleared, not set to a substitute. The stylesheet's own fallback then
    // decides what an icon looks like without a second accent.
    root.style.removeProperty("--color-accent-2");
    root.style.removeProperty("--color-accent-2-content");
  }

  setToken(root, "--az-lift", `${softness}%`);
  /*
   * Damp is what softness takes off the text; brightness gives it back, and may
   * overshoot into negative damp — that is the point, since the complaint that
   * produced this axis was prose reading washed out at the *designed* palette,
   * before any softness was applied at all.
   */
  setToken(root, "--az-damp", `${(softness * DAMP_RATIO - brightness).toFixed(2)}%`);

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

/** Resolve native window chrome without touching a document. */
export function windowChromeForTheme(theme: ThemeSettings): ReturnType<typeof windowChrome> {
  return windowChrome(resolvedInteractiveAccent(theme), theme);
}

function resolvedInteractiveAccent(theme: ThemeSettings): string {
  if (isAccent(theme.accent)) return theme.accent.trim();
  const softness = Math.min(Math.max(theme.softness || 0, 0), MAX_SOFTNESS);
  return defaultAccent(normalizeWash(theme.wash ?? DEFAULT_WASH), softness);
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

  /*
   * Drop the backdrop pass entirely when no blur was asked for.
   *
   * A `backdrop-filter` cuts the frame: the renderer stops, rasterises what has
   * been drawn, copies it into an atlas, blurs it and draws the full-frame
   * result back, blocking the UI thread on the GPU while it does. At a blur of
   * zero that whole pass changes no pixel, and the saturation and brightness
   * legs both sit at identity, so it is pure cost.
   *
   * Read from the resolved tuning rather than the raw setting, so it follows
   * whatever the axis actually clamped to.
   */
  const tuning = glassTuning(theme, root);
  root.classList.toggle("az-no-blur", !(tuning.blur > 0));

  if (Number.isFinite(opacity)) {
    setToken(root, "--glass-background-opacity", `${Number(opacity)}%`);

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
    setToken(root, "--glass-control-opacity", `${Math.round(100 - (100 - film) * 0.33)}%`);

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
    setToken(root, "--az-glass-alpha", `${Math.round(solid)}%`);
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
    setToken(root, "--az-glass-scrim-opacity", `${Number(scrim)}%`);
    /*
     * The film colour with the scrim already mixed in.
     *
     * Written here rather than composed in CSS. Nesting a `color-mix` inside
     * the `rgb(from …)` that carries the alpha made Lightning CSS split the
     * declaration and emit `rgb(0 0 0 / …)` as the fallback, which is a plain
     * black panel. One variable is a value no minifier rewrites.
     */
    /*
     * Filmed over the base colour, not over the chip.
     *
     * `--color-az-badge` is the topmost offset, so filming with it painted a
     * raised-chip tone across whole panel bodies and pulled the largest
     * surfaces in Settings out of the theme. Measured on the running app the
     * settings body came back `#1e2622` against a `#0d170a` desk.
     *
     * Only the colour changes here: the scrim mix is untouched.
     */
    setToken(
      root,
      "--az-glass-film",
      `color-mix(in oklab, black ${Number(scrim)}%, var(--az-base))`,
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
export function glassTuning(theme: ThemeSettings, root?: HTMLElement): GlassTuning {
  const mode: GlassMode = root?.dataset.colorMode === "light" ? "light" : "dark";
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

/**
 * How much a glass surface darkens what it sits over, as a percentage.
 *
 * Zero by default: the scrim exists for a busy backdrop, and adding one to a
 * quiet desk only makes the panel muddier than the design asks for.
 */

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
 * Paint a picked accent immediately, ahead of the store write.
 *
 * The same trade `writePanelAxes` makes for a dragging slider, for the colour
 * wheel and the accent rows. `onPick` goes to `saveSettings`, so the colour only
 * appears once a settings round trip has returned, and picking quickly queues
 * one round trip per pick behind the event loop.
 *
 * Measured on the stall frames: `max_interval_ms` reached 70 to 92 while
 * `paint_avg_ms` and `renderer_avg_ms` were both **0.00** for the same frames.
 * The renderer did no work at all, so the delay was never drawing: it was the
 * event loop waiting on the write. Reducing renderer work cannot reach that,
 * which is why an earlier attempt at this through the icon walk did not move it.
 *
 * Writing the tokens costs one style invalidation, so the pick lands on the next
 * frame and the persist settles behind it. `applyTheme` writes exactly these
 * same properties when the round trip returns, so the two agree by construction
 * rather than by being kept in step.
 *
 * Which accent is being picked matters: the artwork accent has to follow the
 * first one when it is not set independently, which is the rule `applyTheme`
 * applies, so it is repeated here rather than inferred.
 */
export function writeAccentPreview(
  accent: string,
  options: { accentTwo?: string; root?: HTMLElement } = {},
): void {
  const target = options.root ?? document.documentElement;
  /*
   * The two accents are written independently.
   *
   * This used to bail on the whole function when `accent` was not a hex colour,
   * so picking a second accent while no control accent had been chosen - the
   * picker passes `props.theme.accent`, which is empty until someone picks one
   * - silently did nothing, and the icons kept their old colour. That is the
   * "accent 2 sometimes gets dropped" report: it depended entirely on whether
   * accent 1 happened to be set.
   */
  if (isAccent(accent)) {
    const picked = accent.trim();
    setToken(target as HTMLElement, "--color-primary-fill", picked);
    setToken(target as HTMLElement, "--color-primary-content", readableInk(picked));
    setToken(target as HTMLElement, "--color-accent-content", readableInk(picked));
  }

  const twoChosen = isAccent(options.accentTwo ?? "");
  // No fallback to the control accent: artwork is its own axis, and mirroring
  // accent 1 here is what repainted every icon when a control colour was picked.
  const two = twoChosen ? options.accentTwo!.trim() : "";
  if (twoChosen) {
    setToken(target as HTMLElement, "--color-accent-2", two);
    setToken(target as HTMLElement, "--color-accent-2-content", readableInk(two));
  } else {
    (target as HTMLElement).style.removeProperty("--color-accent-2");
    (target as HTMLElement).style.removeProperty("--color-accent-2-content");
  }
  /*
   * The icons too, because the token alone does not reach them.
   *
   * This call was removed once, to fix a startup hang, on the reasoning that
   * `applyTheme` would restroke the mounted icons a moment later anyway. That
   * was wrong in the way that matters: picking a second accent updated the
   * tokens and left every icon already on screen at its old colour, which is
   * the whole feature. `iconAccent.test.ts` covers it now, by reading the
   * attribute back off a mounted element rather than asking the token.
   *
   * The hang was the traversal being unscoped, not the call. `repaintIconStrokes`
   * walked the entire document regardless of the root it was given, so a preview
   * from the settings pane cost a walk of the whole application while the tree
   * was still being built. It honours the argument now, so this pays only for
   * the subtree it was handed.
   */
  // Only when a second accent was actually chosen. The fallback to the first
  // accent above is for the token; feeding it to the walk let accent 1 restroke
  // every icon, which is what "separate from the control accent" rules out.
  if (twoChosen) repaintIconStrokes(target as HTMLElement, two);
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
  setToken(target as HTMLElement, PANEL_AXES.lift, `${values.lift}%`);
  setToken(target as HTMLElement, PANEL_AXES.border, `${values.border}%`);
  setToken(target as HTMLElement, PANEL_AXES.shadow, `${values.shadow}`);
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
   * Zero must still be sent as an explicit tint. `NSGlassEffectView` does not
   * interpret a missing tint as transparent; it falls back to the system glass
   * tint, which can be the application's accent. Omitting the tuple therefore
   * paints the strongest unintended colour at the exact setting named 0%.
   */
  const filmOpacity = Number.isFinite(theme.glassOpacity)
    ? Number(theme.glassOpacity)
    : DEFAULT_GLASS_OPACITY;
  const tintAlpha = Math.round((Math.min(Math.max(filmOpacity, 0), 100) / 100) * 255);
  /*
   * Every shipped profile inherits the transparent base window. Attaching this
   * view to an opaque profile washes a dark theme white at opacity zero, so the
   * config-stack test guards the native precondition alongside this calculation.
   */
  if (!rgb || !WINDOW_GLASS_ENABLED) return { enabled: false };
  return {
    tint: [rgb[0], rgb[1], rgb[2], tintAlpha],
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
/**
 * Relative luminance of a `#rgb` or `#rrggbb` colour, 0 to 1.
 *
 * Shared by the two directions this file needs: the ink that sits *on* the
 * accent, and the accent lifted so it stays legible *against the desk*.
 */
function luminanceOf(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const channel = (at: number) => {
    const srgb = Number.parseInt(full.slice(at, at + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * The accent, lifted until text painted in it can be read on this app's desk.
 *
 * `text-primary` on `bg-primary/8` is a real and reasonable pattern - an accent
 * chip - and it is exactly the shape that fails: both sides are the same
 * colour, so a dark accent gives text and background an identical hue at a
 * contrast ratio of 1.00. Measured through the renderer's own computed styles
 * rather than inferred: at accent `#662d21` the four worst elements in the
 * window scored exactly 1.00, and 97 scored under 3.0.
 *
 * This is not the ink that sits on a filled accent surface - `readableInk` is
 * that, and it runs the other way. This is the accent *as text*, which has to
 * clear the desk behind it whatever the picker was set to.
 *
 * Lifted rather than replaced, so a chosen accent still reads as itself: the
 * hue is kept and only lightness moves, and only as far as the floor requires.
 */
function legibleAccent(hex: string, mode: "light" | "dark"): string {
  const value = hex.trim();
  if (!isAccent(value)) return value;

  // The desk each mode actually paints, from `theme.css`'s own base-200 rung.
  const deskLuminance = mode === "light" ? 0.86 : 0.02;
  const contrast = (luminance: number) => {
    const [hi, lo] =
      luminance > deskLuminance ? [luminance, deskLuminance] : [deskLuminance, luminance];
    return (hi + 0.05) / (lo + 0.05);
  };

  if (contrast(luminanceOf(value)) >= 4.5) return value;

  const { h, s } = toColorValue(value).hsl;
  // Walk lightness toward the readable side in one-point steps and stop at the
  // first that clears the floor, so the result is the smallest change that
  // works rather than a fixed lightness that discards the picked colour.
  const towardLight = mode === "dark";
  for (let step = 1; step <= 100; step += 1) {
    const l = towardLight
      ? Math.min(100, toColorValue(value).hsl.l + step)
      : Math.max(0, toColorValue(value).hsl.l - step);
    const candidate = hslToHex(h, s, l);
    if (contrast(luminanceOf(candidate)) >= 4.5) return candidate;
    if (l === 0 || l === 100) break;
  }
  return towardLight ? hslToHex(h, s, 100) : hslToHex(h, s, 0);
}

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
