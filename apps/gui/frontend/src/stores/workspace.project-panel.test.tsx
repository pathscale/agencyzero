import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootWorkspace } from "~/test/reactive";
import type { ProjectPanelData } from "~/types";

const panelHarness = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  const { createMockApi } = await import("~/api/mock");
  return {
    ...actual,
    selectApi: async () => {
      const api = createMockApi();
      const read = api.getProjectPanelData.bind(api);
      panelHarness.read.mockImplementation(read);
      api.getProjectPanelData = panelHarness.read;
      return { api, backend: "tauri" as const, live: new Set<keyof typeof api>() };
    },
  };
});

beforeEach(() => {
  panelHarness.read.mockReset();
});

describe("project panel data boundary", () => {
  it("coalesces concurrent reads and reuses the project snapshot", async () => {
    const workspace = await bootWorkspace();

    const reads = await Promise.all([
      workspace.actions.loadProjectPanelData("quux"),
      workspace.actions.loadProjectPanelData("quux"),
      workspace.actions.loadProjectPanelData("quux"),
    ]);
    expect(panelHarness.read).toHaveBeenCalledTimes(1);
    expect(reads[0]).toEqual(reads[1]);

    await workspace.actions.loadProjectPanelData("quux");
    expect(panelHarness.read).toHaveBeenCalledTimes(1);
  });

  it("keeps the shared snapshot coherent after a control writes", async () => {
    const workspace = await bootWorkspace();
    await workspace.actions.loadProjectPanelData("quux");

    await workspace.actions.setProjectConcise("quux", "high");
    await workspace.actions.setProjectVerbosity("quux", "minimal");
    await workspace.actions.setCheckpoints("quux", true);

    expect(workspace.state.projectPanelData.quux).toMatchObject({
      responseVerbosity: "high",
      contextDetail: "minimal",
      checkpoints: true,
    } satisfies Partial<ProjectPanelData>);
  });
});
