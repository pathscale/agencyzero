import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  BootFailed,
  Booting,
  nextRetainedProjects,
  RETAINED_PROJECT_LIMIT,
  Workspace,
} from "~/App";
import { IconSprite } from "~/components/IconSprite";
import {
  useWorkspace,
  WorkspaceProvider,
  type Workspace as WorkspaceStore,
} from "~/stores/workspace";

describe("startup", () => {
  it("keeps a normal project strip and evicts only beyond the retained limit", () => {
    expect(nextRetainedProjects([], "one", ["one", "two", "three"])).toEqual(["one"]);
    expect(nextRetainedProjects(["one"], "two", ["one", "two", "three"])).toEqual(["one", "two"]);
    // Visiting a third pane evicts the oldest: the limit is what bounds the
    // hidden DOM, so the eviction has to happen at the limit, not past it.
    expect(nextRetainedProjects(["one", "two"], "three", ["one", "two", "three"])).toEqual(
      ["one", "two", "three"].slice(-RETAINED_PROJECT_LIMIT),
    );
    const open = Array.from(
      { length: RETAINED_PROJECT_LIMIT + 1 },
      (_, index) => `project-${index}`,
    );
    expect(
      nextRetainedProjects(open.slice(0, RETAINED_PROJECT_LIMIT), open.at(-1) ?? null, open),
    ).toEqual(open.slice(1));
    // Retention covers the pane in front of you and the one you came from.
    // Raising this raises hidden DOM roughly linearly, about a thousand nodes
    // per pane against the live app.
    expect(RETAINED_PROJECT_LIMIT).toBe(2);
  });

  it("retains Home, Settings, and the most recent projects up to the limit", async () => {
    let workspace!: WorkspaceStore;

    function Probe() {
      workspace = useWorkspace();
      return null;
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Probe />
        <Workspace />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    workspace.actions.openProject("worktable");
    await waitFor(() => expect(workspace.state.activeKey).toBe("worktable"));
    workspace.actions.openProject("cafe");
    await waitFor(() => expect(workspace.state.activeKey).toBe("cafe"));
    workspace.actions.openProject("quux");
    await waitFor(() => expect(workspace.state.activeKey).toBe("quux"));

    const retained = Array.from(
      screen.container.querySelectorAll<HTMLElement>("[data-retained-project]"),
    ).map((node) => node.dataset.retainedProject);
    // Three visited, and only the most recent `RETAINED_PROJECT_LIMIT` keep
    // their DOM. The evicted pane is gone from the tree, not merely hidden:
    // that eviction is the whole point of the limit.
    expect(retained).toEqual(["worktable", "cafe", "quux"].slice(-RETAINED_PROJECT_LIMIT));
    expect(screen.container.querySelector('[data-retained-tab="home"]')).not.toBeNull();
    const settings = screen.container.querySelector<HTMLElement>('[data-retained-tab="settings"]');
    expect(settings).not.toBeNull();
    expect(settings?.getAttribute("aria-hidden")).toBe("true");

    workspace.actions.openSettings();
    await waitFor(() => expect(workspace.state.activeKey).toBe("settings"));
    expect(settings?.getAttribute("aria-hidden")).toBe("false");
  });

  it("shows a branded workspace splash while hydration is in progress", () => {
    const screen = render(() => (
      <>
        <IconSprite />
        <Booting />
      </>
    ));

    expect(screen.getByRole("status", { name: "Loading workspace…" })).toBeTruthy();
    expect(screen.getByText("AgencyZero")).toBeTruthy();
  });

  it("offers Settings as a recovery route when workspace boot fails", () => {
    const openSettings = vi.fn();
    const screen = render(() => (
      <BootFailed
        message="AgencyProxy unavailable"
        onRetry={() => {}}
        onOpenSettings={openSettings}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
