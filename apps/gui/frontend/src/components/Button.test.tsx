/*
 * @vitest-environment node
 *
 * This file reads the repository with `node:fs` rather than rendering
 * anything. Under the suite's default jsdom environment those builtins are
 * externalised for the browser and the import fails outright with "No such
 * built-in module: node:". Vitest 4 removed `environmentMatchGlobs`, so the
 * environment is declared per file.
 */
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

  /*
   * Written first against `:where(.button.az-ui-button-neutral)`, which was
   * wrong in the one way that matters: `:where()` zeroes specificity, so the
   * library's own `.button` outranked the reset and kept its fill. That is what
   * sized section headers to a 40px control and put a blob around the chevron.
   *
   * The bare selector is therefore load-bearing, and these assert it stays bare.
   */
  it("keeps the compatibility reset above the library's own .button", () => {
    expect(themeCss).toContain(".button.az-ui-button-neutral {");
    expect(themeCss).not.toContain(":where(.button.az-ui-button-neutral)");
  });

  it("neutralizes transient PathScale pressed paint", () => {
    expect(themeCss).toContain(".button.az-ui-button-neutral:active");
    expect(themeCss).toContain('.button.az-ui-button-neutral[data-pressed="true"]');
    expect(themeCss).toContain("transform: none");
    expect(themeCss).not.toContain(":where(.button.az-ui-button-neutral:active)");
  });

  it("does not override existing call-site hover paint", () => {
    expect(themeCss).not.toContain(".button.az-ui-button-neutral:hover");
    expect(themeCss).not.toContain('.button.az-ui-button-neutral[data-hovered="true"]');
    expect(themeCss).toContain("--button-bg-hover: transparent");
  });
});
