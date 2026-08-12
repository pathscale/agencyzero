import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptPane } from "~/features/project/TranscriptPane";
import { prefs, setPrefs } from "~/stores/prefs";
import { useWorkspace, WorkspaceProvider } from "~/stores/workspace";

/**
 * Following the tail has to survive a tab switch.
 *
 * `App.tsx` renders one tab at a time, so switching away unmounts the project
 * screen and switching back builds a new one. The flag therefore cannot live in
 * the component, and these are the steps that showed it: reach the bottom,
 * switch left, switch right, and ask whether the transcript is still following.
 */
function Harness(props: { mounted: boolean }) {
  const workspace = useWorkspace();
  const project = () => workspace.state.projects.find((candidate) => candidate.id === "cafe");

  return (
    <Show when={props.mounted && workspace.state.boot.status === "ready" && project()}>
      {(readyProject) => (
        <TranscriptPane
          project={readyProject()}
          messages={workspace.state.messages.cafe ?? []}
          streaming=""
        />
      )}
    </Show>
  );
}

/** A scroller with a real geometry, since jsdom lays nothing out. */
function stubGeometry(scroller: HTMLElement, scrollHeight: number, clientHeight = 400): void {
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });
}

describe("transcript follows the tail across a tab switch", () => {
  beforeEach(() => setPrefs("transcriptAtBottom", {}));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps atBottom set when the pane is unmounted and mounted again", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const [mounted, setMounted] = createSignal(true);
    const screen = render(() => (
      <WorkspaceProvider>
        <Harness mounted={mounted()} />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    stubGeometry(scroller, 1_000);
    for (const callback of frames.splice(0)) callback(0);

    // At the bottom, which is where the transcript starts.
    expect(prefs.transcriptAtBottom.cafe ?? true).toBe(true);

    // Switch away: the project screen is unmounted, exactly as App.tsx does it.
    setMounted(false);
    await Promise.resolve();
    expect(screen.container.querySelector("[data-selectable]")).toBeNull();

    // Switch back.
    setMounted(true);
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    expect(prefs.transcriptAtBottom.cafe ?? true).toBe(true);
  });

  it("remembers a reader who scrolled away, and does not re-pin on return", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const [mounted, setMounted] = createSignal(true);
    const screen = render(() => (
      <WorkspaceProvider>
        <Harness mounted={mounted()} />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    stubGeometry(scroller, 1_000);
    for (const callback of frames.splice(0)) callback(0);

    // The owner scrolls up. Only owner input may disengage the follow, so the
    // wheel event is what makes this reading rather than reflow.
    fireEvent.wheel(scroller, { deltaY: -200 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    await Promise.resolve();
    expect(prefs.transcriptAtBottom.cafe).toBe(false);

    setMounted(false);
    await Promise.resolve();
    setMounted(true);
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    // Coming back must not drag them to the bottom.
    expect(prefs.transcriptAtBottom.cafe).toBe(false);
  });

  it("re-engages when the owner returns to the bottom", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness mounted={true} />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    stubGeometry(scroller, 1_000);
    for (const callback of frames.splice(0)) callback(0);

    fireEvent.wheel(scroller, { deltaY: -200 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    await Promise.resolve();
    expect(prefs.transcriptAtBottom.cafe).toBe(false);

    // Back down to within the slack of the bottom: 1_000 - 400 = 600 is the
    // last position that shows the end, and anything within TAIL_SLACK of it
    // counts as being there.
    scroller.scrollTop = 590;
    fireEvent.scroll(scroller);
    await Promise.resolve();
    expect(prefs.transcriptAtBottom.cafe).toBe(true);
  });
});

/**
 * The steps that showed it: page up through the history, then come back down.
 *
 * Reaching the bottom only re-engages the follow when the mounted window ends
 * at the tail (`view.trailing === 0`), because the bottom of a slid window is
 * not the bottom of the conversation. Paging up slides the window, so the
 * question is whether coming back down ever gets it back.
 */
describe("returning to the bottom after paging through history", () => {
  beforeEach(() => setPrefs("transcriptAtBottom", {}));
  afterEach(() => vi.unstubAllGlobals());

  const PROJECT = {
    id: "bulk",
    name: "Bulk",
    status: "active" as const,
    order: 0,
    dirs: [],
    pinned: false,
    moderatorEnabled: false,
    forkedFrom: null,
    sessionId: null,
    sessions: {},
    lastActivityAt: "2026-08-10T00:00:00Z",
  };

  const thread = (length: number) =>
    Array.from({ length }, (_, index) => ({
      id: `m-${index}`,
      projectId: "bulk",
      itemId: null,
      author: "user" as const,
      agent: "claude" as const,
      moderation: null,
      model: "sonnet",
      permission: "read_only" as const,
      usage: null,
      stop: "completed" as const,
      exitCode: 0,
      body: `row ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString(),
    }));

  it("re-engages once the window is back at the tail", async () => {
    // Queued, not called inline: `glideTo` schedules the next frame from
    // inside the current one, so a stub that runs callbacks synchronously
    // recurses until the stack gives out.
    const pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pending.push(callback);
      return pending.length;
    });
    const drainFrames = (count: number): void => {
      for (let frame = 0; frame < count; frame += 1) {
        const next = pending.splice(0);
        if (next.length === 0) return;
        for (const callback of next) callback(frame * 16);
      }
    };
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const screen = render(() => (
      <WorkspaceProvider>
        <TranscriptPane project={PROJECT} messages={thread(120)} streaming="" />
      </WorkspaceProvider>
    ));
    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    stubGeometry(scroller, 1_000);

    // Page up through the history until the window has slid off the tail.
    for (let page = 0; page < 6; page += 1) {
      const earlier = screen.queryByRole("button", { name: /Show \d+ earlier messages/ });
      if (!earlier) break;
      fireEvent.click(earlier);
      drainFrames(4);
      await Promise.resolve();
    }

    // Now come back down to the bottom, as the owner would.
    fireEvent.wheel(scroller, { deltaY: 200 });
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    await Promise.resolve();

    // Walk back to the newest rows the way the pane offers.
    for (let page = 0; page < 8; page += 1) {
      const newer = screen.queryByRole("button", { name: /Show \d+ newer messages/ });
      if (!newer) break;
      fireEvent.click(newer);
      drainFrames(4);
      await Promise.resolve();
      scroller.scrollTop = 600;
      fireEvent.scroll(scroller);
      await Promise.resolve();
    }

    expect(prefs.transcriptAtBottom.bulk).toBe(true);
  });
});
