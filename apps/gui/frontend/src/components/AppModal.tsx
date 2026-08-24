import { Dialog, Popover, type PopoverAnchorRect } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

export type ModalAnchor = PopoverAnchorRect;

const panelStyle: JSX.CSSProperties = {
  padding: "0",
  "border-radius": "0",
  "background-color": "transparent",
  "box-shadow": "none",
};

/** Application styling around the shared anchored and modal primitives. */
export function AppModal(props: {
  labelledBy: string;
  onDismiss: () => void;
  anchor?: ModalAnchor | null;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Show
      when={props.anchor}
      fallback={
        <Dialog.Root open onOpenChange={(open) => !open && props.onDismiss()}>
          <Dialog.Content
            aria-labelledby={props.labelledBy}
            size="lg"
            class="max-w-none border-0 bg-transparent p-0 shadow-none"
            style={panelStyle}
          >
            {props.children}
          </Dialog.Content>
        </Dialog.Root>
      }
    >
      {(anchor) => (
        <Popover.Root
          open
          anchorRect={anchor()}
          placement="bottom"
          offset={6}
          onOpenChange={(open) => !open && props.onDismiss()}
        >
          <Popover.Content
            aria-labelledby={props.labelledBy}
            class="z-[100] max-w-none border-0 bg-transparent p-0 shadow-none"
            style={panelStyle}
          >
            {props.children}
          </Popover.Content>
        </Popover.Root>
      )}
    </Show>
  );
}
