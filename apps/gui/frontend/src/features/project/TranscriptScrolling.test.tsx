import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptPane } from "~/features/project/TranscriptPane";
import { WorkspaceProvider } from "~/stores/workspace";
import type { Message, Project } from "~/types";

/**
 * Moving the view by hand.
 *
 * Everything else about the transcript was tested through where it *lands*:
 * whether a new message puts it back on the tail, whether a resize keeps it
 * there. None of it asked the more basic question — can a person scroll, and
 * does what they did survive the next thing the pane does. A change that broke
 * exactly that shipped with a green suite.
 *
 * The keys are the ones a reader actually uses: Page Up and Page Down, Home and
 * End, the arrows, and the wheel.
 */

const PROJECT: Project = {
  id: "scrolling",
  name: "Scrolling",
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

function thread(length: number): Message[] {
  return Array.from({ length }, (_, index) => ({
    id: `m-${index}`,
    projectId: PROJECT.id,
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

const VIEW = 400;
const CONTENT = 4_000;
/** The furthest a scroller of this geometry can be moved. */
const BOTTOM = CONTENT - VIEW;

/**
 * jsdom has no layout and no scrolling: `scrollTop` is a plain number that
 * nothing clamps, and a key press moves nothing on its own. So the geometry is
 * stubbed, and each helper does what the platform would have done — move the
 * offset, then let the pane hear about it.
 */
function mount(messages: Message[]) {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});

  const screen = render(() => (
    <WorkspaceProvider>
      <TranscriptPane project={PROJECT} messages={messages} streaming="" />
    </WorkspaceProvider>
  ));
  const scroller = screen.container.querySelector("[data-selectable]") as HTMLDivElement;
  let scrollHeight = CONTENT;
  // `scrollTop` clamps against these on its own: the environment does it for
  // every element (`src/test/setup.ts`), the way a real engine would.
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => VIEW },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });

  const settle = (): void => {
    for (const callback of frames.splice(0)) callback(0);
  };
  const to = (top: number): void => {
    scroller.scrollTop = top;
    fireEvent.scroll(scroller);
  };
  /** A key the browser would act on, then the scroll it would produce. */
  const press = (key: string, delta: number): void => {
    fireEvent.keyDown(scroller, { key });
    to(scroller.scrollTop + delta);
  };
  const wheel = (deltaY: number): void => {
    fireEvent.wheel(scroller, { deltaY });
    to(scroller.scrollTop + deltaY);
  };
  const grow = (by: number): void => {
    scrollHeight += by;
  };

  return { screen, scroller, settle, to, press, wheel, grow };
}

describe("scrolling the transcript by hand", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stays where Page Up put it when new content arrives", async () => {
    const view = mount(thread(60));
    view.settle();

    view.press("PageUp", -VIEW);
    const parked = view.scroller.scrollTop;
    expect(parked).toBeLessThan(BOTTOM);

    // The agent keeps talking while the reader is up in the history.
    view.grow(600);
    view.settle();
    await Promise.resolve();

    expect(view.scroller.scrollTop).toBe(parked);
  });

  it("stays where the wheel put it when new content arrives", async () => {
    const view = mount(thread(60));
    view.settle();

    view.wheel(-800);
    const parked = view.scroller.scrollTop;

    view.grow(600);
    view.settle();
    await Promise.resolve();

    expect(view.scroller.scrollTop).toBe(parked);
  });

  it("follows again after Page Down returns to the bottom", async () => {
    const view = mount(thread(60));
    view.settle();

    view.press("PageUp", -VIEW);
    expect(view.scroller.scrollTop).toBeLessThan(BOTTOM);

    // Back down, a page at a time, until there is nowhere left to go.
    for (let page = 0; page < 4 && view.scroller.scrollTop < BOTTOM; page += 1) {
      view.press("PageDown", VIEW);
    }
    expect(view.scroller.scrollTop).toBe(BOTTOM);

    view.grow(600);
    view.settle();
    await Promise.resolve();

    // Following again, so the new content is on screen: the bottom moved down
    // by what arrived, and the view went with it.
    expect(view.scroller.scrollTop).toBe(BOTTOM + 600);
  });

  it("stays put after Home, once earlier messages have mounted", async () => {
    const view = mount(thread(60));
    view.settle();

    // Reaching the top mounts the page above and anchors the reader to the row
    // they were on, so the offset lands wherever that row now is rather than at
    // zero. What matters is that it is far from the tail and holds.
    view.press("Home", -CONTENT);
    expect(view.scroller.scrollTop).toBeLessThan(BOTTOM / 2);

    view.grow(600);
    view.settle();
    await Promise.resolve();

    // Mounting the page above re-anchors the offset onto the row the reader
    // was on, so the exact number moves. What must not happen is being taken
    // to the tail.
    expect(view.scroller.scrollTop).toBeLessThan(BOTTOM / 2);
  });

  it("does not fight a reader who is scrolling upward in steps", async () => {
    const view = mount(thread(60));
    view.settle();

    let previous = view.scroller.scrollTop;
    for (let step = 0; step < 5; step += 1) {
      view.wheel(-120);
      view.settle();
      await Promise.resolve();
      const now = view.scroller.scrollTop;
      expect(now).toBeLessThan(previous);
      previous = now;
    }
  });

  it("keeps a reader in place when the footer below changes height", async () => {
    const [footer, setFooter] = createSignal(0);
    const view = mount(thread(60));
    view.settle();

    view.press("PageUp", -VIEW);
    const parked = view.scroller.scrollTop;

    // A panel opens below the transcript: the scroller gets shorter, but a
    // reader who is up in the history must not be moved by it.
    setFooter(120);
    void footer();
    view.settle();
    await Promise.resolve();

    expect(view.scroller.scrollTop).toBe(parked);
  });
});
