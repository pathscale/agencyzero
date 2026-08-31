import { flush } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS } from "~/api/fixtures";
import { setPrefs } from "~/stores/prefs";
import type { Workspace } from "~/stores/workspace";
import { bootWorkspace, waitFor } from "~/test/reactive";

const compactHarness = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  compact: vi.fn(),
}));

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  const { createMockApi } = await import("~/api/mock");

  return {
    ...actual,
    selectApi: async () => {
      const api = createMockApi();
      const originalOn = api.on.bind(api);
      api.on = async (event, handler) => {
        compactHarness.handlers.set(event, handler as (payload: unknown) => void);
        return originalOn(event, handler);
      };
      api.compactProject = compactHarness.compact;
      return {
        api,
        backend: "tauri" as const,
        live: new Set<keyof typeof api>(["compactProject"]),
      };
    },
  };
});

async function mountWorkspace(): Promise<Workspace> {
  return bootWorkspace();
}

function stopRun(): void {
  compactHarness.handlers.get("run:stopped")?.({
    projectId: "quux",
    agent: "claude",
    model: "claude-opus-5",
    permission: "auto",
    stop: "finished",
    exitCode: 0,
  });
  compactHarness.handlers.get("run:slot_released")?.({ projectId: "quux" });
}

beforeEach(() => {
  compactHarness.handlers.clear();
  compactHarness.compact.mockReset();
  SETTINGS.workspaceTabs = null;
  setPrefs((d) => {
    d.lastTabKey = "quux";
  });
  setPrefs((d) => {
    d.openTabKeys = ["quux"];
  });
});

describe("a compaction asked for while the project is busy", () => {
  it("is held rather than refused, and runs when the slot frees", async () => {
    compactHarness.compact.mockRejectedValueOnce(
      new Error("a run is already active in this project — let it finish first"),
    );
    compactHarness.compact.mockResolvedValue(undefined);
    const workspace = await mountWorkspace();

    await expect(workspace.actions.compactProject("quux", "claude")).resolves.toBeUndefined();
    flush();
    expect(workspace.state.pendingCompact.quux).toBe("claude");

    stopRun();

    await waitFor(() => expect(compactHarness.compact).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    });
    expect(workspace.state.pendingCompact.quux).toBeUndefined();
  });

  it("holds one compaction however many times the button is pressed", async () => {
    compactHarness.compact.mockRejectedValue(
      new Error("a run is already active in this project — let it finish first"),
    );
    const workspace = await mountWorkspace();

    await workspace.actions.compactProject("quux", "claude");
    await workspace.actions.compactProject("quux", "claude");
    await workspace.actions.compactProject("quux", "claude");
    flush();

    expect(workspace.state.pendingCompact.quux).toBe("claude");
    expect(compactHarness.compact).toHaveBeenCalledTimes(3);

    stopRun();

    // Three presses, one compaction: the fourth call is the flush, not a
    // backlog of three replayed in a row.
    await waitFor(() => expect(compactHarness.compact).toHaveBeenCalledTimes(4), {
      timeout: 2_000,
    });
  });

  it("can be waved away before the run ends", async () => {
    compactHarness.compact.mockRejectedValue(
      new Error("a run is already active in this project — let it finish first"),
    );
    const workspace = await mountWorkspace();

    await workspace.actions.compactProject("quux", "claude");
    flush();
    expect(workspace.state.pendingCompact.quux).toBe("claude");

    workspace.actions.dropPendingCompact("quux");
    flush();
    expect(workspace.state.pendingCompact.quux).toBeUndefined();

    stopRun();

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(compactHarness.compact).toHaveBeenCalledTimes(1);
  });

  it("still raises a refusal it cannot name", async () => {
    compactHarness.compact.mockRejectedValue(new Error("no agent session to compact"));
    const workspace = await mountWorkspace();

    await expect(workspace.actions.compactProject("quux", "claude")).rejects.toThrow(
      "no agent session to compact",
    );
    expect(workspace.state.pendingCompact.quux).toBeUndefined();
  });
});
