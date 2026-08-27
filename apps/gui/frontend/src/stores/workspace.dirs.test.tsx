import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { SETTINGS } from "~/api/fixtures";
import { setPrefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

/*
 * The directory list is the owner's evidence that a permission grant landed.
 * These tests deliberately drop `project:updated` so the only thing that can
 * update the panel is the row the command itself returned. Keeping the event
 * would let a store that discards that row still pass, which is exactly the
 * regression being locked out: the folder is persisted, the panel keeps
 * rendering the list from before the add, and the attachment reads as failed.
 */
vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  const { createMockApi } = await import("~/api/mock");

  return {
    ...actual,
    selectApi: async () => {
      const api = createMockApi();
      const on = api.on.bind(api);
      api.on = ((event: string, handler: unknown) =>
        event === "project:updated"
          ? Promise.resolve(() => undefined)
          : on(event as never, handler as never)) as typeof api.on;
      return { api, backend: "tauri" as const, live: new Set<string>() };
    },
  };
});

async function boot(): Promise<Workspace> {
  SETTINGS.workspaceTabs = null;
  setPrefs((d) => {
    d.openTabKeys = ["cafe"];
  });
  let workspace!: Workspace;

  function Probe() {
    workspace = useWorkspace();
    return null;
  }

  render(() => (
    <WorkspaceProvider>
      <Probe />
    </WorkspaceProvider>
  ));

  await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
  return workspace;
}

const dirsOf = (workspace: Workspace, id: string): string[] =>
  workspace.state.projects.find((project) => project.id === id)?.dirs ?? [];

describe("attaching a working directory", () => {
  it("shows the directory without waiting for the update event", async () => {
    const workspace = await boot();
    expect(dirsOf(workspace, "cafe")).not.toContain("~/src/attached");

    await workspace.actions.addDir("cafe", "~/src/attached");

    expect(dirsOf(workspace, "cafe")).toContain("~/src/attached");
  });

  it("removes the directory without waiting for the update event", async () => {
    const workspace = await boot();
    await workspace.actions.addDir("cafe", "~/src/attached");
    expect(dirsOf(workspace, "cafe")).toContain("~/src/attached");

    await workspace.actions.removeDir("cafe", "~/src/attached");

    expect(dirsOf(workspace, "cafe")).not.toContain("~/src/attached");
  });
});
