import { fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { EditableTitle } from "~/components/EditableTitle";
import { IconSprite } from "~/components/IconSprite";

/**
 * The pencil is the one control the owner has for correcting a derived name,
 * and it was dead in the running app on two separate surfaces - the project
 * header and every row on Home - while the unit suite had nothing to say about
 * it, because there was no unit suite for this component at all.
 *
 * Measured against a live instance at 1421 nodes: two visible textboxes before
 * the click and two after, on a fresh profile, with the click acknowledged in
 * 0.36ms. `setDraft` had run (the field held the project's name) and
 * `setEditing` had not taken effect, so the editor never appeared.
 *
 * These assert the swap itself rather than the styling around it: what matters
 * is that pressing the pencil puts an editable field in front of the user and
 * takes the read-only name away.
 *
 * They drive `click`, matching the standard button interaction used after the
 * Home row stopped owning nested pointer gestures. Note what this file cannot
 * see: jsdom dispatches straight at the node it is handed and has no
 * hit-testing, layout, or renderer. The ps-qa rename outcome is authoritative.
 */
describe("the editable title", () => {
  const setup = (onRename = vi.fn().mockResolvedValue(undefined)) => {
    const screen = render(() => (
      <>
        <IconSprite />
        <EditableTitle value="derived name" onRename={onRename} />
      </>
    ));
    return { screen, onRename };
  };

  const hidden = (element: HTMLElement): boolean => Boolean(element.closest(".hidden"));

  it("shows the field and hides the name when the pencil is pressed", () => {
    const { screen } = setup();
    const pencil = screen.getByLabelText("Rename derived name") as HTMLElement;
    const field = screen.getByLabelText("Project name") as HTMLElement;

    expect(hidden(field)).toBe(true);
    expect(hidden(pencil)).toBe(false);

    fireEvent.click(pencil);
    flush();

    expect(hidden(field)).toBe(false);
    expect(hidden(pencil)).toBe(true);
  });

  it("starts the draft from the current name", () => {
    const { screen } = setup();

    fireEvent.click(screen.getByLabelText("Rename derived name"));
    flush();

    const field = screen.getByLabelText("Project name") as HTMLInputElement;
    expect(field.value).toBe("derived name");
  });

  it("commits an edited name on Enter", async () => {
    const { screen, onRename } = setup();
    fireEvent.click(screen.getByLabelText("Rename derived name"));
    flush();

    const field = screen.getByLabelText("Project name") as HTMLInputElement;
    fireEvent.input(field, { target: { value: "corrected" } });
    flush();
    fireEvent.keyDown(field, { key: "Enter" });
    flush();

    expect(onRename).toHaveBeenCalledWith("corrected");
  });

  it("abandons the edit on Escape without writing", () => {
    const { screen, onRename } = setup();
    fireEvent.click(screen.getByLabelText("Rename derived name"));
    flush();

    const field = screen.getByLabelText("Project name") as HTMLInputElement;
    fireEvent.input(field, { target: { value: "discarded" } });
    flush();
    fireEvent.keyDown(field, { key: "Escape" });
    flush();

    expect(onRename).not.toHaveBeenCalled();
    expect(hidden(field)).toBe(true);
  });

  it("refuses to write an empty name", () => {
    const { screen, onRename } = setup();
    fireEvent.click(screen.getByLabelText("Rename derived name"));
    flush();

    const field = screen.getByLabelText("Project name") as HTMLInputElement;
    fireEvent.input(field, { target: { value: "   " } });
    flush();
    fireEvent.keyDown(field, { key: "Enter" });
    flush();

    expect(onRename).not.toHaveBeenCalled();
  });
});
