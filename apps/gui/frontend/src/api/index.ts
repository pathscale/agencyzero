import type { AgencyZeroApi } from "./client";
import { createMockApi } from "./mock";
import { createTauriApi } from "./tauri";

export type { AgencyZeroApi, AppEvent, AppEvents, TaskLogPage, Unlisten } from "./client";

/** True inside the Tauri webview; false in a plain browser (`rsbuild dev`). */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Picks a backend once, at startup.
 *
 * Outside Tauri there is nothing to talk to, so it is the mock. Inside Tauri it
 * probes with `get_settings`: the commands in `design/data-model.html` are not
 * implemented yet, so today that throws and we fall back — with a warning, so a
 * *real* backend failure never passes silently as "running on fixtures".
 *
 * The day Rust implements them, the probe succeeds and the app switches over
 * with no other change.
 */
export async function selectApi(): Promise<{ api: AgencyZeroApi; backend: "tauri" | "mock" }> {
  if (!inTauri()) return { api: createMockApi(), backend: "mock" };

  const tauri = createTauriApi();
  try {
    await tauri.getSettings();
    return { api: tauri, backend: "tauri" };
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: the backend in use is worth stating plainly.
    console.warn("[agencyzero] Rust commands unavailable, serving design fixtures instead:", error);
    return { api: createMockApi(), backend: "mock" };
  }
}
