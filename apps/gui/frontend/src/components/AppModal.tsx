import type { JSX } from "@solidjs/web";
import { onCleanup, onMount } from "solid-js";

/**
 * The viewport rect of the control that opened the dialog.
 *
 * The whole rect, not a point: which edges the panel hangs from is decided
 * from where the control sits in the window, and that needs both sides.
 */
export type ModalAnchor = { left: number; top: number; right: number; bottom: number };

/** Breathing room kept between the panel and the window edge. */
const MARGIN = 16;
/** Distance between the control and the panel it opens. */
const OFFSET = 6;

/**
 * Decide the four offsets that pin an anchored panel, without measuring it.
 *
 * A menu flips rather than slides: near the right edge it hangs from its own
 * right edge instead of its left, and near the bottom it opens upward. Because
 * the choice depends only on the anchor and the window, the panel is correct on
 * its first paint. Measuring it first would mean rendering it somewhere wrong,
 * or hiding it until a measurement arrives, and a measurement that comes back
 * as zeros — a retained view, a test renderer — then leaves a dialog that was
 * asked for but never shown.
 */
export function anchorPlacement(
  anchor: ModalAnchor,
  viewport: { width: number; height: number },
): JSX.CSSProperties {
  const style: JSX.CSSProperties = { position: "absolute" };

  // Plain pixels rather than `calc(100% - …)`: the viewport is already known
  // here, so the arithmetic can be done once instead of by whatever is
  // resolving the style. One renderer short of full `calc()` support in an
  // inline `max-width` is enough to lose the dialog.
  if (anchor.left <= viewport.width / 2) {
    const left = Math.max(MARGIN, Math.round(anchor.left));
    style.left = `${left}px`;
    style["max-width"] = `${Math.max(0, viewport.width - left - MARGIN)}px`;
  } else {
    const right = Math.max(MARGIN, Math.round(viewport.width - anchor.right));
    style.right = `${right}px`;
    style["max-width"] = `${Math.max(0, viewport.width - right - MARGIN)}px`;
  }

  if (anchor.bottom <= viewport.height / 2) {
    const top = Math.max(MARGIN, Math.round(anchor.bottom) + OFFSET);
    style.top = `${top}px`;
    style["max-height"] = `${Math.max(0, viewport.height - top - MARGIN)}px`;
  } else {
    const bottom = Math.max(MARGIN, Math.round(viewport.height - anchor.top) + OFFSET);
    style.bottom = `${bottom}px`;
    style["max-height"] = `${Math.max(0, viewport.height - bottom - MARGIN)}px`;
  }

  return style;
}

/**
 * Move a live Solid subtree under `body` without using a Portal.
 *
 * Retained views establish containing blocks, which otherwise trap a fixed
 * backdrop inside one cached panel. Moving the already-bound node preserves
 * Solid and Blitz listeners while giving every modal viewport geometry.
 *
 * With an `anchor` this is a popover rather than a modal: it opens beside the
 * control that summoned it and leaves the rest of the window undimmed. A
 * dialog raised from a small button in a dense list is about that one row, and
 * centring it makes the eye travel to the middle of the screen and back again
 * to see what changed.
 */
export function AppModal(props: {
  labelledBy: string;
  onDismiss: () => void;
  anchor?: ModalAnchor | null;
  children: JSX.Element;
}): JSX.Element {
  let root!: HTMLDivElement;
  onMount(() => document.body.append(root));
  onCleanup(() => root.remove());

  const placement = (): JSX.CSSProperties | undefined => {
    const anchor = props.anchor;
    if (!anchor) return undefined;
    return anchorPlacement(anchor, { width: window.innerWidth, height: window.innerHeight });
  };

  return (
    <div
      ref={root}
      role="dialog"
      // Anchored means a popover, not a modal: it belongs to the row it hangs
      // from, the rest of the list stays legible behind it, and dimming the
      // whole window for one row's description would overstate what is
      // happening. Unanchored dialogs are still modal.
      aria-modal={props.anchor ? undefined : "true"}
      aria-labelledby={props.labelledBy}
      /*
        A dialog sizes itself. `w-full` against a centering flex parent left
        the panel at its min-content width, which wrapped the description one
        word per line and pushed the buttons over the text, so children now
        carry an explicit width and this only positions them.

        The layer still covers the window when anchored, with no wash: it is
        what catches the click that dismisses the popover.
      */
      class={`fixed inset-0 z-50 flex items-center justify-center overflow-auto ${
        props.anchor ? "" : "bg-black/60 p-8"
      }`}
      onClick={(event) => event.currentTarget === event.target && props.onDismiss()}
      onKeyDown={(event) => event.key === "Escape" && props.onDismiss()}
    >
      <div class={props.anchor ? "flex" : "contents"} style={placement()}>
        {props.children}
      </div>
    </div>
  );
}
