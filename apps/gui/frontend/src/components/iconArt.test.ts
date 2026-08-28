import { describe, expect, it } from "vitest";

/**
 * Every icon draws its own geometry, and none reaches outside itself.
 *
 * The icons were one hidden `<symbol>` sprite and a `<use href="#i-name">` per
 * icon. That is correct SVG, renders in any browser, and drew nothing here:
 * `blitz-dom` parses every inline `<svg>` into its own `usvg::Tree` from that
 * element's `outer_html` alone (`layout/construct.rs`), so an icon reached the
 * rasteriser naming a `<symbol>` that was not in its tree. usvg resolved the
 * reference to nothing and painted an empty tree, leaving 762 icons with a
 * correct box, a correct stroke colour, and no artwork in any of them.
 *
 * # Why this is a source test rather than a live one
 *
 * `blitz-bench qa` drives the real renderer and still cannot see this. The
 * semantic tree reports roles and never element names, and an icon is a leaf
 * `presentation` node whose children are not exposed, so a blank icon and a
 * drawn one are indistinguishable from the outside: both are `16x16`, visible,
 * and stroked with the accent. That is precisely how the bug survived a live
 * inspection pass. A DOM-only render would not help because it resolves
 * `<use>` without exercising the rasteriser that failed.
 *
 * What is checkable is the shape of the markup that reaches the rasteriser, so
 * that is what this pins. Until the control protocol can report pixels, this is
 * the only thing standing between the app and a silent repeat.
 */
/*
 * Required lazily. Under `NODE_ENV=production bun --bun vitest`, a top-level
 * `node:fs` import fails to resolve inside the module evaluator, so the build
 * gate failed on a file that passed locally.
 */
const source = (name: string): string => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  return readFileSync(join(process.cwd(), "src/components", name), "utf8");
};

/** Comments necessarily name the thing they removed; strip them before matching. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");

describe("icon artwork", () => {
  const sprite = source("IconSprite.tsx");
  const icon = source("Icon.tsx");

  /**
   * The names the union declares, which is what callers may ask for.
   *
   * Cut to the type declaration first: the `| "name"` shape appears in prose
   * and in other unions in this file, and matching the whole source counted the
   * first entry twice.
   */
  const declaration = sprite.indexOf("export type IconName =");
  const union = sprite.slice(declaration, sprite.indexOf(";", declaration));
  const names = [...union.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);

  /** The keys `ICON_ART` actually provides. */
  // Quoted or bare: the formatter unquotes keys that are valid identifiers, so
  // `check:` and `"list-checks":` both appear and matching one form found half.
  const entry = /^ {2}"?([a-z0-9-]+)"?: \(\) => \(/gm;
  const provided = [...sprite.matchAll(entry)].map((match) => match[1]);

  it("declares a usable set of names", () => {
    expect(names.length).toBeGreaterThan(20);
    expect(new Set(names).size).toBe(names.length);
  });

  it("provides artwork for exactly the declared names", () => {
    expect([...provided].sort()).toEqual([...names].sort());
  });

  it("never references a symbol in another tree", () => {
    expect(code(sprite)).not.toMatch(/<use\b/);
    expect(code(icon)).not.toMatch(/<use\b/);
    expect(code(sprite)).not.toMatch(/<symbol\b/);
  });

  it("gives every icon at least one drawable element", () => {
    const blocks = [
      ...sprite.matchAll(/^ {2}"?([a-z0-9-]+)"?: \(\) => \(\n\s*<>\n([\s\S]*?)\n\s*<\/>/gm),
    ];
    expect(blocks.length).toBe(names.length);
    for (const [, name, art] of blocks) {
      expect(art, `${name} has no drawable element`).toMatch(
        /<(path|circle|rect|line|polyline|polygon|ellipse)\b/,
      );
    }
  });
});
