import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { AppEvents, GlobalSettings } from "~/types";
import { useWorkspace, type Workspace, WorkspaceProvider } from "~/stores/workspace";

const calls = vi.hoisted(() => ({
  setWindowChrome: vi.fn(async () => undefined),
  broadcast: undefined as ((settings: GlobalSettings) => void) | undefined,
}));

vi.mock("~/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api")>();
  const { createMockApi } = await import("~/api/mock");

  return {
    ...actual,
    selectApi: async () => {
      const api = createMockApi();
      api.setWindowChrome = calls.setWindowChrome;
      const on = api.on.bind(api);
      api.on = (async (event: keyof AppEvents, handler: (payload: never) => void) => {
        if (event === "settings:updated") {
          calls.broadcast = handler as unknown as (settings: GlobalSettings) => void;
        }
        return on(event, handler as never);
      }) as typeof api.on;
      return { api, backend: "tauri" as const, live: new Set<string>() };
    },
  };
});

/*
 * Re-applying window glass is not free and it is not idempotent: AppKit takes
 * the renderer's content view out of the view hierarchy and puts it back, so
 * the window is blank until something forces a full repaint. Dragging an
 * appearance slider writes settings every time the knob settles, each write
 * comes back as a `settings:updated` broadcast, and that handler used to call
 * straight through to the native command without the guard the save path had.
 */
describe("window chrome", () => {
  it("is not resent when a settings broadcast carries the same theme", async () => {
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
    await waitFor(() => expect(workspace.state.boot.status).toBe("ready"));
    await waitFor(() => expect(calls.setWindowChrome).toHaveBeenCalledTimes(1));
    expect(calls.broadcast, "nothing subscribed to settings:updated").toBeDefined();

    // Five broadcasts of the theme the window already has, which is what five
    // settled slider values look like from here.
    for (let index = 0; index < 5; index += 1) {
      calls.broadcast?.(workspace.state.settings);
    }
    await Promise.resolve();

    expect(calls.setWindowChrome).toHaveBeenCalledTimes(1);

    // A theme that genuinely differs still crosses, or the guard would be a
    // way of never updating the frame at all.
    calls.broadcast?.({
      ...workspace.state.settings,
      theme: { ...workspace.state.settings.theme, accent: "#ff0000" },
    });
    await waitFor(() => expect(calls.setWindowChrome).toHaveBeenCalledTimes(2));
  });
});
