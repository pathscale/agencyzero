import { describe, expect, it, vi } from "vitest";
import type { AppEvents } from "~/api";
import { windowChromeForTheme } from "~/lib/theme";
import { bootWorkspace, waitFor } from "~/test/reactive";
import type { GlobalSettings } from "~/types";

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
    const workspace = await bootWorkspace();
    await waitFor(() => expect(calls.setWindowChrome).toHaveBeenCalledTimes(1));
    expect(calls.broadcast, "nothing subscribed to settings:updated").toBeDefined();

    // Five broadcasts of the theme the window already has, which is what five
    // settled slider values look like from here.
    for (let index = 0; index < 5; index += 1) {
      calls.broadcast?.(workspace.state.settings as GlobalSettings);
    }
    await Promise.resolve();

    expect(calls.setWindowChrome).toHaveBeenCalledTimes(1);

    /*
     * The other half of the guard: it has to let a real change through.
     *
     * This could not be exercised while the window was opaque, because the
     * chrome was disabled and every theme produced the same payload. The
     * previous version of this test asserted that sameness deliberately, so
     * that turning the window transparent would fail here rather than quietly
     * leave the change path untested. It did fail, which is the point, and this
     * is the assertion it was holding the place for.
     */
    const chrome = windowChromeForTheme(workspace.state.settings!.theme);
    const recoloured = windowChromeForTheme({
      ...workspace.state.settings!.theme,
      accent: "#ff0000",
    });

    expect(chrome.enabled, "the backdrop is live now that the window is transparent").toBe(true);
    expect(
      recoloured.tint,
      "a different accent has to produce a different tint, or the guard would suppress it",
    ).not.toEqual(chrome.tint);
  });
});
