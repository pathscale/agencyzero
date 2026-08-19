import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { Workspace as WorkspaceStore } from "~/stores/workspace";
import { useWorkspace, WorkspaceProvider } from "~/stores/workspace";

/**
 * A glass axis has to come back from the store with the value it was given.
 *
 * Every existing test on this feature is self-consistent on one side of the
 * wire and therefore blind to the gap between them. The slider audit proves the
 * thumb moves; the Rust round-trip proves the struct serializes. Neither one
 * saves a value and reads it back, and the fixture theme carries no glass axis
 * at all, so a field the record cannot hold looks identical to one it can.
 *
 * That gap is how `glassBlur`, `glassRefraction` and `glassDepth` shipped
 * without persisting once, and how `glassOpacity` and `glassScrim` repeated it.
 */

const AXES = [
  ["glassBlur", 9] as const,
  ["glassRefraction", 0.22] as const,
  ["glassDepth", 17] as const,
  ["glassOpacity", 62] as const,
  ["glassScrim", 14] as const,
];

async function mountStore(): Promise<WorkspaceStore> {
  let workspace!: WorkspaceStore;
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
  return workspace;
}

describe("glass axes persist", () => {
  it.each(AXES)("keeps %s across a save", async (axis, value) => {
    const workspace = await mountStore();

    await workspace.actions.saveSettings({ theme: { [axis]: value } });

    await waitFor(() =>
      expect(
        workspace.state.settings?.theme[axis],
        `${axis} did not survive the save: the store returned it as ` +
          `${String(workspace.state.settings?.theme[axis])}`,
      ).toBe(value),
    );
  });

  /** One axis must not clear another: the merge is per-field, not per-object. */
  it("keeps every axis when they are set one at a time", async () => {
    const workspace = await mountStore();

    for (const [axis, value] of AXES) {
      await workspace.actions.saveSettings({ theme: { [axis]: value } });
    }

    for (const [axis, value] of AXES) {
      expect(workspace.state.settings?.theme[axis], `${axis} was lost`).toBe(value);
    }
  });
});
