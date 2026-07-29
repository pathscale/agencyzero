import { type JSX, splitProps } from "solid-js";
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
  const [own, rest] = splitProps(props, ["name", "label", "class"]);

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: a <title> is rendered when `label` is given and the icon is aria-hidden otherwise; the rule reads attributes statically and cannot see that these are two branches of one decision.
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={own.class}
      role={own.label ? "img" : "presentation"}
      aria-hidden={own.label ? undefined : "true"}
      {...rest}
    >
      {own.label ? <title>{own.label}</title> : null}
      <use href={`#i-${own.name}`} />
    </svg>
  );
}

export default Icon;
