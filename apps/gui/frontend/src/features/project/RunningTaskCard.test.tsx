import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { RunningTaskCard } from "~/features/project/ProjectPanel";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";
import type { RunningTask } from "~/types";

const TASK: RunningTask = {
  toolCallId: "tool-gh",
  projectId: "project-gh",
  itemId: null,
  name: "command_execution",
  label: "gh pr view 121 --json mergeStateStatus",
  startedAt: "2026-08-06T16:00:00.000Z",
  isCancelable: true,
};

describe("running task Stop", () => {
  it("cancels the real project run instead of calling the unimplemented per-tool command", async () => {
    let workspace!: Workspace;
    function Probe() {
      workspace = useWorkspace();
      return null;
    }
    const screen = render(() => (
      <WorkspaceProvider>
        <Probe />
        <RunningTaskCard task={TASK} now={Date.parse("2026-08-06T16:03:30.000Z")} />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    workspace.actions.cancelRun = cancelRun;

    const stop = screen.getByText("Stop") as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(screen.container).toHaveTextContent("3:30");
    fireEvent.click(stop);

    expect(cancelRun).toHaveBeenCalledWith("project-gh");
  });
});
