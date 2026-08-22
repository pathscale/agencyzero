import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { Icon } from "~/components/Icon";
import { ICON_ART } from "~/components/IconSprite";

/**
 * Two icons of the same name each get their own artwork.
 *
 * `ICON_ART` used to hold pre-created JSX elements, one per name, shared by
 * every `<Icon>` that asked for it. A DOM node has exactly one parent, so
 * inserting the same element into a second `<svg>` *moves* it out of the first.
 * The panel renders fifteen status markers across four icon names, so only the
 * last one mounted kept its artwork and every earlier one was left an empty
 * `<svg>`: correct box, correct stroke, nothing drawn.
 *
 * This is checkable in jsdom, unlike the two rasteriser bugs that preceded it,
 * because the failure is in the DOM rather than in usvg. `icon_artwork.rs`
 * covers the half that is not: whether the artwork survives usvg once it is
 * there. Both are needed, and neither would have caught the other.
 */
describe("icon instances", () => {
  it("gives every icon its own artwork rather than sharing one element", () => {
    const { container } = render(() => (
      <>
        <Icon name="check" />
        <Icon name="check" />
        <Icon name="check" />
      </>
    ));

    const icons = [...container.querySelectorAll("svg")];
    expect(icons).toHaveLength(3);
    for (const [index, svg] of icons.entries()) {
      expect(
        svg.querySelector("path, circle, rect, line, polyline, polygon, ellipse"),
        `icon ${index} of ${icons.length} has no artwork; the elements are being shared`,
      ).not.toBeNull();
    }
  });

  it("builds artwork on demand, so the map cannot hand out one shared node", () => {
    /*
     * The map's values are factories. Reading the same entry twice has to give
     * two different nodes, because a single node cannot be in two places and
     * the second insertion silently empties the first.
     */
    for (const build of Object.values(ICON_ART)) {
      expect(typeof build).toBe("function");
    }
  });

  it("draws artwork for every declared name", () => {
    for (const name of Object.keys(ICON_ART) as (keyof typeof ICON_ART)[]) {
      const { container, unmount } = render(() => <Icon name={name} />);
      expect(
        container.querySelector(
          "svg path, svg circle, svg rect, svg line, svg polyline, svg polygon, svg ellipse",
        ),
        `${name} rendered an empty <svg>`,
      ).not.toBeNull();
      unmount();
    }
  });
});
