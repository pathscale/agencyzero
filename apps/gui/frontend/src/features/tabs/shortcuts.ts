import { onCleanup, onMount } from "solid-js";
import { useWorkspace } from "~/stores/workspace";

/**
 * ⌘1 previous tab · ⌘2 next tab, both wrapping.
 *
 * Not ⌘[ / ⌘] — this is the binding the app is asked to use. Cycling walks
 * `state.tabs`, which is the strip's own order, so a reordered tab cycles from
 * where it now sits.
 *
 * Matched on `code` as well as `key` so a layout that puts something other
 * than "1" on the first number key still works. A native menu accelerator
 * would be the macOS-idiomatic home for this, but the app defines no menu yet
 * and that is a Rust-side change.
 */
export function useTabShortcuts(): void {
  const { actions } = useWorkspace();

  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    const isFirst = event.key === "1" || event.code === "Digit1";
    const isSecond = event.key === "2" || event.code === "Digit2";
    if (!isFirst && !isSecond) return;

    event.preventDefault();
    actions.cycleTab(isFirst ? -1 : 1);
  };

  onMount(() => window.addEventListener("keydown", onKeyDown));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));
}
