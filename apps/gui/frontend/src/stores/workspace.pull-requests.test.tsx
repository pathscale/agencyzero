import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

const calls = vi.hoisted(() => ({
  discover: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
}));

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  const { createMockApi } = await import("~/api/mock");

  return {
    ...actual,
    selectApi: async () => {
      const api = createMockApi();
      api.discoverPullRequests = calls.discover;
      api.refreshPullRequest = calls.refresh;
      return {
        api,
        backend: "tauri" as const,
        live: new Set(["discoverPullRequests", "refreshPullRequest"]),
      };
    },
  };
});

describe("pull-request loading", () => {
  it("does not query GitHub while hydrating the workspace", async () => {
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
    expect(calls.discover).not.toHaveBeenCalled();
    expect(calls.refresh).not.toHaveBeenCalled();
  });
});
