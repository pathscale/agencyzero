import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { flush, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteTranscriptChromeChanged, TranscriptPane } from "~/features/project/TranscriptPane";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

let workspace!: Workspace;

function Harness() {
  workspace = useWorkspace();
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

  it("lands at the tail when Blitz finishes initial layout one frame late", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    let scrollHeight = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    const firstLayout = frames.splice(0);
    firstLayout.forEach((callback) => {
      callback(0);
    });
    expect(scroller.scrollTop).toBe(0);

    scrollHeight = 1_000;
    const settledLayout = frames.splice(0);
    settledLayout.forEach((callback) => {
      callback(16);
    });

    expect(scroller.scrollTop).toBe(600);
  });

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

    expect(scroller.scrollTop).toBe(840);
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

    expect(scroller.scrollTop).toBe(840);
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

    expect(scroller.scrollTop).toBe(780);
  });

  it("uses Page Up and Page Down to leave and rejoin tail following", async () => {
    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    workspace.actions.openProject("cafe");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 1_000 },
    });
    scroller.scrollTop = 600;

    fireEvent.keyDown(scroller, { key: "PageUp" });
    flush();
    expect(scroller.scrollTop).toBe(200);
    expect(workspace.state.transcriptPositions.cafe).toBe(201);

    fireEvent.keyDown(scroller, { key: "PageDown" });
    flush();
    expect(scroller.scrollTop).toBe(600);
    expect(workspace.state.transcriptPositions.cafe).toBe(0);
  });

  it("keeps appended content out of view after the owner pages up", async () => {
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
    fireEvent.keyDown(scroller, { key: "PageUp" });
    flush();
    expect(scroller.scrollTop).toBe(200);

    scrollHeight = 1_400;
    notifyResize?.([], {} as ResizeObserver);
    await Promise.resolve();

    expect(scroller.scrollTop).toBe(200);
  });

  it("realigns bottom chrome only for the true-bottom sentinel", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    workspace.actions.openProject("cafe");
    let clientHeight = 400;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => 1_000 },
    });
    for (const callback of frames.splice(0)) callback(0);
    await Promise.resolve();

    scroller.scrollTop = 600;
    fireEvent.keyDown(scroller, { key: "PageUp" });
    flush();
    expect(workspace.state.transcriptPositions.cafe).toBe(201);
    clientHeight = 300;
    noteTranscriptChromeChanged();
    await Promise.resolve();
    for (const callback of frames.splice(0)) callback(16);
    expect(scroller.scrollTop).toBe(200);

    fireEvent.keyDown(scroller, { key: "End" });
    flush();
    expect(workspace.state.transcriptPositions.cafe).toBe(0);
    clientHeight = 250;
    noteTranscriptChromeChanged();
    await Promise.resolve();
    for (const callback of frames.splice(0)) callback(32);
    expect(scroller.scrollTop).toBe(750);
  });

  it("realigns a bottom-following project when it becomes active again", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 1_000 },
    });
    workspace.actions.openProject("cafe");
    for (const callback of frames.splice(0)) callback(0);
    await Promise.resolve();
    expect(scroller.scrollTop).toBe(600);

    workspace.actions.openProject("worktable");
    // Reproduce a renderer presentation shift while another project is active.
    // It is not owner intent and must not become the new anchor.
    scroller.scrollTop = 180;
    fireEvent.scroll(scroller);
    workspace.actions.openProject("cafe");
    await Promise.resolve();
    for (const callback of frames.splice(0)) callback(16);
    await Promise.resolve();

    expect(scroller.scrollTop).toBe(600);
  });

  it("does not reposition an inactive project after its reader pages up", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    workspace.actions.openProject("cafe");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 1_000 },
    });
    scroller.scrollTop = 600;
    fireEvent.keyDown(scroller, { key: "PageUp" });
    flush();
    expect(scroller.scrollTop).toBe(200);
    expect(workspace.state.transcriptPositions.cafe).toBe(201);

    workspace.actions.openProject("worktable");
    flush();
    await waitFor(() =>
      expect(workspace.state.settings?.workspaceTabs?.scrollPositions.cafe).toBe(201),
    );
    // A stale scroll event from the previously active project is renderer
    // presentation, not owner navigation, and must not replace the reader's
    // last deliberate position.
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    flush();
    expect(workspace.state.transcriptPositions.cafe).toBe(201);
    workspace.actions.openProject("cafe");
    await Promise.resolve();
    for (const callback of frames.splice(0)) callback(16);
    await Promise.resolve();

    expect(scroller.scrollTop).toBe(200);
  });
});
