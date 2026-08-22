import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { IconSprite } from "~/components/IconSprite";
import { ProjectPanelToggle } from "~/features/project/ProjectTab";

describe("the project panel toggle", () => {
  it("grows only to the right of the conversation scrollbar", () => {
    const onToggle = vi.fn();
    const screen = render(() => (
      <>
        <IconSprite />
        <ProjectPanelToggle visible onToggle={onToggle} />
      </>
    ));
    const button = screen.getByLabelText("Hide the project sidebar");

    expect(button.classList).toContain("left-full");
    expect(button.classList).toContain("rounded-r-md");
    expect(button.classList).toContain("border-l-0");
    expect(button.classList).toContain("bg-az-chip-strong");
    expect(button.classList).toContain("text-primary");
    expect(button.classList).toContain("h-9");
    expect(button.classList).toContain("w-1.5");
    expect(button.querySelector("svg")?.classList).toContain("text-[10px]");
    expect(button.querySelector("svg")).toHaveAttribute("stroke-width", "3.5");
    expect(button.classList).not.toContain("rounded-r-full");
    expect(button.classList).not.toContain("shadow-[3px_0_8px_rgb(0_0_0_/_0.22)]");
    expect(button.className).not.toContain("-right-");
    // The chevron's own path, not a `<use>` naming it: the artwork is inline,
    // because a cross-tree reference resolved to nothing in the real renderer.
    expect(button.querySelector("svg path")).toBeInTheDocument();

    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("points left when the hidden sidebar can be restored", () => {
    const screen = render(() => (
      <>
        <IconSprite />
        <ProjectPanelToggle visible={false} onToggle={() => {}} />
      </>
    ));
    const button = screen.getByLabelText("Show the project sidebar");
    const icon = button.querySelector("svg");

    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(icon?.classList).toContain("rotate-180");
  });
});
