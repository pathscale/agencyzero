import { render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";
import { TabStrip } from "~/features/tabs/TabStrip";
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
  setPrefs("openTabKeys", ["worktable", "cafe", "agencyzero"]);
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
    for (const label of ["Home", "WorkTable", "api.support.cafe", "agencyzero"]) {
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

    expect(getByLabelText("Close WorkTable")).toBeInTheDocument();
    expect(getByLabelText("Close api.support.cafe")).toBeInTheDocument();
    expect(getByLabelText("Close agencyzero")).toBeInTheDocument();
  });

  it("gives Home no close button, because Home is not closable", async () => {
    const { queryByLabelText } = await mountStrip();
    expect(queryByLabelText("Close Home")).toBeNull();
  });

  it("hides an inactive tab's close button without unmounting it", async () => {
    const { getByLabelText, workspace } = await mountStrip();
    workspace.actions.focus("worktable");

    await waitFor(() => {
      expect(getByLabelText("Close WorkTable").className).toContain("opacity-100");
      expect(getByLabelText("Close agencyzero").className).toContain("opacity-0");
      expect(getByLabelText("Close agencyzero").className).toContain("group-hover:opacity-100");
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
    const pill = getByLabelText("Close WorkTable").parentElement!;

    const ghost = pill.querySelector('[aria-hidden="true"].invisible');
    expect(ghost).toHaveTextContent("WorkTable");
    expect(ghost?.className).toContain("font-semibold");
  });

  it("marks only the active tab as current", async () => {
    const { container, workspace } = await mountStrip();
    workspace.actions.focus("cafe");

    await waitFor(() => {
      const current = container.querySelectorAll('[aria-current="page"]');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent("api.support.cafe");
    });
  });

  it("clicking a tab selects it", async () => {
    const { getByRole, workspace } = await mountStrip();
    getByRole("button", { name: "agencyzero" }).click();

    await waitFor(() => expect(workspace.state.activeKey).toBe("agencyzero"));
  });

  it("clicking a close button closes that tab without selecting it", async () => {
    const { getByLabelText, workspace } = await mountStrip();
    workspace.actions.focus("home");

    getByLabelText("Close agencyzero").click();

    await waitFor(() => {
      expect(workspace.state.tabs.map((tab) => tab.key)).toEqual(["home", "worktable", "cafe"]);
      expect(workspace.state.activeKey).toBe("home");
    });
  });

  it("declares the strip a window drag region", async () => {
    const { container } = await mountStrip();
    expect(container.querySelector('[data-tauri-drag-region="deep"]')).toBeTruthy();
  });

  it("keeps the close button out of the drag gesture", async () => {
    const { getByLabelText } = await mountStrip();
    expect(getByLabelText("Close WorkTable")).toHaveAttribute("data-no-drag");
  });
});

describe("overflow", () => {
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
});
