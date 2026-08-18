import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_MAX_ENTRIES, TranscriptPane } from "~/features/project/TranscriptPane";
import { WorkspaceProvider } from "~/stores/workspace";
import type { Message, Project } from "~/types";

const PROJECT: Project = {
  id: "bulk",
  name: "Bulk",
  status: "active",
  order: 0,
  dirs: [],
  pinned: false,
  moderatorEnabled: false,
  forkedFrom: null,
  sessionId: null,
  sessions: {},
  lastActivityAt: "2026-08-10T00:00:00Z",
};

/**
 * Owner messages only: their bodies render as plain text in one bubble each,
 * so "how many rows are mounted" and "which rows" are both readable straight
 * off the DOM without going through markdown.
 */
function thread(length: number): Message[] {
  return Array.from({ length }, (_, index) => ({
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
}

function mount(messages: Message[]) {
  const screen = render(() => (
    <WorkspaceProvider>
      <TranscriptPane project={PROJECT} messages={messages} streaming="" />
    </WorkspaceProvider>
  ));
  // The section itself carries `data-selectable`; every other one is a bubble.
  const rows = (): number => screen.container.querySelectorAll("[data-selectable]").length - 1;
  const showEarlier = (): void => {
    fireEvent.click(screen.getByRole("button", { name: /Show \d+ earlier messages/ }));
  };
  const showNewer = (): void => {
    fireEvent.click(screen.getByRole("button", { name: /Show \d+ newer messages/ }));
  };
  return { screen, rows, showEarlier, showNewer };
}

/**
 * Run animation frames inline, but never inside the effect that scheduled them.
 *
 * These tests need frames to run synchronously: the anchor restore happens on
 * the next frame and holds a reveal open until it does, so a deferred frame
 * means the test cannot page more than once.
 *
 * Running them straight from the stub is what broke: `TranscriptPane`'s initial
 * fill schedules its next frame from inside a tracked effect, and the callback
 * calls `flush()`, which Solid 2 refuses re-entrantly ("Cannot call flush()
 * from inside onSettled or createTrackedEffect"). That halted the reactive
 * system and failed every test in this file. A real `requestAnimationFrame`
 * never invokes its callback synchronously, so the stub was modelling
 * something the browser does not do.
 *
 * Frames scheduled while mounting are queued; the returned function drains them
 * once mounting has returned, and from then on frames run inline. Both points
 * are outside any effect, which is where a browser delivers them.
 */
function inlineFramesAfterMount(): () => void {
  let mounting = true;
  const queued: FrameRequestCallback[] = [];

  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    if (mounting) queued.push(callback);
    else callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});

  return () => {
    mounting = false;
    // Each fill step schedules the next, so draining walks the window up to a
    // full page. The guard stops a scheduling loop from hanging the suite.
    for (let guard = 0; guard < 100 && queued.length > 0; guard++) {
      queued.shift()?.(0);
    }
  };
}

describe("transcript window bounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  /*
   * The window opens at `INITIAL_VISIBLE_ENTRIES` and fills to a full page over
   * the frames after the first, so a row's 8 to 14ms build cost is not paid
   * twelve times before anything is on screen. The frames have to be driven
   * here for the same reason the test below drives them.
   */
  it("mounts one page of a long thread", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { screen, rows } = mount(thread(200));

    // The first frame carries only the visible tail.
    expect(rows()).toBe(4);
    // Then the page fills, a step per frame.
    for (let step = 0; step < 6 && rows() < 12; step += 1) {
      for (const callback of frames.splice(0)) callback(0);
    }

    expect(rows()).toBe(12);
    expect(screen.getByText("row 199")).toBeInTheDocument();
    expect(screen.getByText("row 188")).toBeInTheDocument();
    expect(screen.queryByText("row 187")).toBeNull();
  });

  it("keeps the Page Up movement after revealing an earlier history page", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { screen } = mount(thread(200));
    // Let the window reach a full page before exercising Page Up, which is the
    // state this test is about.
    for (let step = 0; step < 6; step += 1) {
      for (const callback of frames.splice(0)) callback(0);
    }
    const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: {
        configurable: true,
        get: () => (screen.container.querySelectorAll("[data-selectable]").length - 1) * 100,
      },
    });
    scroller.scrollTop = 300;

    fireEvent.keyDown(scroller, { key: "PageUp" });
    expect(screen.getByText("row 187")).toBeInTheDocument();
    for (const callback of frames.splice(0)) callback(0);

    // The reveal adds 1,200px above and anchors the old reading position at
    // 1,500px. Page Up must then move one 400px viewport to 1,100px instead of
    // letting the reveal's anchor restoration erase the keyboard command.
    expect(scroller.scrollTop).toBe(1_100);
  });

  it("stops growing at the ceiling and evicts the tail to keep reading upward", () => {
    const drainFrames = inlineFramesAfterMount();
    const { screen, rows, showEarlier } = mount(thread(200));
    drainFrames();

    // One page is mounted already, so three reveals fill the window exactly
    // and the tail is still there.
    for (let page = 0; page < 3; page++) {
      showEarlier();
      expect(rows()).toBeLessThanOrEqual(TRANSCRIPT_MAX_ENTRIES);
    }
    expect(rows()).toBe(TRANSCRIPT_MAX_ENTRIES);
    expect(screen.getByText("row 199")).toBeInTheDocument();
    expect(screen.getByText("row 152")).toBeInTheDocument();
    expect(screen.queryByText("row 151")).toBeNull();

    // The next page is paid for: twelve rows appear above and the twelve
    // newest are dropped. This is the bug the window used to have, where the
    // count only ever grew and the whole thread ended up mounted.
    showEarlier();
    expect(rows()).toBe(TRANSCRIPT_MAX_ENTRIES);
    expect(screen.getByText("row 140")).toBeInTheDocument();
    expect(screen.getByText("row 187")).toBeInTheDocument();
    expect(screen.queryByText("row 139")).toBeNull();
    expect(screen.queryByText("row 188")).toBeNull();

    // Ten more pages, half a thousand rows walked past, same mounted cost.
    for (let page = 0; page < 10; page++) showEarlier();
    expect(rows()).toBe(TRANSCRIPT_MAX_ENTRIES);
    expect(screen.getByText("row 20")).toBeInTheDocument();
    expect(screen.queryByText("row 199")).toBeNull();
  });

  it("walks back down to the tail and re-engages the follow", () => {
    const drainFrames = inlineFramesAfterMount();
    const { screen, rows, showEarlier, showNewer } = mount(thread(200));
    drainFrames();

    // Three reveals fill the window, the fourth slides it one page off the tail.
    for (let page = 0; page < 4; page++) showEarlier();
    expect(screen.getByRole("button", { name: "Show 12 newer messages" })).toBeInTheDocument();
    expect(screen.getByText("row 140")).toBeInTheDocument();
    expect(screen.queryByText("row 199")).toBeNull();

    showNewer();
    expect(rows()).toBe(TRANSCRIPT_MAX_ENTRIES);
    expect(screen.getByText("row 199")).toBeInTheDocument();
    // Back at the tail there is nothing newer to reveal, so arriving messages
    // mount again rather than piling up behind a seam.
    expect(screen.queryByRole("button", { name: /newer messages/ })).toBeNull();
  });

  it("holds the reader's rows still while new messages land at the tail", () => {
    const drainFrames = inlineFramesAfterMount();
    const messages = thread(200);
    const [growing, setGrowing] = createSignal(messages);
    const screen = render(() => (
      <WorkspaceProvider>
        <TranscriptPane project={PROJECT} messages={growing()} streaming="" />
      </WorkspaceProvider>
    ));
    drainFrames();
    const rows = (): number => screen.container.querySelectorAll("[data-selectable]").length - 1;

    // Three reveals fill the window, two more slide it two pages off the tail.
    for (let page = 0; page < 5; page++) {
      fireEvent.click(screen.getByRole("button", { name: /Show \d+ earlier messages/ }));
    }
    expect(screen.getByText("row 128")).toBeInTheDocument();
    expect(screen.getByText("row 175")).toBeInTheDocument();

    // Twenty more turns arrive while the reader is up in the history. A window
    // counted from the end would walk twenty rows towards the tail and pull
    // the text out from under them; the window holds its edge by row id.
    setGrowing([...messages, ...thread(220).slice(200)]);

    expect(rows()).toBe(TRANSCRIPT_MAX_ENTRIES);
    expect(screen.getByText("row 128")).toBeInTheDocument();
    expect(screen.getByText("row 175")).toBeInTheDocument();
    expect(screen.queryByText("row 176")).toBeNull();
    expect(screen.getByRole("button", { name: "Show 12 newer messages" })).toBeInTheDocument();
  });
});
