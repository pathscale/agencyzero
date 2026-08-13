import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { horizontalRevealTarget, TabStrip } from "~/features/tabs/TabStrip";
import { setPrefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

async function mountStrip() {
  let workspace!: Workspace;

  function Probe() {
    workspace = useWorkspace();
    return null;
  }

  const screen = render(() => (
    <WorkspaceProvider>
      <Probe />
      <TabStrip />
    </WorkspaceProvider>
  ));

  await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
  return { ...screen, workspace };
}

// Boot restores only remembered tabs now; these scenarios want them all open.
beforeEach(() => {
  setPrefs("openTabKeys", ["worktable", "cafe", "quux"]);
});

describe("TabStrip", () => {
  it("keeps the active tab treatment inside the horizontal scroller", async () => {
    const { getByRole } = await mountStrip();
    const pill = getByRole("button", { name: "Home" }).closest("[data-tab-key]");

    expect(pill?.className).toContain("inset_0_1px");
    expect(pill?.className).not.toContain("rgba(0,0,0,.35)");
  });

  /*
   * Queried by accessible name rather than text: the label is rendered twice,
   * once as the invisible sizing ghost, and the ghost is aria-hidden so only
   * the visible copy contributes a name.
   */
  it("renders Home plus a tab per project", async () => {
    const { getByRole } = await mountStrip();
    for (const label of ["Home", "foo.bar", "baz.qux", "quux.dev"]) {
      expect(getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  /*
   * The close button used to be mounted only on the active tab, which meant an
   * inactive tab could not be closed without selecting it first — and, worse,
   * that mounting it on activation changed the pill's width and shoved the rest
   * of the strip sideways on every cycle. It is now always present and only
   * *revealed* on active/hover/focus.
   */
  it("mounts a close button on every closable tab, not just the active one", async () => {
    const { getByLabelText } = await mountStrip();

    expect(getByLabelText("Close foo.bar")).toBeInTheDocument();
    expect(getByLabelText("Close baz.qux")).toBeInTheDocument();
    expect(getByLabelText("Close quux.dev")).toBeInTheDocument();
  });

  it("gives Home no close button, because Home is not closable", async () => {
    const { queryByLabelText } = await mountStrip();
    expect(queryByLabelText("Close Home")).toBeNull();
  });

  it("hides an inactive tab's close button without unmounting it", async () => {
    const { getByLabelText, workspace } = await mountStrip();
    workspace.actions.focus("worktable");

    await waitFor(() => {
      expect(getByLabelText("Close foo.bar").className).toContain("opacity-100");
      expect(getByLabelText("Close quux.dev").className).toContain("opacity-0");
      expect(getByLabelText("Close quux.dev").className).toContain("group-hover:opacity-100");
    });
  });

  /*
   * The other half of the width fix, and the half jsdom can check: the label
   * carries an always-semibold invisible ghost sharing one grid cell with the
   * visible copy, so the cell is sized for the bold width whatever weight is
   * showing. Whether that actually holds the width is a layout question, and
   * layout is what jsdom does not do — see the README.
   */
  it("renders a bold sizing ghost beside every visible label", async () => {
    const { getByLabelText } = await mountStrip();
    const pill = getByLabelText("Close foo.bar").parentElement!;

    const ghost = pill.querySelector('[aria-hidden="true"].invisible');
    expect(ghost).toHaveTextContent("foo.bar");
    expect(ghost?.className).toContain("font-semibold");
  });

  it("marks only the active tab as current", async () => {
    const { container, workspace } = await mountStrip();
    workspace.actions.focus("cafe");

    await waitFor(() => {
      const current = container.querySelectorAll('[aria-current="page"]');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent("baz.qux");
    });
  });

  it("clicking a tab selects it", async () => {
    const { getByRole, workspace } = await mountStrip();
    getByRole("button", { name: "quux.dev" }).click();

    await waitFor(() => expect(workspace.state.activeKey).toBe("quux"));
  });

  it("clicking a close button closes that tab without selecting it", async () => {
    const { getByLabelText, workspace } = await mountStrip();
    workspace.actions.focus("home");

    getByLabelText("Close quux.dev").click();

    await waitFor(() => {
      expect(workspace.state.tabs.map((tab) => tab.key)).toEqual(["home", "worktable", "cafe"]);
      expect(workspace.state.activeKey).toBe("home");
    });
  });

  it("declares the strip a window drag region", async () => {
    const { container, getByRole } = await mountStrip();
    expect(container.querySelector('[data-tauri-drag-region="deep"]')).toBeTruthy();
  });

  it("keeps the close button out of the drag gesture", async () => {
    const { getByLabelText } = await mountStrip();
    expect(getByLabelText("Close foo.bar")).toHaveAttribute("data-no-drag");
  });
});

describe("overflow", () => {
  it("keeps navigation arrows in flex layout under the PathScale adapter", async () => {
    const { container, getByRole } = await mountStrip();
    const strip = container.querySelector<HTMLElement>(".az-scroll-x");
    if (!strip) throw new Error("tab strip was not rendered");
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, get: () => 200 },
      scrollWidth: { configurable: true, get: () => 400 },
      scrollLeft: { configurable: true, get: () => 0, set: () => {} },
    });
    fireEvent.scroll(strip);
    await waitFor(() => expect(getByRole("button", { name: "Scroll tabs right" })).toBeTruthy());
    const right = getByRole("button", { name: "Scroll tabs right" });
    expect(right.className).toContain("flex");
    expect(right.className).toContain("size-6");
    expect(right.className).toContain("shrink-0");
  });

  it("computes an immediate reveal position for an offscreen active pill", () => {
    const strip = { clientWidth: 160, scrollLeft: 0, scrollWidth: 400 };
    const stripRect = { left: 100, right: 260 };
    expect(horizontalRevealTarget(strip, stripRect, { left: 300, right: 380 })).toBe(128);

    strip.scrollLeft = 100;
    expect(horizontalRevealTarget(strip, stripRect, { left: 50, right: 90 })).toBe(42);

    strip.scrollLeft = 40;
    expect(horizontalRevealTarget(strip, stripRect, { left: 140, right: 180 })).toBeNull();
  });

  /*
   * jsdom has no layout, so scrollWidth and clientWidth are both 0 and the
   * strip never reports as overflowing. What is checkable here is that the
   * arrows stay out of the way until they are needed, and that the strip is
   * the scrollbar-less variant — a horizontal scrollbar under the tabs sits
   * inside the window's drag region and cannot be grabbed.
   */
  it("shows no arrows while every tab fits", async () => {
    const { queryByLabelText } = await mountStrip();
    expect(queryByLabelText("Scroll tabs left")).toBeNull();
    expect(queryByLabelText("Scroll tabs right")).toBeNull();
  });

  it("scrolls the strip without exposing a scrollbar", async () => {
    const { container } = await mountStrip();
    expect(container.querySelector(".az-scroll-x")).toBeTruthy();
  });

  /** How the scroll-into-view effect locates the active pill. */
  it("keys every pill so the active one can be scrolled into view", async () => {
    const { container, workspace } = await mountStrip();
    const keyed = [...container.querySelectorAll("[data-tab-key]")].map(
      (pill) => (pill as HTMLElement).dataset.tabKey,
    );
    expect(keyed).toEqual(workspace.state.tabs.map((tab) => tab.key));
  });

  it("reveals the active tab again after overflow arrows shrink the strip", async () => {
    const { container, getByRole, findByLabelText } = await mountStrip();
    const strip = container.querySelector<HTMLElement>(".az-scroll-x");
    const home = getByRole("button", { name: "Home" }).closest<HTMLElement>("[data-tab-key]");
    if (!strip || !home) throw new Error("tab strip geometry was not rendered");

    let scrollLeft = 0;
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, get: () => 200 },
      scrollWidth: { configurable: true, get: () => 400 },
      scrollLeft: {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
          scrollLeft = value;
        },
      },
    });
    strip.getBoundingClientRect = () => ({ left: 100, right: 300, width: 200 }) as DOMRect;
    home.getBoundingClientRect = () =>
      ({ left: 260 - scrollLeft, right: 330 - scrollLeft, width: 70 }) as DOMRect;

    fireEvent.scroll(strip);
    await findByLabelText("Scroll tabs right");
    await Promise.resolve();

    expect(scrollLeft).toBe(38);
  });

  /*
   * Driving the live strip, "Scroll tabs right" cycled 0 -> 11 -> 586 -> 0
   * instead of walking to the end. `nudge` was right every time; the
   * reveal-the-active-tab effect undid it.
   *
   * The effect has to re-reveal when the arrows appear, because they shrink the
   * strip (the test above). But it depended on `left` and `right` separately,
   * and those flip on their own at each end of the travel: leaving 0 turns
   * `left` on, and reaching the maximum turns `right` off. Neither changes the
   * width, so neither should move the reader back. That is why this only ever
   * bit at the two ends, and looked intermittent in between.
   */
  it("does not snap back to the active tab when a nudge reaches an end", async () => {
    const { container, getByRole, findByLabelText } = await mountStrip();
    const strip = container.querySelector<HTMLElement>(".az-scroll-x");
    const home = getByRole("button", { name: "Home" }).closest<HTMLElement>("[data-tab-key]");
    if (!strip || !home) throw new Error("tab strip geometry was not rendered");

    let scrollLeft = 0;
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, get: () => 200 },
      scrollWidth: { configurable: true, get: () => 400 },
      scrollLeft: {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
          scrollLeft = value;
        },
      },
    });
    strip.getBoundingClientRect = () => ({ left: 100, right: 300, width: 200 }) as DOMRect;
    // Fully inside the strip at rest, so settling the arrows does not scroll
    // and the signal reaches the press reading `left: false`. Revealing on the
    // way in would call `measure` itself and pre-flip the flag, which is what
    // made an earlier version of this test pass against the broken code.
    home.getBoundingClientRect = () =>
      ({ left: 150 - scrollLeft, right: 220 - scrollLeft, width: 70 }) as DOMRect;

    // Settle with the arrows already on screen, so this scenario is only about
    // travel and not about the strip changing width.
    fireEvent.scroll(strip);
    const right = await findByLabelText("Scroll tabs right");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scrollLeft).toBe(0);

    // One press is a screenful: max(180, 200 * 0.7) = 180, clamped to 200.
    // Leaving 0 turns `left` on, and that flip is what used to drag the strip
    // back onto the active tab (to 42 here) instead of leaving the reader
    // where the press put them.
    fireEvent.click(right);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scrollLeft).toBe(180);
  });
});

describe("keyboard", () => {
  /*
   * ⌃T is deliberately not a menu accelerator: the menu would consume it before
   * the webview saw it, and it would shadow transpose in every text field
   * anyway. Handled on a keydown, it fires wherever focus is — which is the
   * only way it can work while the composer has focus.
   */
  it("opens a new project on ctrl+T, from anywhere", async () => {
    const { workspace } = await mountStrip();
    expect(workspace.state.tabs.filter((tab) => tab.kind === "draft")).toHaveLength(0);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));

    await waitFor(() => {
      expect(workspace.state.tabs.filter((tab) => tab.kind === "draft")).toHaveLength(1);
      expect(workspace.activeTab().kind).toBe("draft");
    });
  });

  it("focuses the draft already open rather than stacking a second", async () => {
    const { workspace } = await mountStrip();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));
    await waitFor(() => expect(workspace.activeTab().kind).toBe("draft"));

    workspace.actions.focus("home");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));

    await waitFor(() => {
      expect(workspace.state.tabs.filter((tab) => tab.kind === "draft")).toHaveLength(1);
      expect(workspace.activeTab().kind).toBe("draft");
    });
  });

  it("ignores ctrl+shift+T, which is a different gesture", async () => {
    const { workspace } = await mountStrip();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(workspace.state.tabs.filter((tab) => tab.kind === "draft")).toHaveLength(0);
  });

  it("cycles tabs on cmd+1 and cmd+2 in Blitz", async () => {
    const globals = window as unknown as Record<string, unknown>;
    const { workspace } = await mountStrip();
    workspace.actions.focus("worktable");

    try {
      globals.__TAURI_INTERNALS__ = {};
      globals.__AGENCYZERO_BLITZ__ = true;

      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", code: "Digit2", metaKey: true, bubbles: true }),
      );
      await waitFor(() => expect(workspace.state.activeKey).toBe("cafe"));

      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "1", code: "Digit1", metaKey: true, bubbles: true }),
      );
      await waitFor(() => expect(workspace.state.activeKey).toBe("worktable"));
    } finally {
      delete globals.__AGENCYZERO_BLITZ__;
      delete globals.__TAURI_INTERNALS__;
    }
  });
});
