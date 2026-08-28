/**
 * A signal written from a raw DOM listener needs an explicit flush.
 *
 * Every dismiss-on-outside-click in the component library is written the same
 * way: the overlay adds a `pointerdown` listener to `document` and calls its own
 * `setOpen(false)` from inside it. That callback is invoked straight from the
 * renderer's event dispatch, not through the framework's delegation, so it runs
 * outside any reactive owner - and under Solid 2 a setter called there is
 * dropped silently. No error, nothing in the console, and the signal still reads
 * its old value on the next line.
 *
 * The overlay decides to close and then does not. The trigger's own `onClick`
 * goes through delegation and toggles correctly, which is what made this look
 * like an overlay defect rather than a scheduling one: opening a second pill
 * left the first open, two semi-transparent panels painting at once, reported as
 * a shadow stacking up on the composer. Menu items went 0, 5, 11 across two
 * pills with nothing closing.
 *
 * This pins the behaviour both ways, because the fix in `@pathscale/ui` depends
 * on it: the bare write does not land, and `flush()` makes it land. If a future
 * Solid makes the bare write work, the first case fails and the extra `flush`
 * can be dropped; if `flush` stops working the second fails and the dismiss is
 * broken again.
 */

import { createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

describe("a signal written from a raw DOM listener", () => {
  it("does not land on its own, which is why the dismiss guard needs a flush", () => {
    const [open, setOpen] = createSignal(true);
    const target = document.createElement("button");
    document.body.append(target);

    // Registered exactly as the library registers its dismiss guard.
    const guard = () => setOpen(false);
    document.addEventListener("pointerdown", guard);
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(
      open(),
      "the bare write landed after all - Solid no longer needs the flush in " +
        "Dropdown's dismiss guard, and it can be removed",
    ).toBe(true);

    document.removeEventListener("pointerdown", guard);
    target.remove();
  });

  it("lands once flushed, which is what makes an open overlay close", () => {
    const [open, setOpen] = createSignal(true);
    const target = document.createElement("button");
    document.body.append(target);

    const guard = () => {
      setOpen(false);
      flush();
    };
    document.addEventListener("pointerdown", guard);
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(
      open(),
      "the write still did not land after flush(); an overlay closing itself " +
        "from a document listener would stay open",
    ).toBe(false);

    document.removeEventListener("pointerdown", guard);
    target.remove();
  });
});
