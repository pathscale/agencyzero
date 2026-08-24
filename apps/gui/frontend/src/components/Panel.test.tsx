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

  it("mounts interactive content only while expanded", () => {
    function Harness() {
      const [open, setOpen] = createSignal(false);
      return (
        <SectionPanel title="Settings" isOpen={open()} onToggle={() => setOpen((value) => !value)}>
          <Switch aria-label="Moderator" />
        </SectionPanel>
      );
    }

    const view = render(() => <Harness />);
    expect(view.container.querySelector('[data-slot="switch-input"]')).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Expand Settings" })[0]);
    flush();

    expect(view.container.querySelector('[data-slot="switch-input"]')).not.toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Collapse Settings" })[0]);
    flush();

    expect(view.container.querySelector('[data-slot="switch-input"]')).toBeNull();
  });
});
