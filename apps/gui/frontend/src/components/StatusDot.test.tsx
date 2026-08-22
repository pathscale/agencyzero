import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { ItemMarker } from "~/components/StatusDot";

describe("ItemMarker", () => {
  it("uses an SVG circle for planning instead of a clipped CSS dashed border", () => {
    const { container } = render(() => <ItemMarker status="planning" />);

    // The circle itself, not a `<use>` naming one. The artwork is inline now:
    // `blitz-dom` parses each `<svg>` from its own `outer_html`, so a reference
    // into the shared sprite resolved to nothing and drew a blank icon.
    expect(container.querySelector("svg circle")).toBeInTheDocument();
    expect(container.querySelector("span")).not.toBeInTheDocument();
  });

  it("centres a shipped marker inside its status button", () => {
    const { container } = render(() => <ItemMarker status="shipped" />);
    const marker = container.querySelector("span");

    expect(marker).toHaveClass("size-2", "rounded-full", "bg-warning");
    expect(marker?.className).not.toContain("top-");
  });
});
