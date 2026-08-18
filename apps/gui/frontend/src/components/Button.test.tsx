import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("keeps existing call sites on the neutral AgencyZero visual baseline", () => {
    render(() => <Button class="size-[30px]">Settings</Button>);

    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.dataset.slot).toBe("button");
    expect(button.classList.contains("button")).toBe(true);
    expect(button.classList.contains("button--ghost")).toBe(true);
    expect(button.classList.contains("az-ui-button-neutral")).toBe(true);
    expect(button.classList.contains("size-[30px]")).toBe(true);
  });

  it("leaves an explicit PathScale UI variant intact", () => {
    render(() => <Button variant="outline">Review</Button>);

    const button = screen.getByRole("button", { name: "Review" });
    expect(button.classList.contains("button--outline")).toBe(true);
    expect(button.classList.contains("az-ui-button-neutral")).toBe(false);
  });

});
