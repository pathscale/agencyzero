import { Button as UiButton } from "@pathscale/ui";
import type { ButtonProps as UiButtonProps } from "@pathscale/ui/components/button";
import { type JSX, splitProps } from "solid-js";

export type ButtonProps = UiButtonProps & {
  /** Compatibility with native call sites while they move to PathScale/UI. */
  disabled?: boolean;
};

/**
 * The application button boundary.
 *
 * PathScale/UI calls the disabled prop `isDisabled`, while existing application
 * controls used the native spelling. Keeping that translation here makes the
 * migration behavior-preserving and leaves PathScale/UI as the only button
 * implementation.
 */
export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["disabled", "isDisabled"]);
  return <UiButton {...rest} isDisabled={local.isDisabled ?? local.disabled} />;
}

export default Button;
