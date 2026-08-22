import { render, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { describe, expect, it } from "vitest";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { prefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";
import type { Project } from "~/types";

const PROJECT: Project = {
  id: "worktable",
  name: "WorkTable",
  status: "active",
  order: 0,
  dirs: [],
  pinned: false,
  moderatorEnabled: false,
  forkedFrom: null,
  sessionId: null,
  sessions: {},
  lastActivityAt: "2026-08-07T00:00:00.000Z",
};

/**
 * The task log reads newest-first, downward.
 *
 * The store holds the backend's page verbatim and the backend sorts newest
 * first, so the newest entry is `all()[0]`. The list said the opposite in a
 * comment and paged from the tail on the strength of it, which put the *oldest*
 * rows on screen and left the newest ones unreachable behind "Show earlier".
 */
describe("the task log's order", () => {
  const mount = async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={PROJECT} agent="codex" />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
    // The panel reads the store; opening the project is what fills it.
    workspace.actions.openProject(PROJECT.id);
    return { screen, workspace: workspace as Workspace };
  };

  it("puts the newest entry at the top of the column", async () => {
    prefs.panelSections.log = true;
    const { screen, workspace } = await mount();

    const stored = () => workspace.state.taskLog.worktable ?? [];
    await waitFor(() => expect(stored().length).toBeGreaterThan(1));

    // The store's own order, straight from the backend: newest first.
    const newest = [...stored()].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];
    expect(stored()[0].id).toBe(newest.id);

    const labels = [...screen.container.querySelectorAll("[data-selectable] span[data-selectable]")]
      .map((node) => node.textContent)
      .filter(Boolean);
    expect(labels.length).toBeGreaterThan(0);
    // Whatever the page size, the first row on screen is the newest entry.
    expect(labels[0]).toBe(newest.label);
  });

  /*
   * Hydration takes one page and the badge reports the whole history, so a
   * project with more log than that has rows the panel can never reach. The
   * backend has always taken a `before` cursor; nothing sent one, so revealing
   * and scrolling both ran out early under an honest total.
   */
  it("fetches earlier entries from the server once the held page runs out", async () => {
    prefs.panelSections.log = true;
    const { workspace } = await mount();

    const held = () => workspace.state.taskLog.worktable ?? [];
    await waitFor(() => expect(held().length).toBeGreaterThan(0));

    // The fixture reports far more history than it hydrated.
    expect(workspace.state.logTotals.worktable).toBeGreaterThan(held().length);

    const before = held().length;
    const oldest = held().at(-1)?.finishedAt;
    if (!oldest) throw new Error("no entry to page from");

    await workspace.actions.loadOlderTaskLog("worktable");

    // Nothing already held was dropped or duplicated by the merge.
    const ids = held().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(held().length).toBeGreaterThanOrEqual(before);
    for (const entry of held().slice(before)) {
      expect(entry.finishedAt < oldest).toBe(true);
    }
  });
});
