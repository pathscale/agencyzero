/**
 * Make Cmd/Ctrl+C copy exactly what is highlighted.
 *
 * The app sets `user-select: none` globally (so the window drags like a native
 * one) with `data-selectable` islands opted back in. WebKit's keyboard Copy
 * command misbehaves on that layout: it expands the copied range across the
 * non-selectable surroundings, so selecting three words in the Agent I/O panel
 * and pressing Cmd+C lands a wall of text on the clipboard. The context menu's
 * Copy does not take that path, which is why right-click worked all along.
 *
 * `document.getSelection()` reflects the visible highlight, so the fix is to
 * answer the copy event ourselves with exactly that string. Text controls are
 * left alone: a textarea's selection lives inside the control, the DOM
 * selection is empty there, and the browser's own copy already does the right
 * thing.
 */
export function installSelectionCopy(): () => void {
  const onCopy = (event: ClipboardEvent) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

    const text = document.getSelection()?.toString();
    if (!text || !event.clipboardData) return;

    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
  };

  document.addEventListener("copy", onCopy);
  return () => document.removeEventListener("copy", onCopy);
}
