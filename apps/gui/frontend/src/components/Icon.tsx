import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { ARTWORK_FALLBACK, iconStrokeColor } from "~/lib/theme";
import { ICON_ART, type IconName } from "./IconSprite";

export type IconProps = Omit<JSX.SvgSVGAttributes<SVGSVGElement>, "children"> & {
  name: IconName;
  /** Accessible label. Omit for decoration — the icon is then hidden from AT. */
  label?: string;
};

/**
 * One icon, with its artwork inlined from {@link ICON_ART}.
 *
 * Sized in `em` and stroked with `currentColor`, so it takes its size and
 * colour from the surrounding text: `<span class="text-primary text-[14px]">`
 * styles the icon and the label together.
 */
export function Icon(props: IconProps): JSX.Element {
  // `omit` rather than `splitProps`, which Solid 2 drops: the half that was
  // read is just `props`, already fine-grained.
  const rest = omit(props, "name", "label", "class");

  /**
   * The colour this icon draws with, as a literal usvg can read.
   *
   * Never a `var()`: `blitz-dom` serialises the element and hands the string to
   * usvg, which has no stylesheet and no custom properties. Given
   * `stroke="var(--anything)"` usvg does not fall back, it drops the paint, and
   * a shape with neither stroke nor fill draws nothing at all. The fallback
   * here named `--color-az-artwork`, a token defined nowhere in the app, so
   * every icon that mounted before the theme resolved was blank.
   *
   * Not `currentColor` by default either: `text-primary` marks every active tab
   * and selected row, so an icon would be *built* in accent 1 and restyled a
   * moment later, which is the flash this exists to prevent. `az-icon-inherit`
   * opts back into the cascade for icons that sit inside a label and have to
   * match the text beside them.
   */
  const paint = (): string =>
    // `class` is typed as Solid's ClassValue, so it is not necessarily a
    // string: only a string spelling of the opt-out can be read here.
    typeof props.class === "string" && props.class.includes("az-icon-inherit")
      ? "currentColor"
      : (iconStrokeColor() ?? ARTWORK_FALLBACK);

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: a <title> is rendered when `label` is given and the icon is aria-hidden otherwise; the rule reads attributes statically and cannot see that these are two branches of one decision.
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      /*
       * The artwork accent, resolved, rather than `currentColor`.
       *
       * usvg has no stylesheet: `blitz-dom` serialises this element and
       * substitutes the computed `currentColor` at construction time, so the
       * colour is baked into the parsed tree. Writing a custom property on the
       * root restyles without producing construction damage, so the tree is
       * never rebuilt and the icon keeps the colour it first had.
       *
       * Reading the signal here means an icon takes the current accent as it
       * renders, which is what fixes the chrome that mounts after a pick.
       * Before a theme is applied there is nothing to say, and `currentColor`
       * is the right answer.
       *
       * `az-icon-inherit` opts back out, for the icons that are part of a label
       * and have to match the text beside them. Those follow the cascade, which
       * is what `currentColor` asks for. An icon inside a filled control is
       * handled the same way by `theme.css`, and a caller that passes its own
       * `stroke` still wins because `rest` spreads after this.
       */
      stroke={paint()}
      /*
       * The same paint as `color`, for the shapes that fill rather than stroke.
       *
       * Seven of the icons draw with `fill="currentColor" stroke="none"` - the
       * ellipsis dots, the pin's head, the vendor marks. `currentColor` inside
       * the serialised SVG resolves against that document's own `color`
       * property, not against `stroke`, and usvg's default `color` is **black**.
       * With no `color` here those shapes filled black on a dark surface and
       * were invisible, which is why some icons stayed blank after the stroke
       * was fixed. Proven against usvg 0.48:
       *
       *     no color attr   -> fill=Color(0, 0, 0)
       *     color="#8fb8e8" -> fill=Color(143, 184, 232)
       */
      color={paint()}
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      role={props.label ? "img" : "presentation"}
      aria-hidden={props.label ? undefined : "true"}
      {...rest}
    >
      {props.label ? <title>{props.label}</title> : null}
      {/*
        The artwork inline, not `<use href="#i-name">`.

        `blitz-dom` parses each inline `<svg>` into its own `usvg::Tree` from
        that element's `outer_html` alone, so a `<use>` pointing at a `<symbol>`
        in the hidden sprite arrived at the rasteriser as a reference to
        something outside its tree. usvg resolved it to nothing: every icon had
        the right box and the right stroke and drew no artwork at all.
      */}
      {ICON_ART[props.name]}
    </svg>
  );
}

export default Icon;
