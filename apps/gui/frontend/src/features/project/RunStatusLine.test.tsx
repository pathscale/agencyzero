import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { RunStatusLine } from "~/features/project/TranscriptPane";
import { type RunStatus, WorkspaceProvider } from "~/stores/workspace";

/*
 * The figure on this line went a whole release reading "60 tokens" for a
 * ten-minute run, because it was built from the two fields `Event::Usage`
 * cannot supply mid-turn: `output_tokens`, which the crate withholds on
 * purpose, and Claude's `input_tokens`, which counts only the uncached delta.
 *
 * Nothing below the real backend emits `run:usage` — the mock fakes no agent
 * output, deliberately — so this component test is the only thing standing
 * between that bug and another release. It asserts what the line says, not how
 * the number was reached, which is the part a reader would have caught.
 */
function status(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    startedAt: Date.now(),
    activity: "working…",
    persistedChars: 0,
    liveTokens: null,
    ...overrides,
  };
}

function mount(over: { status?: Partial<RunStatus>; streamedChars?: number } = {}) {
  return render(() => (
    <WorkspaceProvider>
      <RunStatusLine
        projectId="proj-1"
        status={status(over.status)}
        streamedChars={over.streamedChars ?? 0}
      />
    </WorkspaceProvider>
  ));
}

describe("the run status line's token figure", () => {
  it("reports what the agent said, compactly", () => {
    const { container } = mount({ status: { liveTokens: 340_500 } });
    expect(container.textContent).toContain("340.5k tok");
  });

  /*
   * The regression itself. A turn that has read six figures out of cache must
   * not read as a two-digit count, so the assertion is on the magnitude rather
   * than on any exact string: whatever the formatting, the line cannot report
   * dozens of tokens for that turn.
   */
  it("does not report a cache-heavy turn as dozens of tokens", () => {
    const { container } = mount({ status: { liveTokens: 202_010 } });
    expect(container.textContent).toContain("202.0k tok");
    expect(container.textContent).not.toMatch(/\b\d{1,2} tokens\b/);
  });

  /*
   * Codex reports no usage mid-turn at all and Copilot only near the end, so
   * the character estimate is not a nicety, it is those agents' whole readout.
   * The tilde is what says the number is not the agent's own.
   */
  it("falls back to a marked estimate before any usage arrives", () => {
    const { container } = mount({ status: { liveTokens: null }, streamedChars: 2_000 });
    expect(container.textContent).toContain("~500 tokens");
  });

  /* A real report replaces the estimate, tilde and all. */
  it("prefers the reported figure over the estimate", () => {
    const { container } = mount({ status: { liveTokens: 12_000 }, streamedChars: 2_000 });
    expect(container.textContent).toContain("12.0k tok");
    expect(container.textContent).not.toContain("~");
  });

  /*
   * Zero is not a figure worth a segment: before the first request completes
   * there is nothing to say, and "0 tokens" reads as a stalled run.
   */
  it("says nothing about tokens when there is nothing to say", () => {
    const { container } = mount({ status: { liveTokens: null }, streamedChars: 0 });
    expect(container.textContent).not.toContain("tok");
  });

  it("keeps the activity and the elapsed clock alongside it", () => {
    const { container } = mount({
      status: { liveTokens: 5_000, activity: "thinking…" },
    });
    expect(container.textContent).toContain("thinking…");
    expect(container.textContent).toMatch(/\d+s/);
  });
});
