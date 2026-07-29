/**
 * True inside the Tauri webview; false in a plain browser (`rsbuild dev`).
 *
 * `__TAURI_INTERNALS__` is the signal Tauri v2 always injects. `__TAURI__` only
 * exists when `withGlobalTauri` is on, which this app deliberately leaves off —
 * it imports the API through modules and does not need the global surface — so
 * it cannot be the primary check. Both are tested so the answer stays right if
 * that setting ever changes.
 */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}
