import { InlineEdit } from "@pathscale/ui";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";

function Harness(props: { captureSetValue?: (setValue: (value: string) => void) => void }) {
  const [value, setValue] = createSignal("Alpha project");
  props.captureSetValue?.((nextValue) => setValue(nextValue));

  return (
    <InlineEdit
      value={value()}
      label="Rename project"
      trigger={<span>Pencil</span>}
      onCommit={vi.fn()}
    />
  );
}

describe("InlineEdit rendered integration", () => {
  it("closes when a reused owner supplies a different project value", async () => {
    let setValue!: (value: string) => void;
    const view = render(() => <Harness captureSetValue={(setter) => (setValue = setter)} />);
    const root = view.container.querySelector<HTMLElement>("[data-slot='root']");
    expect(root).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Rename project" }));
    await waitFor(() => expect(root?.classList.contains("inline-edit--editing")).toBe(true));

    setValue("Beta project");
    await waitFor(() => expect(root?.classList.contains("inline-edit--editing")).toBe(false));
  });

  it("closes through its owned pointer-away surface", async () => {
    const view = render(() => <Harness />);
    const root = view.container.querySelector<HTMLElement>("[data-slot='root']");
    expect(root).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Rename project" }));
    await waitFor(() => expect(root?.classList.contains("inline-edit--editing")).toBe(true));
    const dismiss = screen.getByRole("button", { name: "Finish editing" });

    fireEvent.pointerDown(dismiss);
    await waitFor(() => expect(root?.classList.contains("inline-edit--editing")).toBe(false));
  });
});
