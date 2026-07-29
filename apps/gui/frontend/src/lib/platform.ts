/** True inside the Tauri webview; false in a plain browser (`rsbuild dev`). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
