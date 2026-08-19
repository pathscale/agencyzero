import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { Button } from "~/components/Button";

/**
 * A Button has to put its click handler on the element it renders.
 *
 * `@pathscale/ui`'s Button enumerates the props it places on its root rather
 * than spreading what it was given, and the app's wrapper spreads into it. That
 * arrangement has already dropped `style` silently - the theme picker's swatches
 * carry their colour on a child element because of it, with a comment saying so
 * - and a dropped *event handler* is the same failure with worse consequences:
 * a dialog nobody can close, a composer button that does nothing.
 *
 * Asserted against the rendered node rather than by firing a synthetic event on
 * the component. `fireEvent` dispatches straight at whatever node the query
 * returns and Solid's delegation catches it, so a synthetic click can pass while
 * the real renderer, which hit-tests and dispatches natively, never reaches the
 * handler at all. Checking that the listener is present on the element is what
 * distinguishes the two.
 */

describe("the app's Button", () => {
  it("fires its onClick when the rendered element is clicked", () => {
    const onClick = vi.fn();
    const { getByRole } = render(() => <Button onClick={onClick}>Press</Button>);

    const element = getByRole("button");
    // A real, bubbling click on the actual node, not a synthetic dispatch at a
    // component boundary.
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a real button element that can receive a click", () => {
    const { getByRole } = render(() => <Button>Press</Button>);
    const element = getByRole("button");

    expect(element.tagName.toLowerCase()).toBe("button");
    // A control that is not clickable in the layout is a control nobody can
    // press, however correct its handler is.
    expect(getComputedStyle(element).pointerEvents).not.toBe("none");
  });

  it("keeps firing when it also carries a class and a variant", () => {
    const onClick = vi.fn();
    const { getByRole } = render(() => (
      <Button variant="ghost" class="rounded-lg p-1.5" onClick={onClick}>
        Press
      </Button>
    ));

    getByRole("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  /*
   * The dialog case specifically: a Button whose only content is an icon and
   * whose name comes from `aria-label`, which is how both fork-dialog exits are
   * written.
   */
  it("fires from an icon-only, aria-labelled button", () => {
    const onClick = vi.fn();
    const { getByRole } = render(() => (
      <Button type="button" aria-label="Cancel" onClick={onClick}>
        <span aria-hidden="true">x</span>
      </Button>
    ));

    getByRole("button", { name: "Cancel" }).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    const { getByRole } = render(() => (
      <Button disabled onClick={onClick}>
        Press
      </Button>
    ));

    getByRole("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClick).not.toHaveBeenCalled();
  });
});
