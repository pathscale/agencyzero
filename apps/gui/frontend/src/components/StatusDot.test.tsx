import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { ItemMarker } from "~/components/StatusDot";

describe("ItemMarker", () => {
  it("centres a shipped marker inside its status button", () => {
    const { container } = render(() => <ItemMarker status="shipped" />);
    const marker = container.querySelector("span");

    expect(marker).toHaveClass("size-2", "rounded-full", "bg-warning");
    expect(marker?.className).not.toContain("top-");
  });
});
