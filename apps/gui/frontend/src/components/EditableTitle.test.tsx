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
 * They drive `mouseDown`, not `click`, because that is the event the pencil
 * opens on: the Home row around it is a `role="button"` that folds on `click`,
 * and Solid 2 delegates `click`, so a pencil handler on that event lost the
 * race and folded the row instead. Note what this file cannot see - every one
 * of these passed while the control was dead in the running app, because jsdom
 * dispatches straight at the node it is handed and has no hit-testing, no
 * layout and no renderer. `scripts/button-sweep.sh` is what catches that.
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

  it("shows the field and hides the name when the pencil is pressed", () => {
    const { screen } = setup();
    const pencil = screen.getByLabelText("Rename derived name");
    const field = screen.getByLabelText("Project name") as HTMLInputElement;

    // Both branches are mounted for the life of the component, so "hidden" is
    // a class on the wrapper rather than an absent node.
    expect(field.closest("span")?.className).toContain("hidden");

    fireEvent.mouseDown(pencil);
    flush();

    expect(field.closest("span")?.className).not.toContain("hidden");
    // The name it is about to replace steps out of the way.
    expect(pencil.closest("span")?.className).toContain("hidden");
  });

  it("starts the draft from the current name", () => {
    const { screen } = setup();

    fireEvent.mouseDown(screen.getByLabelText("Rename derived name"));
    flush();

    const field = screen.getByLabelText("Project name") as HTMLInputElement;
    expect(field.value).toBe("derived name");
  });

  it("commits an edited name on Enter", async () => {
    const { screen, onRename } = setup();
    fireEvent.mouseDown(screen.getByLabelText("Rename derived name"));
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
    fireEvent.mouseDown(screen.getByLabelText("Rename derived name"));
    flush();

    const field = screen.getByLabelText("Project name") as HTMLInputElement;
    fireEvent.input(field, { target: { value: "discarded" } });
    flush();
    fireEvent.keyDown(field, { key: "Escape" });
    flush();

    expect(onRename).not.toHaveBeenCalled();
    expect(field.closest("span")?.className).toContain("hidden");
  });

  it("refuses to write an empty name", () => {
    const { screen, onRename } = setup();
    fireEvent.mouseDown(screen.getByLabelText("Rename derived name"));
    flush();

    const field = screen.getByLabelText("Project name") as HTMLInputElement;
    fireEvent.input(field, { target: { value: "   " } });
    flush();
    fireEvent.keyDown(field, { key: "Enter" });
    flush();

    expect(onRename).not.toHaveBeenCalled();
  });
});
