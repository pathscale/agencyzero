import { Button as UiButton } from "@pathscale/ui";
import type { ButtonProps as UiButtonProps } from "@pathscale/ui/components/button";
import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

export type ButtonProps = UiButtonProps;

/*
 * PathScale/UI intentionally gives an unconfigured Button a complete primary
 * treatment: 40px high, pill radius, accent fill, padding, centred flex
 * layout, and a pressed scale. AgencyZero's existing button call sites already
 * own their geometry and appearance through utility classes. Letting the UI
 * default leak through turns every previously neutral icon, disclosure, tab,
 * and row action into a large primary pill.
 *
 * This is the native-button-compatible baseline for call sites that do not ask
 * for a PathScale/UI variant. It remains a real PathScale/UI Button, including
 * its state, icon, and group behaviour. Classes supplied by the caller come
 * last, so they continue to own every intentional visual choice.
 */
const NEUTRAL_BUTTON = "az-ui-button-neutral";

/**
 * The application button boundary.
 *
 * All this does now is choose the default look. It used to translate the native
 * `disabled` attribute into `isDisabled`, because the library spelled the
 * condition as a prop of its own; 2.2 removed that prop in favour of `state`
 * and stopped omitting `disabled`, so the translation had nothing left to do
 * and the native spelling passes straight through.
 */
export function Button(props: ButtonProps): JSX.Element {
  // `omit` rather than `splitProps`, which Solid 2 drops: the half that was
  // read is just `props`, already fine-grained.
  const rest = omit(props, "variant", "class");
  const classes = () =>
    [props.variant ? undefined : NEUTRAL_BUTTON, props.class].filter(Boolean).join(" ");

  return <UiButton {...rest} variant={props.variant ?? "ghost"} class={classes()} />;
}

export default Button;
