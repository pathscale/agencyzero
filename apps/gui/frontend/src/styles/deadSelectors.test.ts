/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A selector that cannot match anything is a bug CSS reports as silence.
 *
 * Three variations of it cost real debugging time, and each looked correct in
 * review:
 *
 *   - `[&_[data-slot=radio-control]]:size-7` — `@pathscale/ui` emits `data-slot`
 *     for a few semantic parts (`label`, `description`, `separator`) and BEM
 *     classes for its internals, so this named an attribute that is never
 *     rendered. 31 colour-wheel petals silently kept the library's own sizing.
 *   - `[&_.radio__control]:size-7` — the obvious repair, equally dead: Tailwind
 *     reads `__` in an arbitrary variant as an escaped space, so it compiles to
 *     `.radio\_\_control\]\:size-7 .radio control`.
 *   - `@supports not (backdrop-filter: …)` — always true on this renderer,
 *     because stylo keeps the property behind `servo_pref = layout.unimplemented`.
 *     Glass rendered fully opaque whatever the axes said.
 *
 * The shape they share is that nothing fails. There is no console warning, no
 * type error and no test failure — the declaration is simply dropped. So these
 * checks read the source and the built library and assert that every selector
 * reaching into a component's internals could actually match something.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const UI_DIST = join(ROOT, "node_modules/@pathscale/ui/dist");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const SOURCES = walk(SRC).filter((path) => /\.(tsx?|css)$/.test(path));
const CODE = SOURCES.filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"));

/**
 * Source with comments removed.
 *
 * Every one of these bugs is worth a comment naming the dead selector it
 * replaced, and a linter that reads those comments flags the explanation as the
 * defect. Documenting a trap must not count as falling into it — the same
 * reason the glass guard in `theme.test.ts` strips comments first.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Everything the installed library actually renders, read once. */
const LIBRARY = walk(UI_DIST)
  .filter((path) => /\.(js|css)$/.test(path))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

const relative = (path: string) => path.slice(ROOT.length + 1);

describe("selectors that reach into a component's internals", () => {
  it("only names data-slot values the library renders", () => {
    const dead: string[] = [];
    for (const path of CODE) {
      const text = code(path);
      for (const [, slot] of text.matchAll(/data-slot=["']?([a-z0-9-]+)["']?/g)) {
        // The library writes them as `data-slot="name"`; a value it never emits
        // cannot be matched by anything.
        if (LIBRARY.includes(`data-slot="${slot}"`)) continue;
        dead.push(`${relative(path)} → data-slot=${slot}`);
      }
    }
    expect(dead).toEqual([]);
  });

  /*
   * `__` inside `[&_…]` is the trap. Tailwind treats `_` as a space escape, so
   * a BEM class in an arbitrary variant silently becomes a descendant
   * combinator. There is no spelling of it that works, which is why the rule is
   * "put it in the stylesheet" rather than "escape it differently".
   */
  it("never puts a BEM class inside a Tailwind arbitrary variant", () => {
    const dead: string[] = [];
    for (const path of CODE) {
      const text = code(path);
      for (const [variant] of text.matchAll(/\[&[^\]]*__[^\]]*\]/g)) {
        dead.push(`${relative(path)} → ${variant}`);
      }
    }
    expect(dead).toEqual([]);
  });

  /*
   * A BEM class named in real CSS is fine — that is the supported route — but
   * it still has to be a class the library ships, or it is dead for the older
   * reason.
   */
  it("only names BEM classes the library ships", () => {
    const css = code(join(SRC, "styles/theme.css"));
    const dead: string[] = [];
    for (const [, block] of css.matchAll(/\.([a-z]+__[a-z-]+)/g)) {
      if (LIBRARY.includes(block)) continue;
      dead.push(`theme.css → .${block}`);
    }
    expect(dead).toEqual([]);
  });

  /*
   * `@supports` asks the engine whether it implements a property. Blitz answers
   * "no" for things it does implement, because stylo does not advertise them,
   * so a negated probe is a branch that always wins. Feature detection has to
   * come from the app, which knows which renderer it is.
   */
  it("does not gate styling on a property probe this renderer fails", () => {
    const rules = code(join(SRC, "styles/theme.css"));
    const probes = [...rules.matchAll(/@supports[^{]*/g)].map(([match]) => match.trim());
    expect(probes.filter((probe) => /backdrop-filter|filter\s*:/.test(probe))).toEqual([]);
  });
});
