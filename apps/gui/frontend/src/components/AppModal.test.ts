import { describe, expect, it } from "vitest";
import { anchorPlacement } from "~/components/AppModal";

const VIEWPORT = { width: 1440, height: 900 };

describe("an anchored popover", () => {
  it("hangs from the control's left edge and opens downward with room to spare", () => {
    const style = anchorPlacement({ left: 200, top: 100, right: 222, bottom: 122 }, VIEWPORT);

    expect(style.left).toBe("200px");
    expect(style.top).toBe("128px");
    expect(style.right).toBeUndefined();
    expect(style.bottom).toBeUndefined();
  });

  it("flips to the control's right edge rather than running off the window", () => {
    // The case this exists for: an action column pinned to the right of a list.
    // Left-aligning a 560px panel there would put most of it off-screen.
    const style = anchorPlacement({ left: 1378, top: 170, right: 1400, bottom: 192 }, VIEWPORT);

    expect(style.right).toBe("40px");
    expect(style.left).toBeUndefined();
    expect(style.top).toBe("198px");
  });

  it("opens upward from a control in the lower half", () => {
    const style = anchorPlacement({ left: 100, top: 800, right: 122, bottom: 822 }, VIEWPORT);

    expect(style.bottom).toBe("106px");
    expect(style.top).toBeUndefined();
  });

  it("bounds the panel to the space it was given, in plain pixels", () => {
    const style = anchorPlacement({ left: 200, top: 100, right: 222, bottom: 122 }, VIEWPORT);

    // Not `calc()`: an inline `calc()` in these two properties is one renderer
    // gap away from losing the dialog entirely, and the viewport is known here.
    expect(style["max-width"]).toBe("1224px");
    expect(style["max-height"]).toBe("756px");
  });

  it("never places a panel outside the margin, however odd the anchor", () => {
    const style = anchorPlacement({ left: -50, top: -50, right: -28, bottom: -28 }, VIEWPORT);

    expect(style.left).toBe("16px");
    expect(style.top).toBe("16px");
  });
});
