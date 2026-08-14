import { render, waitFor } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** The 332px column the side panel lives in, whether or not it has been filled. */
function panelBox(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".flex-none.overflow-hidden.min-h-0");
}

/*
 * The panel's contents are built a frame late on purpose: they are a flat 74 to
 * 182ms of a first reveal and they are not the conversation. Its *box* must not
 * wait with them. Deferring the box deferred its width, so the pane laid out
 * once without the panel and again with it, and the transcript sprang wide and
 * back inside a frame or two, which reads as the panel expanding and
 * collapsing.
 */
describe("the side panel's box", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("holds its width from the first frame, before its contents are built", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const screen = render(() => (
      <WorkspaceProvider>
        <Harness />
      </WorkspaceProvider>
    ));
    await waitFor(() => expect(screen.container.querySelector("[data-selectable]")).not.toBeNull());

    // Nothing has run a frame yet, which is the state the flash happened in.
    const box = panelBox(screen.container);
    expect(box, "the panel's column is missing from the first render").not.toBeNull();
    expect(box?.className).toContain("w-[332px]");
    expect(box?.childElementCount, "the panel's contents were not deferred").toBe(0);

    frames.splice(0).forEach((callback) => {
      callback(0);
    });
    await waitFor(() => expect(panelBox(screen.container)?.childElementCount).toBeGreaterThan(0));

    // Same column, still the same width: the fill must not resize anything.
    expect(panelBox(screen.container)?.className).toContain("w-[332px]");
  });
});
