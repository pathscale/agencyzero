import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptPane } from "~/features/project/TranscriptPane";
import { useWorkspace, WorkspaceProvider } from "~/stores/workspace";

function Harness() {
  const workspace = useWorkspace();
  const project = () => workspace.state.projects.find((candidate) => candidate.id === "cafe");

  return (
    <Show when={workspace.state.boot.status === "ready" && project()}>
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

describe("transcript resize anchoring", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a pinned transcript at the tail when its width changes", async () => {
    let notifyResize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroller.scrollTop = 600;
    scroller.scrollLeft = 24;
    fireEvent.scroll(scroller);

    scrollHeight = 1_240;
    notifyResize?.([], {} as ResizeObserver);
    await Promise.resolve();

    expect(scroller.scrollTop).toBe(1_240);
    expect(scroller.scrollLeft).toBe(0);
  });

  it("does not move a transcript whose reader scrolled up", async () => {
    let notifyResize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    scroller.scrollTop = 200;
    scroller.scrollLeft = 24;
    fireEvent.wheel(scroller, { deltaY: -400 });
    fireEvent.scroll(scroller);

    scrollHeight = 1_240;
    notifyResize?.([], {} as ResizeObserver);
    await Promise.resolve();

    expect(scroller.scrollTop).toBe(200);
    expect(scroller.scrollLeft).toBe(0);
  });

  it("does not treat a resize clamp as owner scrolling", async () => {
    let notifyResize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);

    // Browser layout can clamp scrollTop before ResizeObserver reports the
    // new geometry. No wheel, pointer, touch, or key input preceded this.
    scroller.scrollTop = 520;
    fireEvent.scroll(scroller);
    scrollHeight = 1_240;
    notifyResize?.([], {} as ResizeObserver);
    await Promise.resolve();

    expect(scroller.scrollTop).toBe(1_240);
  });

  it("re-anchors after streamed DOM content changes while still pinned", async () => {
    let notifyMutation: MutationCallback | undefined;
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: MutationCallback) {
          notifyMutation = callback;
        }
        observe() {}
        disconnect() {}
      },
    );

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);

    scrollHeight = 1_180;
    notifyMutation?.([], {} as MutationObserver);
    await Promise.resolve();

    expect(scroller.scrollTop).toBe(1_180);
  });
});
