import { InlineEdit } from "@pathscale/ui";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { Button } from "~/components/Button";

function Harness() {
  const [value, setValue] = createSignal("Alpha project");

  return (
    <>
      <InlineEdit
        value={value()}
        label="Rename project"
        trigger={<span>Pencil</span>}
        onCommit={vi.fn()}
      />
      <Button type="button" onClick={() => setValue("Beta project")}>
        Switch project
      </Button>
    </>
  );
}

describe("InlineEdit rendered integration", () => {
  it("closes when a reused owner supplies a different project value", async () => {
    const view = render(() => <Harness />);
    const root = view.container.querySelector<HTMLElement>("[data-slot='root']");
    expect(root).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Rename project" }));
    await waitFor(() => expect(root?.classList.contains("inline-edit--editing")).toBe(true));

    fireEvent.click(view.getByRole("button", { name: "Switch project" }));
    await waitFor(() => expect(root?.classList.contains("inline-edit--editing")).toBe(false));
  });

  it("closes through its owned pointer-away surface", async () => {
    const view = render(() => <Harness />);
    const root = view.container.querySelector<HTMLElement>("[data-slot='root']");
    expect(root).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Rename project" }));
    await waitFor(() => expect(root?.classList.contains("inline-edit--editing")).toBe(true));

    fireEvent.pointerDown(view.getByRole("button", { name: "Switch project" }));
    await waitFor(() => expect(root?.classList.contains("inline-edit--editing")).toBe(false));
  });
});
