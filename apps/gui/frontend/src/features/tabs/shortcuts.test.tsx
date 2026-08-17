import { createRoot } from "solid-js";
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

describe("paste", () => {
  it("inserts the clipboard at the caret and tells the field it changed", async () => {
    readText.mockResolvedValueOnce("world");
    const field = document.createElement("textarea");
    field.value = "hello ";
    field.setSelectionRange(6, 6);
    document.body.append(field);
    const onInput = vi.fn();
    field.addEventListener("input", onInput);

    const dispose = mount();
    press("v", field);
    await vi.waitFor(() => expect(field.value).toBe("hello world"));

    // A controlled Solid field reads its value from a signal that only an
    // `input` event updates, so without this the paste is invisible to the app.
    expect(onInput).toHaveBeenCalled();
    expect(field.selectionStart).toBe("hello world".length);

    dispose();
    field.remove();
  });

  it("replaces the selection rather than inserting beside it", async () => {
    readText.mockResolvedValueOnce("there");
    const field = document.createElement("input");
    field.value = "hi world";
    field.setSelectionRange(3, 8);
    document.body.append(field);

    const dispose = mount();
    press("v", field);
    await vi.waitFor(() => expect(field.value).toBe("hi there"));

    dispose();
    field.remove();
  });

  it("leaves a read-only field alone and never reads the clipboard for it", () => {
    const field = document.createElement("textarea");
    field.value = "untouched";
    field.readOnly = true;
    document.body.append(field);

    const dispose = mount();
    press("v", field);

    expect(readText).not.toHaveBeenCalled();
    expect(field.value).toBe("untouched");

    dispose();
    field.remove();
  });

  it("does not read the clipboard when the paste lands outside a field", () => {
    const dispose = mount();
    press("v", document.body);

    expect(readText).not.toHaveBeenCalled();

    dispose();
  });

  it("keeps the field's text when the clipboard is refused", async () => {
    readText.mockRejectedValueOnce(new Error("denied"));
    const field = document.createElement("textarea");
    field.value = "kept";
    document.body.append(field);

    const dispose = mount();
    press("v", field);
    await vi.waitFor(() => expect(readText).toHaveBeenCalled());

    expect(field.value).toBe("kept");

    dispose();
    field.remove();
  });
});

describe("copy", () => {
  it("copies a field's selection rather than the whole value", async () => {
    const field = document.createElement("textarea");
    field.value = "one two three";
    field.setSelectionRange(4, 7);
    document.body.append(field);

    const dispose = mount();
    press("c", field);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("two"));

    dispose();
    field.remove();
  });
});
