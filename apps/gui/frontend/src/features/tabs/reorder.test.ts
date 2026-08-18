import { createRoot, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createTabReorder } from "~/features/tabs/reorder";

/**
 * A strip of three pills, 100px wide each, laid out end to end from x=0.
 * Midpoints therefore sit at 50, 150 and 250.
 */
function fakeStrip(count = 3): HTMLElement {
  const children = Array.from({ length: count }, (_, index) => ({
    getBoundingClientRect: () => ({ left: index * 100, width: 100 }),
  }));
  return { children } as unknown as HTMLElement;
}

type FakeEvent = {
  event: PointerEvent;
  setPointerCapture: ReturnType<typeof vi.fn>;
  releasePointerCapture: ReturnType<typeof vi.fn>;
};

function fakeEvent(
  clientX: number,
  opts: { button?: number; onCloseButton?: boolean } = {},
): FakeEvent {
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  const currentTarget = { setPointerCapture, releasePointerCapture };
  const event = {
    button: opts.button ?? 0,
    clientX,
    pointerId: 1,
    currentTarget,
    // `data-no-drag` marks the close button, which must never start a drag.
    target: {
      closest: (selector: string) =>
        opts.onCloseButton && selector === "[data-no-drag]" ? {} : null,
    },
  };
  return { event: event as unknown as PointerEvent, setPointerCapture, releasePointerCapture };
}

function withReorder<T>(run: (ctx: ReturnType<typeof setup>) => T): T {
  return createRoot((dispose) => {
    const ctx = setup();
    const result = run(ctx);
    dispose();
    return result;
  });
}

function setup() {
  const onMove = vi.fn();
  const onCommit = vi.fn();
  return { onMove, onCommit, reorder: createTabReorder({ onMove, onCommit }) };
}

describe("createTabReorder", () => {
  /*
   * This is the regression that shipped: capturing the pointer on pointerdown
   * makes the browser retarget the following `click` to the capturing element,
   * so clicks never reached the button inside the pill and selecting a tab
   * stopped working. jsdom does not model that retargeting, so the invariant
   * itself is what gets asserted — capture must not be taken before a drag is
   * real.
   */
  it("does not capture the pointer on pointerdown, so a plain click still dispatches", () => {
    withReorder(({ reorder }) => {
      const down = fakeEvent(50);
      reorder.onPointerDown(down.event, "b", fakeStrip());

      expect(down.setPointerCapture).not.toHaveBeenCalled();
    });
  });

  it("captures once the drag threshold is crossed", () => {
    withReorder(({ reorder }) => {
      const down = fakeEvent(50);
      reorder.onPointerDown(down.event, "b", fakeStrip());

      const nudge = fakeEvent(53);
      reorder.onPointerMove(nudge.event);
      expect(nudge.setPointerCapture).not.toHaveBeenCalled();

      const drag = fakeEvent(160);
      reorder.onPointerMove(drag.event);
      expect(drag.setPointerCapture).toHaveBeenCalledWith(1);
    });
  });

  it("ignores movement under the threshold, so a click that wobbles stays a click", () => {
    withReorder(({ reorder, onMove, onCommit }) => {
      reorder.onPointerDown(fakeEvent(50).event, "b", fakeStrip());
      reorder.onPointerMove(fakeEvent(53).event);
      reorder.onPointerUp(fakeEvent(53).event);

      expect(onMove).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
    });
  });

  it("reports the index whose midpoint the pointer has passed", () => {
    withReorder(({ reorder, onMove }) => {
      reorder.onPointerDown(fakeEvent(50).event, "a", fakeStrip());

      reorder.onPointerMove(fakeEvent(160).event); // past the first midpoint (50)
      expect(onMove).toHaveBeenLastCalledWith("a", 2);

      reorder.onPointerMove(fakeEvent(260).event); // past all three
      expect(onMove).toHaveBeenLastCalledWith("a", 3);

      reorder.onPointerMove(fakeEvent(10).event); // before the first
      expect(onMove).toHaveBeenLastCalledWith("a", 0);
    });
  });

  it("commits exactly once, and only when something actually moved", () => {
    withReorder(({ reorder, onCommit }) => {
      reorder.onPointerDown(fakeEvent(50).event, "a", fakeStrip());
      reorder.onPointerMove(fakeEvent(160).event);
      reorder.onPointerMove(fakeEvent(260).event);
      reorder.onPointerUp(fakeEvent(260).event);

      expect(onCommit).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores a drag started on the close button", () => {
    withReorder(({ reorder, onMove }) => {
      reorder.onPointerDown(fakeEvent(50, { onCloseButton: true }).event, "b", fakeStrip());
      reorder.onPointerMove(fakeEvent(200).event);

      expect(onMove).not.toHaveBeenCalled();
    });
  });

  it("ignores anything but the left button", () => {
    withReorder(({ reorder, onMove }) => {
      reorder.onPointerDown(fakeEvent(50, { button: 2 }).event, "b", fakeStrip());
      reorder.onPointerMove(fakeEvent(200).event);

      expect(onMove).not.toHaveBeenCalled();
    });
  });

  it("survives a pointer-capture call that throws", () => {
    withReorder(({ reorder, onCommit }) => {
      reorder.onPointerDown(fakeEvent(50).event, "a", fakeStrip());

      const drag = fakeEvent(200);
      drag.setPointerCapture.mockImplementation(() => {
        throw new DOMException("no active pointer", "NotFoundError");
      });
      reorder.onPointerMove(drag.event);

      const up = fakeEvent(200);
      up.releasePointerCapture.mockImplementation(() => {
        throw new DOMException("not capturing", "NotFoundError");
      });
      reorder.onPointerUp(up.event);

      // A throw before the state reset would strand the drag and skip this.
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(reorder.isDragging("a")).toBe(false);
    });
  });

  it("tracks which tab is being dragged", () => {
    withReorder(({ reorder }) => {
      reorder.onPointerDown(fakeEvent(50).event, "a", fakeStrip());
      expect(reorder.isDragging("a")).toBe(false);

      reorder.onPointerMove(fakeEvent(200).event);
      flush();
      expect(reorder.isDragging("a")).toBe(true);
      expect(reorder.isDragging("b")).toBe(false);

      reorder.onPointerUp(fakeEvent(200).event);
      flush();
      expect(reorder.isDragging("a")).toBe(false);
    });
  });
});
