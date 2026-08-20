/**
 * Every value a theme starts from, in one file.
 *
 * A theme is twelve numbers and colours. Everything else in the app - sixteen
 * surface tokens, seven text rungs, the accent harmonies, the glass film - is
 * derived from these by `lib/theme.ts` and `styles/theme.css`. Nothing here is
 * computed from anything else here, so a generator can emit this file and get a
 * complete theme.
 *
 * These were previously spread across nine `export const`s in a 900-line
 * `theme.ts`, a `:root` block in `theme.css`, and `stores/prefs.ts`, which is
 * how the same idea ended up with three spellings and why "the designed accent"
 * and "nothing picked" collided on the empty string.
 *
 * The rule: if a value can be worked out from another value, it does not belong
 * here. If a designer would want to change it, it does.
 */

/** The workspace colour a fresh install starts on. */
export const DEFAULT_SURFACE = "#103860";

/** The control accent: buttons, focus rings, active tabs. */
export const DEFAULT_ACCENT = "#d2ad3f";

/**
 * The artwork accent: icons and drawn shapes.
 *
 * Separate from the control accent on purpose. Icons stroke with
 * `currentColor`, and `text-primary` marks every active tab and selected row,
 * so a shared value repaints every icon in the window whenever a control colour
 * is picked.
 */
export const DEFAULT_ACCENT_TWO = "#8fb8e8";

/** How far the picked colour reaches into the surfaces, as a percentage. */
export const DEFAULT_WASH = 30;

/** The stops the strength control offers. */
export const WASH_STOPS = [10, 20, 30, 40, 50] as const;

/** How far surfaces lift off the near-black floor, in oklch points. */
export const DEFAULT_SOFTNESS = 0;

/**
 * The ceiling for that lift.
 *
 * 12 lands the desk near 22%: dark, but off the floor that makes bright text
 * glare. Past that the surface ladder starts colliding with the text ladder.
 */
export const MAX_SOFTNESS = 12;

/** How far text rises off the surface it sits on. */
export const DEFAULT_TEXT_BRIGHTNESS = 0;

/** The stops the text-brightness control offers. */
export const BRIGHTNESS_STOPS = [-4, -2, 0, 3, 6] as const;

/** How opaque a glass surface is, as a percentage. */
export const DEFAULT_GLASS_OPACITY = 55;

/** How far a panel smears what is behind it, in pixels. */
export const DEFAULT_GLASS_BLUR = 12;

/** The ceiling for that blur, past which the cost stops buying anything. */
export const MAX_GLASS_BLUR = 24;

/** How much a glass surface darkens its own film, as a percentage. */
export const DEFAULT_GLASS_SCRIM = 0;

/** Where the glass slider starts when it is switched on. */
export const DEFAULT_GLASS = 45;
