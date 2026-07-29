import { onCleanup, onMount } from "solid-js";
import { isTauri } from "~/lib/platform";
import { useWorkspace } from "~/stores/workspace";

/**
 * ⌃T new project · ⌘1 previous tab · ⌘2 next tab — **outside Tauri only**.
 *
 * In the app these are native menu accelerators (see `apps/gui/src/main.rs`),
 * which macOS delivers whatever has focus and which show up in the menu bar
 * where a keybinding is discoverable. Running the frontend in a browser has no
 * menu bar, so this stands in.
 *
 * Gated rather than always-on: a menu accelerator is consumed by the menu and
 * never reaches the webview today, but that is macOS behaviour to rely on, not
 * a guarantee, and a double-fire would silently skip a tab.
 *
 * Matched on `code` as well as `key` so a layout that puts something other
 * than "1" on the first number key still works.
 */
export function useTabShortcuts(): void {
  const { actions } = useWorkspace();

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.shiftKey) return;

    // Ctrl+T, not Cmd+T. A browser takes this for its own new tab before the
    // page sees it, so in practice this branch only fires in environments that
    // do not — the app itself uses the menu accelerator.
    if (event.ctrlKey && !event.metaKey && (event.key === "t" || event.code === "KeyT")) {
      event.preventDefault();
      actions.openDraft();
      return;
    }

    if (!event.metaKey || event.ctrlKey) return;

    const isFirst = event.key === "1" || event.code === "Digit1";
    const isSecond = event.key === "2" || event.code === "Digit2";
    if (!isFirst && !isSecond) return;

    event.preventDefault();
    actions.cycleTab(isFirst ? -1 : 1);
  };

  onMount(() => {
    if (isTauri()) return;
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });
}
