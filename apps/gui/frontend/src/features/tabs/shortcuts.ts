import { onCleanup, onSettled } from "solid-js";
import { copyText, pasteText } from "~/features/project/MessageBody";
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
     * Cmd+C and Ctrl+C, served here rather than left to the Edit menu.
     *
     * The menu carries a predefined Copy and it still came back empty, so the
     * keystroke is answered directly: read what is selected, write it to the
     * clipboard. Nothing is prevented, so if the native copy does work it puts
     * the same text there and this costs nothing.
     *
     * Fields are included, and skipping them was a bug. The reasoning was that
     * a text field's own copy is already correct, but the native route is the
     * one that was broken in the first place, so deferring to it inside the
     * composer meant copying out of the prompt box silently did nothing. A
     * field also keeps its selection in `selectionStart`/`selectionEnd` rather
     * than in the document selection, so it needs reading a different way.
     */
    if ((event.metaKey || event.ctrlKey) && (event.key === "c" || event.code === "KeyC")) {
      const target = event.target as HTMLElement | null;
      const field =
        target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement ? target : null;

      if (field) {
        const from = field.selectionStart ?? 0;
        const to = field.selectionEnd ?? 0;
        if (to > from) {
          void copyText(field.value.slice(from, to)).then(() => {
            // The fallback borrows focus and the selection to do its work, so
            // both are put back. Otherwise copying inside the composer would
            // drop the cursor and lose the highlight that was just copied.
            field.focus();
            field.setSelectionRange(from, to);
          });
        }
        return;
      }

      const selected = document.getSelection()?.toString() ?? "";
      if (selected.length > 0) void copyText(selected);
      return;
    }

    /*
     * Cmd+V and Ctrl+V into a text field, for the same reason Copy is here.
     *
     * Blitz dispatches no `paste` event to JS, and answers the chord itself
     * only for a focused native text input. That covers the composer, so this
     * is not where pasting into it comes from — but the native route writes
     * straight into the editor's own buffer, and a controlled Solid field then
     * holds a `value` the DOM no longer matches. Answering it here keeps the
     * signal and the element in step.
     *
     * Only fields. A paste with nothing focused to receive it has no meaning,
     * and reading the clipboard to discard it would be a permission prompt for
     * nothing.
     */
    if ((event.metaKey || event.ctrlKey) && (event.key === "v" || event.code === "KeyV")) {
      const target = event.target as HTMLElement | null;
      const field =
        target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement ? target : null;
      if (!field || field.readOnly || field.disabled) return;

      // Prevent the native insert, so text cannot land twice when the renderer
      // also handles the chord.
      event.preventDefault();

      const from = field.selectionStart ?? field.value.length;
      const to = field.selectionEnd ?? from;
      void pasteText().then((text) => {
        if (text === null || text.length === 0) return;
        field.value = `${field.value.slice(0, from)}${text}${field.value.slice(to)}`;
        const caret = from + text.length;
        field.setSelectionRange(caret, caret);
        // A controlled field takes its value from a signal that only an `input`
        // event updates. Without this the character count, the autosize and the
        // submitted text all keep the value from before the paste.
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      return;
    }

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
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });
}
