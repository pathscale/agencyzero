import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { describe, expect, it } from "vitest";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";
import type { Project } from "~/types";

const PROJECT: Project = {
  id: "panel-scroll",
  name: "Panel scroll",
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

describe("the project side panel", () => {
  it("fills its clipped shell so the panel owns a bounded scroll area", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <div data-testid="shell" class="h-[320px] overflow-hidden">
            <ProjectPanel project={PROJECT} />
          </div>
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    const panel = screen.getByTestId("shell").firstElementChild as HTMLElement;
    expect(panel.classList).toContain("h-full");
    expect(panel.classList).toContain("az-scroll");
    expect(panel.classList).toContain("min-h-0");
  });

  it("keeps the lower-token fork action visible without waiting for hover", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={{ ...PROJECT, id: "worktable" }} />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    const fork = screen.getAllByLabelText(/Fork .* into a fresh chat/)[0];
    expect(fork.classList).not.toContain("opacity-0");
    expect(fork.getAttribute("title")).toContain("avoid resending");
  });

  it("shows editable item context before creating a fresh fork", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      return (
        <Show when={workspace.state.boot.status === "ready"}>
          <ProjectPanel project={{ ...PROJECT, id: "worktable" }} />
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });

    fireEvent.click(screen.getAllByLabelText(/Fork .* into a fresh chat/)[0]);
    const context = await screen.findByLabelText("Item context");
    fireEvent.input(context, {
      target: { value: "Preserve the owner decision and run the focused tests." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start fork" }));

    await waitFor(() =>
      expect(workspace.state.projects.some((project) => project.forkedFrom?.itemId)).toBe(true),
    );
    const fork = workspace.state.projects.find((project) => project.forkedFrom?.itemId);
    expect(fork).toBeDefined();
    expect(await workspace.actions.getItemContext(fork?.forkedFrom?.itemId ?? "missing")).toContain(
      "owner decision",
    );
  });
});
