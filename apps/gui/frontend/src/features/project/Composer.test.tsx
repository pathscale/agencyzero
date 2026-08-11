import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATUS } from "~/api/fixtures";
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
        agent="claude"
        model="sonnet"
        modelOptions={[
          { value: "claude:sonnet", label: "Claude · Sonnet", agent: "claude", model: "sonnet" },
          { value: "claude:opus", label: "Claude · Opus", agent: "claude", model: "opus" },
        ]}
        efforts={[]}
        effort=""
        extraThinking={true}
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

afterEach(() => {
  AGENT_STATUS.find((status) => status.agent === "claude")!.state = "connected";
  vi.unstubAllGlobals();
});

describe("Composer", () => {
  it("keeps the draft and disables Send when the selected agent is unavailable", async () => {
    AGENT_STATUS.find((status) => status.agent === "claude")!.state = "missing";
    const { field, onSend, booted, getByRole, getByLabelText } = mount();
    await booted();

    type(field, "Please do not disappear");

    expect(getByRole("alert")).toHaveTextContent("Agent setup required");
    expect(getByLabelText("Send")).toBeDisabled();
    expect(field.value).toBe("Please do not disappear");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("puts the cursor in the prompt when the tab opens", () => {
    const { field } = mount({ autofocus: true });
    expect(document.activeElement).toBe(field);
  });

  it("leaves focus alone when not asked for it", () => {
    const { field } = mount();
    expect(document.activeElement).not.toBe(field);
  });

  it("wraps controls in two groups so a long model label cannot push Send outside", async () => {
    const { container, getByLabelText, booted } = mount({
      model: "opus[1m]",
      modelOptions: [
        {
          value: "claude:opus[1m]",
          label: "Claude · Opus (1M context)",
          agent: "claude",
          model: "opus[1m]",
        },
      ],
    });

    const controls = container.querySelector("[data-composer-controls]");
    const primary = container.querySelector("[data-composer-primary-controls]");
    const secondary = container.querySelector("[data-composer-secondary-controls]");
    expect(controls).toHaveClass("flex-wrap");
    expect(primary).toContainElement(getByLabelText("Permission"));
    expect(secondary).toHaveClass("ml-auto", "justify-end");
    expect(secondary).toContainElement(getByLabelText("Send"));
    for (const button of controls!.querySelectorAll("button")) {
      expect(
        button.classList.contains("h-[24px]") || button.classList.contains("size-[24px]"),
        `${button.getAttribute("aria-label") ?? button.textContent} must use the 24px composer height`,
      ).toBe(true);
    }
    for (const trigger of controls!.querySelectorAll('[data-slot="dropdown-trigger"]')) {
      // @pathscale/ui defaults dropdown triggers to a 36px minimum with 8px
      // vertical padding. Both properties must be overridden; h-[24px] alone
      // looks correct in source while rendering tall.
      expect(trigger).toHaveClass("h-[24px]", "min-h-[24px]", "py-0", "leading-none");
    }
    await booted();
  });

  it("clears the prompt only after the send resolves", async () => {
    const { field, onSend } = mount();
    type(field, "Review the upgrade");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("Review the upgrade", {
        authoredCharacterCount: 18,
        authoredLineCount: 1,
        attachmentCount: 0,
        userAuthoredPs: false,
      }),
    );
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("sends a staged question id as metadata and clears its chip on success", async () => {
    const onCancelQuestionReply = vi.fn();
    const screen = mount({
      replyQuestion: {
        id: "q-specific",
        projectId: "cafe",
        text: "Which fix should land first?",
        urgency: "blocking",
        answered: false,
        createdAt: "2026-08-07T00:00:00Z",
      },
      onCancelQuestionReply,
    });
    expect(screen.getByTitle("Which fix should land first?")).toHaveTextContent("Reply to #?");
    type(screen.field, "Ship the question flow first.");

    screen.field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await waitFor(() =>
      expect(screen.onSend).toHaveBeenCalledWith(
        "Ship the question flow first.",
        {
          authoredCharacterCount: 29,
          authoredLineCount: 1,
          attachmentCount: 0,
          userAuthoredPs: false,
        },
        "q-specific",
      ),
    );
    expect(onCancelQuestionReply).toHaveBeenCalledOnce();
  });

  it("never shows a horizontal scrollbar in the prompt field", async () => {
    const { field, booted, container } = mount();
    expect(field).toHaveAttribute("wrap", "soft");
    expect(field).toHaveClass(
      "min-w-0",
      "max-h-full",
      "overflow-x-hidden",
      "overflow-y-auto",
      "whitespace-pre-wrap",
      "break-words",
    );
    expect(container.querySelector("[data-prompt-viewport]")).toHaveClass("overflow-hidden");
    await booted();
  });

  it("keeps one writable line when layout briefly reports zero height", async () => {
    const { field, booted } = mount();
    Object.defineProperty(field, "scrollHeight", { configurable: true, value: 0 });

    fireEvent.input(field, { target: { value: "still writable" } });

    expect(field.style.height).toBe("22px");
    await booted();
  });

  it("remeasures a long draft restored reactively for the active tab", async () => {
    setPrefs("composerDrafts", {});
    const { field, booted } = mount({ draftKey: "project:restored" });
    Object.defineProperty(field, "scrollHeight", { configurable: true, value: 112 });

    setPrefs("composerDrafts", "project:restored", "a restored prompt ".repeat(80));

    await waitFor(() => expect(field.style.height).toBe("112px"));
    await booted();
  });

  it("expands a long-prompt editor per tab and restores it", async () => {
    setPrefs("expandedComposerKeys", []);
    const screen = mount({ draftKey: "project:abc" });

    fireEvent.click(screen.getByLabelText("Expand the prompt"));
    await waitFor(() => expect(prefs.expandedComposerKeys).toContain("project:abc"));
    await waitFor(() => expect(screen.field.style.height).toBe("240px"));
    expect(screen.field).toHaveAttribute("rows", "11");
    expect(screen.container.querySelector("[data-prompt-viewport]")).toHaveStyle({
      height: "240px",
    });

    fireEvent.click(screen.getByLabelText("Restore the prompt size"));
    await waitFor(() => expect(prefs.expandedComposerKeys).not.toContain("project:abc"));
    await screen.booted();
  });

  it("keeps an expanded long prompt inside a short window", async () => {
    vi.stubGlobal("innerHeight", 640);
    setPrefs("expandedComposerKeys", []);
    const screen = mount({ draftKey: "project:short-window" });
    Object.defineProperty(screen.field, "scrollHeight", { configurable: true, value: 900 });

    fireEvent.click(screen.getByLabelText("Expand the prompt"));

    await waitFor(() => expect(screen.field.style.height).toBe("240px"));
    expect(screen.field.style.maxHeight).toBe("240px");
    expect(screen.field).toHaveAttribute("rows", "11");
    await screen.booted();
  });

  it("detects authored PromptSyntax even when Advanced leaves the message unchanged", async () => {
    const { field, onSend } = mount();
    type(field, "@model:sonnet Review this");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("@model:sonnet Review this", {
        authoredCharacterCount: 25,
        authoredLineCount: 1,
        attachmentCount: 0,
        userAuthoredPs: true,
      }),
    );
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

  it("labels a busy send from the provider follow-up capability", async () => {
    const queued = mount({ isRunning: true, canFollowUp: false });
    expect(queued.getByLabelText("Queue after the running turn")).toBeTruthy();
    await queued.booted();
    queued.unmount();

    const live = mount({ isRunning: true, canFollowUp: true });
    expect(live.getByLabelText("Send into the running turn")).toBeTruthy();
    await live.booted();
  });

  it("shows the live next-turn estimate for a Claude picker alias", async () => {
    const screen = mount({ model: "sonnet" });
    await screen.booted();

    expect(screen.getByText(/^est \$/)).toBeTruthy();
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
      modelOptions: [
        { value: "claude:sonnet", label: "Claude · Sonnet", agent: "claude", model: "sonnet" },
      ],
    });
    const pill = getByLabelText("Model");
    expect(pill.textContent?.match(/Sonnet/g) ?? []).toHaveLength(1);
    expect(pill).not.toHaveTextContent("fable");
  });

  it("routes an OpenAI model command to Codex", async () => {
    const onModelChange = vi.fn();
    const { field, onSend } = mount({
      onModelChange,
      modelOptions: [
        { value: "claude:sonnet", label: "Claude · Sonnet", agent: "claude", model: "sonnet" },
        {
          value: "codex:gpt-5.6-sol",
          label: "OpenAI · GPT-5.6-Sol",
          agent: "codex",
          model: "gpt-5.6-sol",
        },
      ],
    });
    type(field, "/model gpt-5.6-sol");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onModelChange).toHaveBeenCalledWith("codex", "gpt-5.6-sol");
    expect(onSend).not.toHaveBeenCalled();
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
/*
 * The drift on the composer's edge is a CSS animation, and Blitz treats a
 * running animation as an active document: it submits full frames for the whole
 * window until the animation stops. Measured on 0.5.35 against a real project,
 * with nothing driven and no input at all: composer unfocused, 1.4fps and under
 * 2% CPU; a cursor placed in the composer, 29.9fps and 46% CPU, holding there
 * indefinitely. An owner's instance held 74.8% for four hours that way.
 *
 * So the class must track writing, not focus. These assert the state machine
 * that costs a core when it is wrong; the focus-keyed version fails the first
 * and the third.
 */
describe("the drift on the composer edge is a render loop, so it follows typing", () => {
  const ring = (container: HTMLElement) => container.querySelector(".az-ring-composer")!;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not animate for a cursor parked in an untouched composer", () => {
    const { container, field } = mount({ autofocus: true });
    expect(document.activeElement).toBe(field);
    expect(ring(container).className).not.toContain("az-ring-drift");
  });

  it("animates while someone is typing", () => {
    const { container, field } = mount();
    type(field, "writing something");
    expect(ring(container).className).toContain("az-ring-drift");
  });

  it("stops a few seconds after the last keystroke, with the cursor still in the box", () => {
    const { container, field } = mount();
    type(field, "writing something");
    expect(ring(container).className).toContain("az-ring-drift");

    vi.advanceTimersByTime(3_000);
    expect(ring(container).className).not.toContain("az-ring-drift");
  });

  it("keeps drifting across a burst rather than flickering per keystroke", () => {
    const { container, field } = mount();
    type(field, "a");
    vi.advanceTimersByTime(2_000);
    type(field, "ab");
    vi.advanceTimersByTime(2_000);
    expect(ring(container).className).toContain("az-ring-drift");
  });

  it("stops on blur without waiting out the timer", () => {
    const { container, field } = mount();
    type(field, "writing something");
    fireEvent.blur(field);
    expect(ring(container).className).not.toContain("az-ring-drift");
  });
});

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
          agent="claude"
          model="sonnet"
          modelOptions={[
            { value: "claude:sonnet", label: "Claude · Sonnet", agent: "claude", model: "sonnet" },
          ]}
          efforts={[]}
          effort=""
          extraThinking={true}
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
          agent="claude"
          model="sonnet"
          modelOptions={[
            { value: "claude:sonnet", label: "Claude · Sonnet", agent: "claude", model: "sonnet" },
          ]}
          efforts={[]}
          effort=""
          extraThinking={true}
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
  /*
   * A compaction runs for about a minute, and holding the composer for it meant
   * Enter did nothing for that whole minute — reported as "compact shouldn't
   * block the prompt". The queue exists precisely so those words are kept and
   * sent when the session comes back, and it cannot do that if the box is shut.
   */
  it("leaves the prompt usable while a compaction runs", async () => {
    // Never settles: the composer must be usable *during* the compaction, not
    // merely after it.
    const onCompact = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { field, booted, getByLabelText } = mount({ onCompact, onSend });
    await booted();

    type(field, "/compact");
    fireEvent.click(getByLabelText("Send"));
    await waitFor(() => expect(onCompact).toHaveBeenCalled());

    type(field, "and this should wait its turn");
    const send = getByLabelText("Send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    fireEvent.click(send);
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("and this should wait its turn", {
        authoredCharacterCount: 29,
        authoredLineCount: 1,
        attachmentCount: 0,
        userAuthoredPs: false,
      }),
    );
  });

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

describe("cost guidance controls", () => {
  beforeEach(() => {
    setPrefs({
      costWarningsDisabled: false,
      costWarningDismissals: 0,
      costWarningSnoozedUntil: 0,
    });
  });

  it("snoozes a dismissed warning and offers permanent disable on its next appearance", async () => {
    const screen = mount({
      contextTokens: 900_000,
      contextWindow: 1_000_000,
      contextAgent: "claude",
      contextModel: "sonnet",
    });
    await screen.booted();
    await waitFor(() => expect(screen.getByText(/This turn is projected/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText(/This turn is projected/)).toBeNull();
    expect(prefs.costWarningSnoozedUntil).toBeGreaterThan(Date.now());

    // Stand in for the ten-minute clock elapsing without making the provider's
    // async boot run under fake timers.
    setPrefs("costWarningSnoozedUntil", 0);
    await waitFor(() => expect(screen.getByText("Permanently disable this warning")).toBeTruthy());
    fireEvent.click(screen.getByText("Permanently disable this warning"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(prefs.costWarningsDisabled).toBe(true);
    expect(screen.queryByText(/This turn is projected/)).toBeNull();
  });

  it("shows the staged compact action without requiring the warning card", async () => {
    const onCompact = vi.fn().mockResolvedValue(undefined);
    const screen = mount({
      contextTokens: 700_000,
      contextWindow: 1_000_000,
      contextAgent: "claude",
      contextModel: "sonnet",
      onCompact,
    });
    await screen.booted();

    const action = await waitFor(() => screen.getByLabelText("Compact context"));
    expect(action.textContent).toMatch(/Compact \$/);
    fireEvent.click(action);
    expect(onCompact).toHaveBeenCalledOnce();
  });
});

describe("Extra Thinking", () => {
  it("is on for Claude and reports the flip", async () => {
    const onExtraThinkingChange = vi.fn();
    const { booted, getByRole } = mount({ onExtraThinkingChange });
    await booted();

    const button = getByRole("button", { name: "Extra Thinking" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);
    expect(onExtraThinkingChange).toHaveBeenCalledWith(false);
  });

  it("is disabled for a non-Claude agent and cannot be flipped", async () => {
    const onExtraThinkingChange = vi.fn();
    const { booted, getByRole } = mount({
      agent: "codex",
      extraThinking: true,
      onExtraThinkingChange,
    });
    await booted();

    const button = getByRole("button", { name: "Extra Thinking" });
    expect(button).toBeDisabled();
    // Not pressed either: the control reads as off for an agent it does not
    // apply to, rather than showing a state nothing acts on.
    expect(button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button);
    expect(onExtraThinkingChange).not.toHaveBeenCalled();
  });
});
