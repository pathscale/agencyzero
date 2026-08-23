import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { BootFailed, Booting } from "~/App";
import { IconSprite } from "~/components/IconSprite";

describe("startup", () => {
  it("shows a branded workspace splash while hydration is in progress", () => {
    const screen = render(() => (
      <>
        <IconSprite />
        <Booting />
      </>
    ));

    expect(screen.getByRole("status", { name: "Loading workspace…" })).toBeTruthy();
    expect(screen.getByText("AgencyZero")).toBeTruthy();
  });

  it("offers Settings as a recovery route when workspace boot fails", () => {
    const openSettings = vi.fn();
    const screen = render(() => (
      <BootFailed
        message="AgencyProxy unavailable"
        onRetry={() => {}}
        onOpenSettings={openSettings}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
