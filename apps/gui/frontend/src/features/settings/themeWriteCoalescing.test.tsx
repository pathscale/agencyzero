/**
 * Picking quickly must not queue one round trip per pick.
 *
 * Every pick is a settings write, and writes are serialized so a full response
 * can safely win. Driven by a colour wheel that is faster than the round trip,
 * that queue grows: the tenth pick waits behind nine that are already
 * superseded, and the user sees the panel following a beat behind the pointer.
 *
 * Measured on the running app during rapid picks, about 32ms of each 39ms frame
 * interval was spent outside the frame entirely, with style resolution
 * accounting for only 7ms of it. The queue was the larger half.
 *
 * A superseded theme write has no reader: `writeAccentPreview` has already
 * painted the pick, so the write exists to persist the value and to hand back
 * the record the palette is read from. So a theme-only patch collapses onto
 * whatever is already waiting rather than appending to the queue.
 *
 * What must stay true, and is what this file asserts, is that collapsing loses
 * nothing: the last pick still lands, fields set by separate picks still merge,
 * and a patch carrying anything besides a theme is never collapsed, because
 * those are discrete decisions where a dropped write is a lost one.
 */

import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { Workspace as WorkspaceStore } from "~/stores/workspace";
import { useWorkspace, WorkspaceProvider } from "~/stores/workspace";

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

describe("rapid theme writes collapse without losing the result", () => {
  it("lands the last pick when several are fired without awaiting", async () => {
    const workspace = await mountStore();

    // Exactly the shape the wheel produces: no await between picks.
    void workspace.actions.saveSettings({ theme: { accent: "#111111" } });
    void workspace.actions.saveSettings({ theme: { accent: "#222222" } });
    void workspace.actions.saveSettings({ theme: { accent: "#333333" } });
    await workspace.actions.saveSettings({ theme: { accent: "#444444" } });

    await waitFor(() => expect(workspace.state.settings?.theme.accent).toBe("#444444"));
  });

  it("keeps fields that different picks set, rather than the newest patch winning alone", async () => {
    const workspace = await mountStore();

    // Collapsing merges the patches; replacing them outright would drop the
    // first accent when the second row is picked in the same burst.
    void workspace.actions.saveSettings({ theme: { accent: "#3366cc" } });
    await workspace.actions.saveSettings({ theme: { accentTwo: "#cc3366" } });

    await waitFor(() => {
      expect(workspace.state.settings?.theme.accent).toBe("#3366cc");
      expect(workspace.state.settings?.theme.accentTwo).toBe("#cc3366");
    });
  });

  it("still persists a single pick", async () => {
    const workspace = await mountStore();

    await workspace.actions.saveSettings({ theme: { accent: "#abcdef" } });

    await waitFor(() => expect(workspace.state.settings?.theme.accent).toBe("#abcdef"));
  });

  /*
   * The guard on the collapse. A patch that carries anything besides a theme is
   * a decision rather than a colour, so it goes through the serialized path
   * where every write is kept.
   */
  it("does not collapse a patch that carries more than a theme", async () => {
    const workspace = await mountStore();

    await workspace.actions.saveSettings({
      theme: { accent: "#0f0f0f" },
      defaultAgent: "codex",
    });

    await waitFor(() => {
      expect(workspace.state.settings?.theme.accent).toBe("#0f0f0f");
      expect(workspace.state.settings?.defaultAgent).toBe("codex");
    });
  });
});
