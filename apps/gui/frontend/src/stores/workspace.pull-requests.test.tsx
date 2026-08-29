import { describe, expect, it, vi } from "vitest";
import { SETTINGS } from "~/api/fixtures";
import { setPrefs } from "~/stores/prefs";
import { bootWorkspace } from "~/test/reactive";

const calls = vi.hoisted(() => ({
  discover: vi.fn(async () => undefined),
  listMessages: vi.fn(),
  refresh: vi.fn(async () => undefined),
}));

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  const { createMockApi } = await import("~/api/mock");

  return {
    ...actual,
    selectApi: async () => {
      const api = createMockApi();
      calls.listMessages.mockImplementation(api.listMessages.bind(api));
      api.listMessages = calls.listMessages;
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
    SETTINGS.workspaceTabs = null;
    setPrefs((d) => {
      d.openTabKeys = ["cafe"];
    });
    await bootWorkspace();
    expect(calls.discover).not.toHaveBeenCalled();
    expect(calls.refresh).not.toHaveBeenCalled();
    expect(calls.listMessages.mock.calls.map(([projectId]) => projectId)).toEqual([
      "home-task-manager",
    ]);
  });
});
