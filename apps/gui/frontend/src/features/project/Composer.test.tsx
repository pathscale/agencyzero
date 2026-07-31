import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "~/features/project/Composer";
import { prefs, setPrefs } from "~/stores/prefs";
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

/*
 * Tabs unmount: `App.tsx` renders one `Match` at a time, so leaving a project
 * destroys its composer. A reply typed and not sent used to die with it — the
 * owner lost one mid-sentence and reported it as text vanishing on tab-away.
 */
describe("an unsent draft", () => {
  beforeEach(() => {
    setPrefs("composerDrafts", {});
  });

  it("survives the screen being unmounted and mounted again", async () => {
    const first = mount({ draftKey: "project:abc" });
    fireEvent.input(first.field, { target: { value: "half a thought" } });
    await waitFor(() => expect(prefs.composerDrafts["project:abc"]).toBe("half a thought"));
    first.unmount();

    const second = mount({ draftKey: "project:abc" });
    expect(second.field.value).toBe("half a thought");
  });

  /* Drafts are per tab: typing in one project must not leak into the next. */
  it("is kept per tab rather than shared", async () => {
    const first = mount({ draftKey: "project:abc" });
    fireEvent.input(first.field, { target: { value: "for abc" } });
    await waitFor(() => expect(prefs.composerDrafts["project:abc"]).toBe("for abc"));
    first.unmount();

    const other = mount({ draftKey: "project:xyz" });
    expect(other.field.value).toBe("");
  });

  /* Sending is the one thing that clears it — otherwise the message someone
   * just sent would reappear in the box on the next visit. */
  it("is cleared once the message goes", async () => {
    const screen = mount({ draftKey: "project:abc" });
    fireEvent.input(screen.field, { target: { value: "ship it" } });
    await waitFor(() => expect(prefs.composerDrafts["project:abc"]).toBe("ship it"));

    fireEvent.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(screen.onSend).toHaveBeenCalled());
    await waitFor(() => expect(prefs.composerDrafts["project:abc"] ?? "").toBe(""));
  });
});
