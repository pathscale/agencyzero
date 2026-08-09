import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { prefs } from "~/stores/prefs";
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
    expect(panel.classList).toContain("overflow-y-auto");

    const items = screen.getByRole("button", { name: "Collapse Items" }).closest(".rounded-panel");
    expect(items?.classList).toContain("flex-none");
    expect(items?.className).toContain("min-h-[52px]");
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
    const context = await screen.findByLabelText("Description / sub-items");
    expect((context as HTMLTextAreaElement).value).toContain("Details / sub-items");
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

  it("edits a persistent description from the item row without starting a fork", async () => {
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

    const clickDescription = () =>
      fireEvent.click(
        screen.getAllByRole("button", {
          name: /^Edit the description for /,
        })[0],
      );
    clickDescription();
    const description = await screen.findByLabelText("Description / sub-items");
    expect((description as HTMLTextAreaElement).value).toBe("");
    fireEvent.input(description, {
      target: { value: "- [ ] Profile prompt cache\n- [ ] Verify cost" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save description" }));

    await waitFor(async () =>
      expect(await workspace.actions.getItemContext("worktable-1")).toContain(
        "Profile prompt cache",
      ),
    );
    clickDescription();
    expect(screen.queryByLabelText("Description / sub-items")).toBeNull();
    clickDescription();
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Description / sub-items") as HTMLTextAreaElement).value,
      ).toContain("Profile prompt cache"),
    );
    expect(workspace.state.projects.some((project) => project.forkedFrom?.itemId)).toBe(false);
  });

  it("keeps a dismissed item question reachable from a clear third action", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      const project = () => workspace.state.projects.find((candidate) => candidate.id === "cafe");
      return (
        <Show when={workspace.state.boot.status === "ready" && project()}>
          {(readyProject) => <ProjectPanel project={readyProject()} />}
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"), { timeout: 5_000 });
    workspace.actions.openProject("cafe");
    await waitFor(() => expect(workspace.state.questions.cafe?.[0]?.id).toBe("q-block"), {
      timeout: 5_000,
    });
    await workspace.actions.setItemStatus("cafe-0", "questions");
    await workspace.actions.answerQuestion("q-block", true);

    const replies = await screen.findAllByRole("button", {
      name: "Reply to the question for Legacy-data scan on prod snapshot",
    });
    expect(replies).toHaveLength(2);
    const reply = replies.find((button) => button.className.includes("size-[22px]"));
    expect(reply).toBeDefined();
    if (!reply) throw new Error("persistent reply action is missing");
    expect(reply.className).toContain("size-[22px]");
    expect(reply.className).toContain("border-warning/65");
    fireEvent.click(reply);

    await waitFor(() => expect(prefs.replyQuestionIds.cafe).toBe("q-block"));
  });

  it("offers to work a questions item when no tracked question exists", async () => {
    let workspace!: Workspace;

    function Gate() {
      workspace = useWorkspace();
      const project = () =>
        workspace.state.projects.find((candidate) => candidate.id === "agencyzero");
      return (
        <Show when={workspace.state.boot.status === "ready" && project()}>
          {(readyProject) => <ProjectPanel project={readyProject()} />}
        </Show>
      );
    }

    const screen = render(() => (
      <WorkspaceProvider>
        <Gate />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(workspace.state.items.agencyzero?.length).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    const send = vi.spyOn(workspace.actions, "send");
    await workspace.actions.setItemStatus("agencyzero-0", "questions");

    const work = await screen.findByRole("button", {
      name: "Work on Solid + @pathscale/ui frontend scaffold; it has no unanswered question",
    });
    expect(work.className).toContain("size-[22px]");
    fireEvent.click(work);

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls.at(-1)?.[4]).toBe("agencyzero-0");
  });
});
