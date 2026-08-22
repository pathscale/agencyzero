import { type JSX, Portal } from "@solidjs/web";

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
 * Build a dialog under `body`, where it is the same node that listens.
 *
 * Retained views establish containing blocks, which otherwise trap a fixed
 * backdrop inside one cached panel, so the dialog has to live under `body` to
 * get viewport geometry.
 *
 * It used to get there by `document.body.append(root)` from `onSettled`, on
 * the premise that moving an already-bound node keeps its listeners. Measured
 * against a running build, it does not. One press of Fork produced *two*
 * `role="dialog"` nodes: a painted 1344x900 one under body, and the
 * Solid-bound original left `HIDDEN` at 0x0 under its render site. Blitz
 * reallocates a slot when a node is re-parented, so the node that paints and
 * the node the handlers are bound to were different nodes. Pointer hits landed
 * on the copy and no handler ever ran - two Cancels, `Start fork` and Escape
 * all inert, with no JS error, which trapped the window and put 68 of the
 * project surface's 84 controls out of reach behind one dialog.
 *
 * `Portal` builds the subtree *at* the mount rather than moving it there, so
 * there is one node throughout, and it registers `body` as a delegated
 * container so Solid's delegated events still reach the app root. Removing the
 * re-parent without a portal was tried and reverted: the dialog then never
 * gets viewport geometry and stops opening at all.
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
  const placement = (): JSX.CSSProperties | undefined => {
    const anchor = props.anchor;
    if (!anchor) return undefined;
    return anchorPlacement(anchor, { width: window.innerWidth, height: window.innerHeight });
  };

  return (
    <Portal mount={document.body}>
      <div
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
        /*
        `isolation` and a z-index above the app, because `z-50` alone lost.

        This element is appended to `document.body`, so its stacking order is
        decided among body's children rather than against anything inside the
        app. `@pathscale/ui` gives every `.button` `isolation: isolate`, so each
        one is its own stacking context, and a control underneath the dialog
        could take the pointer at a coordinate the dialog was covering.

        This layer is still worth keeping, but note what it did *not* fix: the
        fork dialog's exits stayed dead after it, because the cause was the
        re-parent above rather than stacking. A control behind the dialog
        taking the pointer and the dialog's own node not being the painted one
        produce the same symptom, and only the second one was happening.

        A DOM-only test environment has no hit-testing, so it dispatches the
        click straight at the node it was handed and every one of these passes
        there. Neither fault is visible in jsdom.
      */
        style={{ isolation: "isolate" }}
        /*
        Focusable, or `onKeyDown` never runs.

        A plain `div` is not in the tab order, so it cannot take focus, so the
        Escape handler below had nothing to fire on: Escape was dead for every
        dialog in the app independently of the node-identity bug. `-1` keeps it
        out of the tab sequence while still allowing focus.
      */
        tabindex={-1}
        ref={(element: HTMLDivElement) => {
          // Focus the dialog itself so Escape works before the pointer has been
          // anywhere. Children that want focus take it after this.
          queueMicrotask(() => element.focus());
        }}
        class={`fixed inset-0 z-[100] flex items-center justify-center overflow-auto ${
          props.anchor ? "" : "bg-black/60 p-8"
        }`}
        onClick={(event) => event.currentTarget === event.target && props.onDismiss()}
        onKeyDown={(event) => event.key === "Escape" && props.onDismiss()}
      >
        <div class={props.anchor ? "flex" : "contents"} style={placement()}>
          {props.children}
        </div>
      </div>
    </Portal>
  );
}
