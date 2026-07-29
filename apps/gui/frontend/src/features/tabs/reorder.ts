import { createSignal } from "solid-js";

export type ReorderHandlers = {
  /** Live-move the tab as the pointer crosses a neighbour's midpoint. */
  onMove: (key: string, toIndex: number) => void;
  /** Fired once, when the drag ends and the order has actually changed. */
  onCommit: () => void;
};

/**
 * Drag-to-reorder for the tab strip, on pointer events.
 *
 * Not HTML5 drag-and-drop: Tauri's webview owns native drag for file drops, so
 * `dragstart`/`drop` inside the page are unreliable in the very window this has
 * to work in. Pointer capture is unaffected by that and gives the live swap the
 * strip wants anyway.
 *
 * Reordering happens as you drag rather than on release — the tab you are
 * holding is always where it would land, so there is no separate drop
 * indicator to keep truthful.
 */
export function createTabReorder(handlers: ReorderHandlers) {
  const [draggingKey, setDraggingKey] = createSignal<string | null>(null);

  let startX = 0;
  let armed = false;
  let moved = false;
  let key: string | null = null;
  let strip: HTMLElement | null = null;

  /**
   * Index the pointer is currently over, by counting the pill midpoints it has
   * passed. Measured live: the DOM reorders mid-drag, so a set of rects taken
   * at the start would be stale after the first swap.
   */
  function indexAt(clientX: number): number {
    if (!strip) return 0;
    const pills = [...strip.children] as HTMLElement[];
    let index = 0;
    for (const pill of pills) {
      const rect = pill.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) index++;
    }
    return index;
  }

  function onPointerDown(event: PointerEvent, tabKey: string, container: HTMLElement | null): void {
    // Left button only, and never on the close button inside the pill.
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-no-drag]")) return;

    key = tabKey;
    strip = container;
    startX = event.clientX;
    armed = true;
    moved = false;
    // Capture is taken on the first real move, not here — see onPointerMove.
  }

  function onPointerMove(event: PointerEvent): void {
    if (!armed || !key) return;

    // A 5px threshold, so a click that wobbles stays a click.
    if (!moved && Math.abs(event.clientX - startX) < 5) return;
    if (!moved) {
      moved = true;
      setDraggingKey(key);
      /*
       * Capture starts here rather than on pointerdown, and that placement is
       * load-bearing: while an element holds the pointer, the browser retargets
       * the following `click` to *it*. Capturing on pointerdown therefore sent
       * every click to this wrapper instead of the button inside it, and
       * selecting a tab by clicking stopped working entirely.
       *
       * Taking it only once a drag is real means a plain click never captures,
       * so it dispatches normally. The cost is that a flick fast enough to
       * leave the pill before its first pointermove lands does not start a
       * drag; in practice a move is delivered every frame.
       */
      capture(event, "set");
    }

    handlers.onMove(key, indexAt(event.clientX));
  }

  function onPointerUp(event: PointerEvent): void {
    if (!armed) return;
    armed = false;
    if (moved) capture(event, "release");

    const didMove = moved;
    key = null;
    strip = null;
    moved = false;
    setDraggingKey(null);

    // A finished drag deliberately does not select the tab it moved: you were
    // reordering, not choosing. The click that follows a captured drag is
    // retargeted to the wrapper, which has no handler, so this is also what
    // happens on its own — stating it here so it is a decision, not a
    // side effect of retargeting.
    if (didMove) handlers.onCommit();
  }

  /**
   * Pointer capture keeps `pointermove` coming even when the cursor leaves the
   * pill — which it does immediately, since the pill moves out from under it.
   *
   * Both calls throw `NotFoundError` for a pointer id the element does not
   * hold, and a throw here would strand the drag mid-flight: the state reset
   * and the commit both come after it. Capture is an optimisation on tracking,
   * never a precondition, so losing it is not worth taking the drag down with.
   */
  function capture(event: PointerEvent, mode: "set" | "release"): void {
    const el = event.currentTarget as HTMLElement | null;
    try {
      if (mode === "set") el?.setPointerCapture(event.pointerId);
      else el?.releasePointerCapture(event.pointerId);
    } catch {
      // Nothing to do: the drag reads pointer coordinates either way.
    }
  }

  /** True while this tab is the one being dragged, for the lifted styling. */
  const isDragging = (tabKey: string) => draggingKey() === tabKey;

  return { onPointerDown, onPointerMove, onPointerUp, isDragging };
}
