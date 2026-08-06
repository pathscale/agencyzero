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
    expect(button.classList).toContain("bg-primary/14");
    expect(button.classList).toContain("text-primary");
    expect(button.classList).toContain("h-8");
    expect(button.classList).toContain("w-4");
    expect(button.classList).not.toContain("rounded-r-full");
    expect(button.classList).not.toContain("shadow-[3px_0_8px_rgb(0_0_0_/_0.22)]");
    expect(button.className).not.toContain("-right-");
    expect(button.querySelector("use")?.getAttribute("href")).toBe("#i-chevron-right");

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
