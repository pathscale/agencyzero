import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { ItemMarker } from "~/components/StatusDot";

describe("ItemMarker", () => {
  it("uses an SVG circle for planning instead of a clipped CSS dashed border", () => {
    const { container } = render(() => <ItemMarker status="planning" />);

    expect(container.querySelector("svg use")).toHaveAttribute("href", "#i-circle-dashed");
    expect(container.querySelector("span")).not.toBeInTheDocument();
  });

  it("centres a shipped marker inside its status button", () => {
    const { container } = render(() => <ItemMarker status="shipped" />);
    const marker = container.querySelector("span");

    expect(marker).toHaveClass("size-2", "rounded-full", "bg-warning");
    expect(marker?.className).not.toContain("top-");
  });
});
