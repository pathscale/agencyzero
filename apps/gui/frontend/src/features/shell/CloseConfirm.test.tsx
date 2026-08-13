import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { CloseConfirm } from "~/features/shell/CloseConfirm";

vi.mock("~/stores/workspace", () => ({
  useWorkspace: () => ({ state: { running: {}, messages: {} } }),
}));

function quitDialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(
    '[data-slot="modal-content"][aria-labelledby="close-confirm-title"]',
  );
}

function dialogButton(dialog: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Could not find dialog button: ${name}`);
  return button;
}

describe("CloseConfirm", () => {
  it("uses the PathScale modal and preserves cancel and confirm actions", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(() => <CloseConfirm isOpen quitsProxy onCancel={onCancel} onConfirm={onConfirm} />);

    await waitFor(() => expect(quitDialog()).not.toBeNull());
    const dialog = quitDialog()!;
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.querySelector("#close-confirm-title")).toHaveTextContent(
      "Quit AgencyZero and AgencyProxy?",
    );

    fireEvent.click(dialogButton(dialog, "Wait for completion"));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(dialogButton(dialog, "Quit both"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("dismisses from Escape and the backdrop", async () => {
    const onCancel = vi.fn();
    render(() => <CloseConfirm isOpen onCancel={onCancel} onConfirm={vi.fn()} />);

    await waitFor(() => expect(quitDialog()).not.toBeNull());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    const backdrop = document.body.querySelector<HTMLElement>('[data-slot="modal-backdrop"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
