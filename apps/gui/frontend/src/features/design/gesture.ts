/**
 * The drag gesture, from pointerdown in the palette to the drop.
 *
 * Pointer events, not HTML5 drag and drop. The app ships on Blitz, whose
 * `dragstart`/`dragover`/`drop` support is not something a core interaction
 * should rest on, and the pointer path is identical in the browser fixture
 * server and in the packaged app.
 *
 * The only DOM this file reads is "what is under the pointer, and what is
 * its box". Everything that decides where the drop lands is in `dnd.ts`,
 * which knows nothing about a document object.
 */

import type { Hit } from "./dnd";
import { resolveDrop } from "./dnd";
import { design } from "./store";

/** Under this much movement, a pointerdown was a click, not a drag. */
export const DRAG_THRESHOLD = 4;

/**
 * The design node under a point.
 *
 * `closest` on the hit element, never coordinates against a list of boxes:
 * a designed component's root element carries `data-design-id`, so the
 * nearest ancestor with one is the node the pointer is genuinely over, even
 * when the pointer landed on some inner span the component drew itself.
 */
export function hitAt(x: number, y: number): Hit | null {
  const element = window.document.elementFromPoint(x, y);
  const owner = element?.closest?.("[data-design-id]");
  if (!owner) return null;
  const id = owner.getAttribute("data-design-id");
  if (!id) return null;
  const rect = owner.getBoundingClientRect();
  return { id, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } };
}

function withinCanvas(canvas: HTMLElement | undefined, x: number, y: number): boolean {
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export type GestureHandle = {
  /** Feed a pointermove. Returns true once the gesture has become a drag. */
  move(x: number, y: number): boolean;
  /** Finish. Returns "drop" when a plan landed, "click" for an unmoved press. */
  end(): "drop" | "click" | "cancel";
  cancel(): void;
};

/**
 * Track one press.
 *
 * The caller has already told the store a drag has begun; this decides
 * whether the press ever earned that, and keeps the hover plan current.
 */
export function trackDrag(
  origin: { x: number; y: number },
  canvas: () => HTMLElement | undefined,
): GestureHandle {
  let moved = false;

  return {
    move(x, y) {
      if (!moved && Math.hypot(x - origin.x, y - origin.y) < DRAG_THRESHOLD) return false;
      moved = true;
      const source = design.dragging();
      if (!source) return true;
      if (!withinCanvas(canvas(), x, y)) {
        design.hover(null);
        return true;
      }
      design.hover(resolveDrop(design.document(), hitAt(x, y), { x, y }, source));
      return true;
    },
    end() {
      if (!moved) {
        design.cancelDrag();
        return "click";
      }
      const landed = design.dropPlan() !== null;
      design.endDrag();
      return landed ? "drop" : "cancel";
    },
    cancel() {
      design.cancelDrag();
    },
  };
}

/**
 * Attach one press to the window and run it to completion.
 *
 * Window-level rather than element-level, because a drag that leaves the
 * palette item, which is every drag, would otherwise stop receiving moves.
 * `onClick` is the caller's click-to-append path: an unmoved press is a
 * click, and the palette is fully usable with no dragging at all, which is
 * also what makes it drivable through the accessibility tree.
 */
export function beginPointerDrag(
  origin: { x: number; y: number },
  canvas: () => HTMLElement | undefined,
  onClick: () => void,
): void {
  const handle = trackDrag(origin, canvas);

  const move = (event: PointerEvent): void => {
    handle.move(event.clientX, event.clientY);
  };
  const finish = (): void => {
    detach();
    if (handle.end() === "click") onClick();
  };
  const abort = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    detach();
    handle.cancel();
  };
  function detach(): void {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("keydown", abort);
  }

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("keydown", abort);
}
