import { onSettled } from "solid-js";
import { copyText } from "~/features/project/MessageBody";
import { isBlitz, isTauri } from "~/lib/platform";
import { useWorkspace } from "~/stores/workspace";

/**
 * Keyboard bindings the webview owns.
 *
 * There are two kinds, and the difference is exactly what decides whether a
 * shortcut can work inside the composer.
 *
 * **Menu accelerators** (⌘N new project, ⌘W close tab, ⌘1/⌘2 cycle) live in
 * `apps/gui/src/main.rs`. macOS resolves them through the menu bar *before* the
 * key reaches the webview, which makes them reliable and discoverable, and
 * means they shadow whatever that combination did in a text field. That is why
 * ⌃T and ⌃N were poor accelerators: macOS gives every text field an emacs-style
 * set (⌃A ⌃E ⌃B ⌃F ⌃P ⌃N ⌃K ⌃T) and an accelerator takes one away.
 *
 * **Webview bindings** (⌃T) are handled here on a plain keydown. The native
 * menu also carries the same action because AppKit may interpret Ctrl+T as its
 * standard `transpose:` command before Blitz produces a DOM keydown. WebKit's
 * keydown remains the fast path; the menu is the native fallback.
 *
 * Matched on `code` as well as `key` so a layout that puts something else on
 * that physical key still works.
 */
export function useTabShortcuts(): void {
  const { actions } = useWorkspace();

  const onKeyDown = (event: KeyboardEvent) => {
    /*
     * Cmd+C and Ctrl+C over a document selection, as a fallback.
     *
     * Blitz copies a document selection in `blitz-dom`'s `keyboard.rs`, and it
     * used to decline whenever *any* text input held focus — so a composer that
     * keeps focus, which is the normal state of this window, meant selecting a
     * passage in the transcript and pressing Cmd+C copied nothing. That is now
     * fixed in the renderer: the field keeps the keystroke only when it has a
     * selection of its own, which is the same rule applied below.
     *
     * This stays because the two move on different clocks. `apps/gui` pins a
     * published `ps-blitz`, so until the renderer fix reaches a pin, this is
     * what makes Cmd+C work in the shipping app. It is also what makes it work
     * under `bun run dev`, where the renderer is not involved at all.
     *
     * Safe to run alongside the renderer's own copy: nothing is prevented, and
     * both write the identical string to the same shell clipboard, so the worst
     * case is one redundant write rather than a wrong result.
     */
    if ((event.metaKey || event.ctrlKey) && (event.key === "c" || event.code === "KeyC")) {
      const target = event.target as HTMLElement | null;
      const field =
        target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement ? target : null;

      // The field owns the keystroke whenever it has something selected.
      if (field && (field.selectionEnd ?? 0) > (field.selectionStart ?? 0)) return;

      const selected = document.getSelection()?.toString() ?? "";
      if (selected.length > 0) void copyText(selected);
      return;
    }

    /*
     * Cmd+V and Ctrl+V are the renderer's, and taking them here was the bug.
     *
     * Blitz pastes into a focused text input itself (`text.rs`, the `Paste`
     * arm), reading the same shell clipboard `pasteText` reaches through
     * `navigator.clipboard`, then emitting the `input` event a controlled Solid
     * field needs. That is the whole job, done in one place.
     *
     * This handler used to call `preventDefault` and redo it in JS. Blitz gates
     * the default action on `is_cancelled()`, so preventing the keystroke
     * suppressed the native paste, and the JS half then had to work — leaving
     * pasting broken whenever the shell clipboard was unavailable, which it
     * always was until `blitz-shell` stopped rebuilding its `arboard` handle
     * per keystroke. Two half-implementations cancelling out is why pasting
     * into the composer and into a new project's prompt did nothing.
     *
     * So: no handler. The renderer's paste is the one that runs.
     */

    if (event.altKey || event.shiftKey) return;

    // ⌃T, the second way to open a new project. The native menu duplicates it
    // for Blitz builds where AppKit consumes the text-editing chord first.
    if (event.ctrlKey && !event.metaKey && (event.key === "t" || event.code === "KeyT")) {
      event.preventDefault();
      actions.openDraft();
      return;
    }

    /*
     * Everything below duplicates a menu accelerator, so it only does work
     * outside Tauri, under `bun run dev`, where there is no menu bar. Inside
     * the app the menu consumes these before the webview sees them; the guard
     * means a change in that behaviour cannot double-fire and silently skip a
     * tab.
     */
    if (isTauri() && !isBlitz()) return;
    if (!event.metaKey || event.ctrlKey) return;

    if (event.key === "n" || event.code === "KeyN") {
      event.preventDefault();
      actions.openDraft();
      return;
    }

    const isFirst = event.key === "1" || event.code === "Digit1";
    const isSecond = event.key === "2" || event.code === "Digit2";
    if (!isFirst && !isSecond) return;

    event.preventDefault();
    actions.cycleTab(isFirst ? -1 : 1);
  };

  onSettled(() => {
    window.addEventListener("keydown", onKeyDown);
    // Returned, not `onCleanup`: Solid 2 forbids it inside `onSettled`.
    return () => window.removeEventListener("keydown", onKeyDown);
  });
}
