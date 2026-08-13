/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";

const themeCss = readFileSync(join(process.cwd(), "src/styles/theme.css"), "utf8");

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

  it("keeps the compatibility reset below every caller utility", () => {
    expect(themeCss).toContain(":where(.button.az-ui-button-neutral)");
    expect(themeCss).not.toContain("\n  .button.az-ui-button-neutral {");
  });

  it("neutralizes transient PathScale pressed paint", () => {
    expect(themeCss).toContain(":where(.button.az-ui-button-neutral:active)");
    expect(themeCss).toContain(':where(.button.az-ui-button-neutral[data-pressed="true"])');
    expect(themeCss).toContain("transform: none");
  });

  it("does not override existing call-site hover paint", () => {
    expect(themeCss).not.toContain(".button.az-ui-button-neutral:hover");
    expect(themeCss).not.toContain('.button.az-ui-button-neutral[data-hovered="true"]');
    expect(themeCss).toContain("--button-bg-hover: transparent");
  });
});
