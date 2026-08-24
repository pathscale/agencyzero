import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { Workspace } from "~/App";
import {
  useWorkspace,
  WorkspaceProvider,
  type Workspace as WorkspaceStore,
} from "~/stores/workspace";

let workspace!: WorkspaceStore;

function Probe() {
  workspace = useWorkspace();
  return null;
}

/** The 332px column the side panel lives in. */
function panelBox(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".flex-none.overflow-hidden.min-h-0");
}

/*
 * One side panel, pointed at whichever project is in front.
 *
 * This file has asserted three different things, which is worth recording
 * because each was wrong in a way the next one fixed.
 *
 * It began by asserting the panel's contents were *deferred* a frame while its
 * box held the width, to keep construction off the path between a keystroke and
 * the conversation. But `<Show>` does not defer work, it destroys and rebuilds
 * the subtree, so every switch that flipped the gate disposed the whole column.
 *
 * Then it asserted the contents were present from the first frame, gate
 * removed. That stopped the flashing but left the real cost: each retained
 * project tree built its *own* panel, so opening a project constructed a second
 * complete 332px column to show data the store already held.
 *
 * Now there is one active project tree and one panel, and a project switch
 * re-points both. These tests are about that: exactly one column exists no
 * matter how many projects are open, and it survives switching between them.
 */
describe("the side panel", () => {
  it("keeps the same project surface across a project tab switch", async () => {
    const screen = render(() => (
      <WorkspaceProvider>
        <Probe />
        <Workspace />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    workspace.actions.openProject("worktable");
    await waitFor(() => expect(workspace.state.activeKey).toBe("worktable"));
    const first = screen.container.querySelector<HTMLElement>("[data-active-project]");

    workspace.actions.openProject("cafe");
    await waitFor(() => expect(workspace.state.activeKey).toBe("cafe"));

    expect(
      screen.container.querySelector<HTMLElement>("[data-active-project]"),
      "the conversation surface was rebuilt by the switch",
    ).toBe(first);
    expect(first?.dataset.activeProject).toBe("cafe");
  });

  it("is one column, no matter how many projects are open", async () => {
    const screen = render(() => (
      <WorkspaceProvider>
        <Probe />
        <Workspace />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    workspace.actions.openProject("worktable");
    await waitFor(() => expect(workspace.state.activeKey).toBe("worktable"));

    const box = panelBox(screen.container);
    expect(box, "the panel's column is missing").not.toBeNull();
    expect(box?.className).toContain("w-[332px]");

    // A second project must not bring a second panel with it.
    workspace.actions.openProject("cafe");
    await waitFor(() => expect(workspace.state.activeKey).toBe("cafe"));
    expect(
      screen.container.querySelectorAll(".flex-none.overflow-hidden.min-h-0").length,
      "another project built a panel of its own",
    ).toBe(1);
  });

  it("keeps the same column across a tab switch", async () => {
    const screen = render(() => (
      <WorkspaceProvider>
        <Probe />
        <Workspace />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    workspace.actions.openProject("worktable");
    await waitFor(() => expect(workspace.state.activeKey).toBe("worktable"));
    const first = panelBox(screen.container);

    workspace.actions.openProject("cafe");
    await waitFor(() => expect(workspace.state.activeKey).toBe("cafe"));

    // The same element, not an equivalent one: identity is the whole point. A
    // rebuilt column is what the owner saw as the panel blanking and refilling.
    expect(panelBox(screen.container), "the panel was rebuilt by the switch").toBe(first);
  });

  /*
   * The panel must follow the active project, not merely survive the switch.
   *
   * The first attempt at one shared panel held the current project in a plain
   * `let` and returned it from a memo. The memo therefore handed back the same
   * object reference every time, Solid saw no change, and the panel went on
   * rendering the project it was first pointed at. Everything looked right -
   * one column, no rebuild, correct DOM - while Items, Agent I/O and the task
   * log all showed another project's data and every row action acted on it.
   *
   * Asserting identity alone is what let that through, so this asserts content.
   */
  it("re-points at the project in front", async () => {
    const screen = render(() => (
      <WorkspaceProvider>
        <Probe />
        <Workspace />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    workspace.actions.openProject("worktable");
    await waitFor(() => expect(workspace.state.activeKey).toBe("worktable"));
    const worktableItems = workspace.itemsFor("worktable").map((item) => item.title);
    await waitFor(() =>
      expect(panelBox(screen.container)?.textContent).toContain(worktableItems[0]),
    );

    workspace.actions.openProject("cafe");
    await waitFor(() => expect(workspace.state.activeKey).toBe("cafe"));

    const cafeItems = workspace.itemsFor("cafe").map((item) => item.title);
    await waitFor(() => expect(panelBox(screen.container)?.textContent).toContain(cafeItems[0]));
    expect(
      panelBox(screen.container)?.textContent,
      "the panel still shows the project it was first pointed at",
    ).not.toContain(worktableItems[0]);
  });
});
