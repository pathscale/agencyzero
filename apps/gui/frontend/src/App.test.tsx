import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { Booting } from "~/App";
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
});
