import { Switch } from "@pathscale/ui";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { SectionPanel } from "./Panel";

describe("SectionPanel", () => {
  it("isolates positioned controls inside the panel's overflow clip", () => {
    render(() => (
      <SectionPanel title="Items" isOpen={true} onToggle={() => {}}>
        <span>row</span>
      </SectionPanel>
    ));
    expect(screen.getByText("row").closest(".isolate")).not.toBeNull();
  });

  it("retains interactive content while collapsed and only changes visibility", () => {
    function Harness() {
      const [open, setOpen] = createSignal(false);
      return (
        <SectionPanel title="Settings" isOpen={open()} onToggle={() => setOpen((value) => !value)}>
          <Switch aria-label="Moderator" />
        </SectionPanel>
      );
    }

    const view = render(() => <Harness />);
    const control = view.container.querySelector<HTMLInputElement>('[data-slot="switch-input"]');
    if (!control) throw new Error("retained disclosure control was not mounted");
    const content = control.parentElement?.parentElement;
    if (!content) throw new Error("retained disclosure content has no wrapper");

    expect(content).toHaveClass("hidden");
    expect(content).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    flush();

    expect(view.container.querySelector('[data-slot="switch-input"]')).toBe(control);
    expect(content).not.toHaveClass("hidden");
    expect(content).not.toHaveAttribute("aria-hidden");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    flush();

    expect(view.container.querySelector('[data-slot="switch-input"]')).toBe(control);
    expect(content).toHaveClass("hidden");
  });
});
