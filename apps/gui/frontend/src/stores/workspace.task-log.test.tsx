import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { SETTINGS } from "~/api/fixtures";
import { setPrefs } from "~/stores/prefs";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";
import type { TaskLogEntry } from "~/types";

/** Ninety entries, newest first, one minute apart - more than one page holds. */
const HISTORY: TaskLogEntry[] = Array.from({ length: 90 }, (_, index) => ({
  id: `cafe-log-${index}`,
  toolCallId: null,
  projectId: "cafe",
  itemId: null,
  label: `entry ${index}`,
  tool: "Bash",
  ok: true,
  output: "",
  durationMs: 10,
  exitCode: 0,
  finishedAt: new Date(Date.UTC(2026, 7, 22, 12, 0, 0) - index * 60_000).toISOString(),
}));

const calls = vi.hoisted(() => ({ listTaskLog: vi.fn() }));

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  const { createMockApi } = await import("~/api/mock");

  return {
    ...actual,
    selectApi: async () => {
      const api = createMockApi();
      api.listTaskLog = calls.listTaskLog;
      return { api, backend: "tauri" as const, live: new Set<never>() };
    },
  };
});

/**
 * The task log pages from the server, not just from what boot happened to hold.
 *
 * Hydration takes one page while the badge reports the whole history, so every
 * entry past that page was unreachable: the reveal control and the scroll
 * handler both stopped at the end of the store. The backend has accepted a
 * `before` cursor from the start and nothing ever sent one.
 */
describe("paging the task log", () => {
  it("asks for entries strictly older than the last one held", async () => {
    // Newest-first, cut at the cursor: what the Rust `page_task_log` does.
    calls.listTaskLog.mockImplementation(
      async (_projectId: string, limit: number, before?: string) => {
        const rows = before ? HISTORY.filter((entry) => entry.finishedAt < before) : HISTORY;
        return { entries: rows.slice(0, limit), total: HISTORY.length };
      },
    );
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

    const held = () => workspace.state.taskLog.cafe ?? [];
    await waitFor(() => expect(held().length).toBeGreaterThan(0));

    // One page in hand, and the badge honestly reporting the rest.
    const firstPage = held().length;
    expect(firstPage).toBeLessThan(HISTORY.length);
    expect(workspace.state.logTotals.cafe).toBe(HISTORY.length);

    const oldest = held().at(-1)?.finishedAt;
    if (!oldest) throw new Error("no cursor to page from");
    await workspace.actions.loadOlderTaskLog("cafe");

    // The request carried the cursor, and the page that came back is older.
    expect(calls.listTaskLog.mock.calls.at(-1)?.[2]).toBe(oldest);
    expect(held().length).toBeGreaterThan(firstPage);
    for (const entry of held().slice(firstPage)) {
      expect(entry.finishedAt < oldest).toBe(true);
    }

    // Still newest-first, and no row served twice across the seam.
    const ids = held().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const times = held().map((entry) => entry.finishedAt);
    expect([...times].sort((a, b) => b.localeCompare(a))).toEqual(times);
  });

  it("stops asking once the whole history is held", async () => {
    calls.listTaskLog.mockImplementation(async () => ({
      entries: HISTORY.slice(0, 2),
      total: 2,
    }));
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
    await waitFor(() => expect((workspace.state.taskLog.cafe ?? []).length).toBe(2));

    calls.listTaskLog.mockClear();
    await workspace.actions.loadOlderTaskLog("cafe");
    // Everything the server has is already on screen; asking again is a wasted
    // round trip on every scroll to the bottom.
    expect(calls.listTaskLog).not.toHaveBeenCalled();
  });
});
