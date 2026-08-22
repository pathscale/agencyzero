/**
 * One row of controls, one shape.
 *
 * The right panel's header puts a count badge, a sort toggle, a direction
 * button and a collapse control in a single row. Measured through the
 * renderer's computed styles on the running app, the badge and the collapse
 * control painted a 38px radius while the two sort controls painted 6.96px:
 * fully round beside almost square, in one row, which is what the owner
 * reported as "radius is still not correct".
 *
 * Neither side was broken on its own. `rounded-md` resolves to 6px, the scale
 * factor turns it into 6.96, and the call sites simply disagreed with their
 * neighbours. That is why this asserts on the *relationship* between the
 * controls rather than on a literal: a future change to the panel's radius
 * should move them together, and a test that named 38px would then be wrong in
 * a way that reads as the panel being wrong.
 *
 * Read from the source rather than rendered, because the radius that matters
 * arrives from a Tailwind utility that jsdom does not resolve: `getComputedStyle`
 * reports the empty string for `border-radius` here, so a rendered assertion
 * would pass whatever the class said.
 */

/* @vitest-environment node */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PANEL = join(process.cwd(), "src/features/project/ProjectPanel.tsx");

/** The class list of the element carrying `marker`, with comments stripped. */
function classesNear(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `${marker} should still exist in the panel`).toBeGreaterThan(-1);
  // The `class=` attribute of the same element, which precedes the marker.
  const before = source.slice(0, at);
  const start = before.lastIndexOf('class="');
  expect(start, `${marker} should sit on an element with a class`).toBeGreaterThan(-1);
  return before.slice(start + 'class="'.length, before.indexOf('"', start + 'class="'.length));
}

describe("the item header is one shape", () => {
  const source = readFileSync(PANEL, "utf8");

  it("gives the sort toggle the same pill as the controls beside it", () => {
    const classes = classesNear(source, 'title={tx("Toggle item sort between status and time")}');
    expect(classes).toContain("rounded-full");
    expect(classes).not.toContain("rounded-md");
  });

  it("gives the sort direction button the same pill", () => {
    // The read moved out of `tx(...)` and into a memo: Solid 2 subscribes to
    // the compute it is given, so a store read passed as an argument to a
    // function call tracked nothing and the control never re-rendered.
    const classes = classesNear(source, 'aria-label={direction() === "asc"');
    expect(classes).toContain("rounded-full");
    expect(classes).not.toContain("rounded-md");
  });
});
