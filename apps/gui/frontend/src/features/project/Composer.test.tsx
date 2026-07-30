import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "~/features/project/Composer";
import { WorkspaceProvider } from "~/stores/workspace";

function mount(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn().mockResolvedValue(undefined);
  // Wrapped since the Attach button made the composer a workspace consumer
  // (isLive gating and the picker action come from context).
  const screen = render(() => (
    <WorkspaceProvider>
      <Composer
        placeholder="Ask, or type / for commands…"
        model="sonnet"
        modelOptions={[
          { value: "sonnet", label: "Sonnet" },
          { value: "opus", label: "Opus" },
        ]}
        efforts={[]}
        effort=""
        permission="read_only"
        onModelChange={() => {}}
        onPermissionChange={() => {}}
        onSend={onSend}
        {...overrides}
      />
    </WorkspaceProvider>
  ));
  const field = screen.getByLabelText("Ask, or type / for commands…") as HTMLTextAreaElement;
  return { ...screen, field, onSend };
}

function type(field: HTMLTextAreaElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Composer", () => {
  it("puts the cursor in the prompt when the tab opens", () => {
    const { field } = mount({ autofocus: true });
    expect(document.activeElement).toBe(field);
  });

  it("leaves focus alone when not asked for it", () => {
    const { field } = mount();
    expect(document.activeElement).not.toBe(field);
  });

  it("clears the prompt only after the send resolves", async () => {
    const { field, onSend } = mount();
    type(field, "Review the upgrade");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Review the upgrade"));
    await waitFor(() => expect(field.value).toBe(""));
  });

  /*
   * A prompt is often long and carefully written. Clearing on dispatch and
   * discovering the failure afterwards means it is already gone.
   */
  it("keeps the prompt and explains itself when the send fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("IPC unavailable"));
    const { field, findByRole } = mount({ onSend });
    type(field, "a long, carefully written prompt");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(await findByRole("alert")).toHaveTextContent("IPC unavailable");
    expect(field.value).toBe("a long, carefully written prompt");
  });

  it("does not send an empty prompt", () => {
    const { field, onSend } = mount();
    type(field, "   ");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("treats Shift+Enter as a newline rather than a send", () => {
    const { field, onSend } = mount();
    type(field, "first line");
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("refuses a second send while the first is still in flight", async () => {
    let release!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { field } = mount({ onSend });
    type(field, "once");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onSend).toHaveBeenCalledTimes(1);
    release();
  });
});

describe("the model pill", () => {
  it("offers what it was given", async () => {
    const { getByLabelText } = mount();
    expect(getByLabelText("Model")).toHaveTextContent("Sonnet");
  });

  /*
   * Settings is authoritative: a model it no longer offers must not appear here
   * either. The store moves a conflicting tab onto the new default when the
   * setting is saved, so the composer renders the list as given and adds
   * nothing of its own.
   */
  it("offers nothing beyond what it was given", async () => {
    const { getByLabelText } = mount({
      model: "sonnet",
      modelOptions: [{ value: "sonnet", label: "Sonnet" }],
    });
    const pill = getByLabelText("Model");
    expect(pill.textContent?.match(/Sonnet/g) ?? []).toHaveLength(1);
    expect(pill).not.toHaveTextContent("fable");
  });
});
