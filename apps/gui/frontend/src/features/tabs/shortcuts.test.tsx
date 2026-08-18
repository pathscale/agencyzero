import { createRoot, flush } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTabShortcuts } from "~/features/tabs/shortcuts";

/**
 * The clipboard chords, which the shipping renderer does not deliver as events.
 *
 * Blitz dispatches no `copy` or `paste` event to JS, so both are answered from
 * a plain `keydown` here. These tests drive that keydown directly, which is
 * exactly the surface the renderer does provide.
 */

const openDraft = vi.fn();
const cycleTab = vi.fn();

vi.mock("~/stores/workspace", () => ({
  useWorkspace: () => ({ actions: { openDraft, cycleTab } }),
}));

const writeText = vi.fn(() => Promise.resolve());
const readText = vi.fn(() => Promise.resolve(""));

vi.mock("~/lib/platform", () => ({ isTauri: () => false, isBlitz: () => false }));

function mount(): () => void {
  let dispose = (): void => {};
  createRoot((disposer) => {
    dispose = disposer;
    useTabShortcuts();
  });
  /*
   * The hook registers its `keydown` listener inside `onSettled`, which runs
   * once the reactive queue drains. A bare `createRoot` never drains it on its
   * own, so without this the listener was never attached and every chord in
   * this file went nowhere: the clipboard was not even read.
   */
  flush();
  return dispose;
}

/** Mounting runs `onSettled`, which is what installs the window listener. */
function press(key: string, target: EventTarget): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: `Key${key.toUpperCase()}`,
      metaKey: true,
      bubbles: true,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText },
  });
});

/**
 * Paste belongs to the renderer, and the job here is to stay out of its way.
 *
 * This file used to assert the opposite: that ⌘V was answered in JS by reading
 * `navigator.clipboard` and splicing the text into the field. Those tests
 * passed for years while pasting was broken in the real app, because jsdom is
 * given a working `navigator.clipboard` mock two screens up and the shipping
 * renderer had none. They were testing the mock.
 *
 * What actually has to hold is that Blitz's own paste — `text.rs`, the `Paste`
 * arm, which reads the shell clipboard and emits `input` itself — is allowed to
 * run. Blitz gates every default action on `is_cancelled()`, so a
 * `preventDefault` here silently disables pasting everywhere.
 */
describe("paste", () => {
  it("lets the renderer's own paste run instead of answering the chord", () => {
    const field = document.createElement("textarea");
    field.value = "hello ";
    document.body.append(field);

    const dispose = mount();
    const event = new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(event);

    /*
     * The regression guard. Blitz checks `is_cancelled()` before running the
     * default action that pastes, so cancelling here stops the paste dead —
     * which is precisely what made pasting into the composer, and into a new
     * project's prompt, do nothing at all.
     */
    expect(event.defaultPrevented).toBe(false);

    // And nothing is spliced in by hand: the renderer owns the insertion.
    expect(field.value).toBe("hello ");
    expect(readText).not.toHaveBeenCalled();

    dispose();
    field.remove();
  });

  it("does not claim the chord outside a field either", () => {
    const dispose = mount();
    const event = new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(readText).not.toHaveBeenCalled();

    dispose();
  });
});

describe("copy", () => {
  /**
   * The bug this handler exists for.
   *
   * `blitz-dom`'s `keyboard.rs` copies a document selection only
   * `if !has_focused_text_input`. The composer holds focus almost all the time,
   * so selecting a passage in the transcript and pressing ⌘C hit that guard and
   * copied nothing — the "copy from the chat area does not work" report.
   */
  it("copies a transcript selection even while a field holds focus", async () => {
    const passage = document.createElement("p");
    passage.textContent = "the selected transcript passage";
    document.body.append(passage);

    // Focused, but with no selection of its own: exactly the state that made
    // the renderer decline the copy.
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();

    const range = document.createRange();
    range.selectNodeContents(passage);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const dispose = mount();
    press("c", field);
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("the selected transcript passage"),
    );

    dispose();
    selection?.removeAllRanges();
    passage.remove();
    field.remove();
  });

  /**
   * The other half: a field with its own selection is the renderer's to copy,
   * through the same shell clipboard. Answering it here too would mean two
   * writes for one keystroke.
   */
  it("leaves a field's own selection to the renderer", () => {
    const field = document.createElement("textarea");
    field.value = "one two three";
    document.body.append(field);
    field.setSelectionRange(4, 7);

    const dispose = mount();
    press("c", field);

    expect(writeText).not.toHaveBeenCalled();

    dispose();
    field.remove();
  });
});
