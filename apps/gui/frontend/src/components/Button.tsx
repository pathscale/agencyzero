import { Button as UiButton } from "@pathscale/ui";
import type { ButtonProps as UiButtonProps } from "@pathscale/ui/components/button";
import { type JSX, splitProps } from "solid-js";

export type ButtonProps = UiButtonProps & {
  /** Compatibility with native call sites while they move to PathScale/UI. */
  disabled?: boolean;
};

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
 * its disabled, pending, icon, and group behaviour. Classes supplied by the
 * caller come last, so they continue to own every intentional visual choice.
 */
const NEUTRAL_BUTTON = "az-ui-button-neutral";

/**
 * The application button boundary.
 *
 * PathScale/UI calls the disabled prop `isDisabled`, while existing application
 * controls used the native spelling. Keeping that translation here makes the
 * migration behavior-preserving and leaves PathScale/UI as the only button
 * implementation.
 */
export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "disabled",
    "isDisabled",
    "variant",
    "class",
    "className",
  ]);
  const classes = () =>
    [local.variant ? undefined : NEUTRAL_BUTTON, local.class, local.className]
      .filter(Boolean)
      .join(" ");

  return (
    <UiButton
      {...rest}
      variant={local.variant ?? "ghost"}
      class={classes()}
      isDisabled={local.isDisabled ?? local.disabled}
    />
  );
}

export default Button;
