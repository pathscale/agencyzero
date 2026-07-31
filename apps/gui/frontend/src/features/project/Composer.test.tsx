import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "~/features/project/Composer";
import { prefs, setPrefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

function mount(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn().mockResolvedValue(undefined);
  let workspace!: Workspace;
  function Probe() {
    workspace = useWorkspace();
    return null;
  }
  // Wrapped since the Attach button made the composer a workspace consumer
  // (isLive gating and the picker action come from context).
  const screen = render(() => (
    <WorkspaceProvider>
      <Probe />
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
  /*
   * Waits for the provider to finish booting.
   *
   * It hydrates and logs asynchronously, so a test that finishes before it does
   * leaves that work to land during teardown — which vitest reports as an
   * unhandled rejection and fails the whole run on, with all 233 tests still
   * passing and nothing pointing at the culprit. It only bites the tests quick
   * enough to outrun the boot, which is why it survived a green local run and
   * broke CI.
   *
   * A function rather than a promise created here: an un-awaited `waitFor` that
   * timed out would be a second unhandled rejection, which is the disease.
   */
  const booted = () =>
    waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
  return { ...screen, field, onSend, booted };
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

/*
 * Two project tabs share one `<Match>` branch, so switching between them swaps
 * this component's props without unmounting it. A draft held in local state
 * survived that swap and appeared under the next tab — typing "test" in one
 * session showed "test" in the next, and the draft it landed on was lost.
 */
describe("a draft belongs to its own tab", () => {
  beforeEach(() => {
    setPrefs("composerDrafts", {});
  });

  it("follows the key when the same composer is handed a different tab", async () => {
    const [key, setKey] = createSignal("project:abc");
    const screen = render(() => (
      <WorkspaceProvider>
        <Composer
          draftKey={key()}
          placeholder="Ask, or type / for commands…"
          model="sonnet"
          modelOptions={[{ value: "sonnet", label: "Sonnet" }]}
          efforts={[]}
          effort=""
          permission="read_only"
          onModelChange={() => {}}
          onPermissionChange={() => {}}
          onSend={vi.fn().mockResolvedValue(undefined)}
        />
      </WorkspaceProvider>
    ));
    const field = () =>
      screen.getByLabelText("Ask, or type / for commands…") as HTMLTextAreaElement;

    fireEvent.input(field(), { target: { value: "meant for abc" } });
    await waitFor(() => expect(prefs.composerDrafts["project:abc"]).toBe("meant for abc"));

    // The tab changes under the same component instance.
    setKey("project:xyz");
    await waitFor(() => expect(field().value).toBe(""));
    expect(prefs.composerDrafts["project:xyz"]).toBeUndefined();

    // And going back brings the first tab's words with it.
    setKey("project:abc");
    await waitFor(() => expect(field().value).toBe("meant for abc"));
  });
});

/*
 * The same reuse that leaked the draft leaked everything else the composer
 * holds. An error raised in one conversation appeared under every tab, which is
 * how a failure in a single project came to look like the whole app being
 * broken — the reported symptom was "I see this error across all prompts".
 */
describe("what the composer holds is per tab", () => {
  it("keeps an error under the conversation that raised it", async () => {
    const [key, setKey] = createSignal("project:abc");
    const failing = vi.fn().mockRejectedValue(new Error("no session to compact"));
    const screen = render(() => (
      <WorkspaceProvider>
        <Composer
          draftKey={key()}
          placeholder="Ask, or type / for commands…"
          model="sonnet"
          modelOptions={[{ value: "sonnet", label: "Sonnet" }]}
          efforts={[]}
          effort=""
          permission="read_only"
          onModelChange={() => {}}
          onPermissionChange={() => {}}
          onCompact={failing}
          onSend={vi.fn().mockResolvedValue(undefined)}
        />
      </WorkspaceProvider>
    ));
    const field = () =>
      screen.getByLabelText("Ask, or type / for commands…") as HTMLTextAreaElement;

    fireEvent.input(field(), { target: { value: "/compact" } });
    fireEvent.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(screen.getByText(/no session to compact/)).toBeTruthy());

    // The other tab is a different conversation and never failed at anything.
    setKey("project:xyz");
    await waitFor(() => expect(screen.queryByText(/no session to compact/)).toBeNull());

    // Coming back finds it where it was left, rather than having been cleared.
    setKey("project:abc");
    await waitFor(() => expect(screen.getByText(/no session to compact/)).toBeTruthy());
  });
});

/*
 * The alert under the box is for things that went wrong, and it says so in red.
 * A compaction that *worked* was reported through it, under the prefix every
 * message in the slot used to get — so the screenshot read "Could not send —
 * your message is still here. Compacted." on a compaction that had succeeded.
 */
describe("the alert slot means failure", () => {
  it("says nothing when a compaction succeeds", async () => {
    const onCompact = vi.fn().mockResolvedValue(undefined);
    const { field, booted, queryByRole, getByLabelText } = mount({ onCompact });
    await booted();

    type(field, "/compact");
    fireEvent.click(getByLabelText("Send"));

    await waitFor(() => expect(onCompact).toHaveBeenCalled());
    // The transcript reports it — a status line while it runs, a note when it
    // lands. Here there is nothing to report.
    expect(queryByRole("alert")).toBeNull();
  });

  it("still explains a compaction that was refused, without blaming the draft", async () => {
    const onCompact = vi.fn().mockRejectedValue(new Error("a run is already active"));
    const { field, booted, getByRole, getByLabelText } = mount({ onCompact });
    await booted();

    type(field, "/compact");
    fireEvent.click(getByLabelText("Send"));

    const alert = await waitFor(() => getByRole("alert"));
    expect(alert.textContent).toContain("a run is already active");
    // Nothing was sent, so nothing is "still here" waiting to be resent.
    expect(alert.textContent).not.toContain("still here");
  });

  it("keeps the prefix on a send that actually failed", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("the backend is unreachable"));
    const { field, booted, getByRole, getByLabelText } = mount({ onSend });
    await booted();

    type(field, "a real prompt");
    fireEvent.click(getByLabelText("Send"));

    const alert = await waitFor(() => getByRole("alert"));
    expect(alert.textContent).toContain("still here");
    expect(alert.textContent).toContain("the backend is unreachable");
    // And the words are where the alert says they are.
    expect(field.value).toBe("a real prompt");
  });
});
