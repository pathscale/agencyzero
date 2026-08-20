import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { iconStrokeColor } from "~/lib/theme";
import type { IconName } from "./IconSprite";

export type IconProps = Omit<JSX.SvgSVGAttributes<SVGSVGElement>, "children"> & {
  name: IconName;
  /** Accessible label. Omit for decoration — the icon is then hidden from AT. */
  label?: string;
};

/**
 * References a symbol from {@link IconSprite}.
 *
 * Sized in `em` and stroked with `currentColor`, so it takes its size and
 * colour from the surrounding text: `<span class="text-primary text-[14px]">`
 * styles the icon and the label together.
 */
export function Icon(props: IconProps): JSX.Element {
  // `omit` rather than `splitProps`, which Solid 2 drops: the half that was
  // read is just `props`, already fine-grained.
  const rest = omit(props, "name", "label", "class");

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
      stroke={
        // `class` is typed as Solid's ClassValue, so it is not necessarily a
        // string: only a string spelling of the opt-out can be read here.
        typeof props.class === "string" && props.class.includes("az-icon-inherit")
          ? "currentColor"
          : /*
             * The artwork token, not `currentColor`, when no accent has been
             * resolved yet.
             *
             * `currentColor` here is whatever the icon sits inside, and
             * `text-primary` marks every active tab and selected row, so on a
             * fresh load with no second accent picked the icon was *built* in
             * accent 1 and then restyled by CSS a moment later: the flash. It
             * stopped once a second accent existed only because there was then
             * a real colour to bake in.
             *
             * usvg resolves this at construction and cannot read custom
             * properties, so the fallback has to be a var() the DOM can compute
             * before serialising, which `--color-az-artwork` is.
             */
            (iconStrokeColor() ?? "var(--color-az-artwork)")
      }
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      role={props.label ? "img" : "presentation"}
      aria-hidden={props.label ? undefined : "true"}
      {...rest}
    >
      {props.label ? <title>{props.label}</title> : null}
      <use href={`#i-${props.name}`} />
    </svg>
  );
}

export default Icon;
