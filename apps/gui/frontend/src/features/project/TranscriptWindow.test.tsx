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

describe("transcript window bounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mounts one page of a long thread", () => {
    const { screen, rows } = mount(thread(200));

    expect(rows()).toBe(12);
    expect(screen.getByText("row 199")).toBeInTheDocument();
    expect(screen.getByText("row 188")).toBeInTheDocument();
    expect(screen.queryByText("row 187")).toBeNull();
  });

  it("stops growing at the ceiling and evicts the tail to keep reading upward", () => {
    // The anchor restore runs on the next frame and holds the reveal open
    // until it does; running frames inline lets the test page repeatedly.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { screen, rows, showEarlier } = mount(thread(200));

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
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { screen, rows, showEarlier, showNewer } = mount(thread(200));

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
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const messages = thread(200);
    const [growing, setGrowing] = createSignal(messages);
    const screen = render(() => (
      <WorkspaceProvider>
        <TranscriptPane project={PROJECT} messages={growing()} streaming="" />
      </WorkspaceProvider>
    ));
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
