import { render, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { describe, expect, it } from "vitest";
import { ProjectTab } from "~/features/project/ProjectTab";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";
import type { Tab } from "~/types";

let workspace!: Workspace;

const TAB: Tab = {
  key: "proj-cafe",
  kind: "project",
  projectId: "cafe",
  label: "cafe",
  agent: "claude",
  model: "sonnet",
  effort: "medium",
  extraThinking: true,
  permission: "read_only",
  status: "quiet",
};

function Harness() {
  workspace = useWorkspace();
  const project = () => workspace.state.projects.find((candidate) => candidate.id === "cafe");

  return (
    <Show when={workspace.state.boot.status === "ready" && project()}>
      {(readyProject) => <ProjectTab tab={TAB} project={readyProject()} />}
    </Show>
  );
}

/** The 332px column the side panel lives in. */
function panelBox(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".flex-none.overflow-hidden.min-h-0");
}

/*
 * The panel is built with the pane, not a frame after it.
 *
 * This used to assert the opposite: the contents were gated on
 * `<Show when={panelReady()}>` and filled in on the next animation frame, to
 * keep their construction off the path between a keystroke and the
 * conversation appearing. The cost was real but `<Show>` does not defer work,
 * it destroys and rebuilds the subtree, so every tab switch that flipped the
 * gate disposed the whole column and built it again. That is what the owner
 * saw as the panel blanking and repopulating, and no amount of remembering
 * which projects had already been revealed fixed it, because the gate itself
 * was the problem.
 *
 * The panel is now a plain child hidden by a class, like the transcript and the
 * composer, so a switch swaps content instead of reconstructing a column. The
 * box's width still matters for the same reason it always did: if it were to
 * appear late the pane would lay out once without it and again with it, and the
 * transcript would spring wide and back.
 */
describe("the side panel's box", () => {
  it("is present with its contents from the first frame", async () => {
    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    const box = panelBox(screen.container);
    expect(box, "the panel's column is missing from the first render").not.toBeNull();
    expect(box?.className).toContain("w-[332px]");
    // The contents, in the same frame as the box. No animation frame is stubbed
    // or pumped here: if this ever needs one again, the gate is back.
    expect(
      box?.childElementCount,
      "the panel's contents are not built with the pane",
    ).toBeGreaterThan(0);
  });
});
