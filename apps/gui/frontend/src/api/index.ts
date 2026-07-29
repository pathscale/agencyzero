import { isTauri } from "~/lib/platform";
import type { AgencyZeroApi } from "./client";
import { createMockApi } from "./mock";
import { createTauriApi } from "./tauri";

export type { AgencyZeroApi, AppEvent, AppEvents, TaskLogPage, Unlisten } from "./client";

/**
 * Tauri answers an `invoke` for a command it does not have with a
 * "not found" error. That is the *only* failure that means "Rust has not
 * implemented this yet"; everything else — a database that would not open, a
 * capability rejection, a serde mismatch, a panic — means the backend is
 * present and broken.
 */
function isCommandMissing(error: unknown): boolean {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return /not found|unknown command|command .* is not/i.test(text);
}

export type BackendChoice = { api: AgencyZeroApi; backend: "tauri" | "mock" };

/**
 * Picks a backend once, at startup.
 *
 * Outside Tauri there is nothing to talk to, so it is the mock. Inside Tauri it
 * probes with `get_settings` and the distinction matters: an unimplemented
 * command falls back to fixtures, and **any other failure is thrown**.
 *
 * Falling back on every error would be fail-open — a broken database or a
 * rejected capability would leave the window fully interactive, writing to
 * ephemeral fixture state behind an unobtrusive banner, with the user believing
 * their projects were saved. Better to refuse to start and say why.
 *
 * The day Rust implements the commands, the probe succeeds and the app switches
 * over with no other change.
 */
export async function selectApi(): Promise<BackendChoice> {
  if (!isTauri()) return { api: createMockApi(), backend: "mock" };

  const tauri = createTauriApi();
  try {
    await tauri.getSettings();
    return { api: tauri, backend: "tauri" };
  } catch (error) {
    if (!isCommandMissing(error)) throw error;

    // biome-ignore lint/suspicious/noConsole: the backend in use is worth stating plainly.
    console.warn("[agencyzero] Rust commands not implemented, serving design fixtures:", error);
    return { api: createMockApi(), backend: "mock" };
  }
}
