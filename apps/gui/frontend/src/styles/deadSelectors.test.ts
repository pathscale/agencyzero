/*
 * @vitest-environment node
 *
 * This file reads the repository with `node:fs` rather than rendering
 * anything. Under the suite's default jsdom environment those builtins are
 * externalised for the browser and the import fails outright with "No such
 * built-in module: node:". Vitest 4 removed `environmentMatchGlobs`, so the
 * environment is declared per file.
 */
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

/*
 * Glass is defeated by anything the engine answers wrongly, and it has now
 * happened twice from two different at-rules: `@supports (backdrop-filter: …)`,
 * which stylo fails for a property blitz implements, and
 * `@media (prefers-reduced-transparency: reduce)`, which is not a registered
 * media feature in stylo's servo path at all.
 *
 * Both put an opaque rule after the translucent one, so the fallback won the
 * cascade and glass painted flat. The rule is that no glass fallback may be
 * gated on the engine's own answer — the app knows which renderer it is.
 */
describe("glass fallbacks are app decisions, not engine questions", () => {
  const CSS_TEXT = code(join(SRC, "styles/theme.css"));

  it("does not gate the glass fallback on a media feature", () => {
    const gated = [...CSS_TEXT.matchAll(/@media[^{]*\{[^}]*\.az-glass/g)].map(([m]) => m.trim());
    expect(gated).toEqual([]);
  });

  /*
   * The same hazard, for every rule rather than one.
   *
   * `.az-glass-shared` was written with the standard property first, so
   * Lightning CSS emitted only `-webkit-backdrop-filter: none`, the standard
   * property survived from `.az-glass`, and every sidebar section kept its own
   * backdrop pass. That is not a cosmetic bug: each pass costs a full-frame
   * render and a full-frame 19 MB texture, and the app was measured at seven
   * passes where it needed two, about 380 MB and 25 fps.
   *
   * Cheap to state and impossible to get wrong by accident, so it is checked
   * for every declaration rather than for the one that happened to break.
   */
  it("declares the standard backdrop-filter after the prefixed one, everywhere", () => {
    const offenders = [...CSS_TEXT.matchAll(/[^-\w]backdrop-filter\s*:[^;]*;/g)]
      .map((match) => ({ at: match.index ?? 0, text: match[0].trim() }))
      .filter(({ at }) => {
        // The prefixed twin has to be the declaration immediately before this
        // one; anything else means the pair is out of order or unpaired.
        const before = CSS_TEXT.lastIndexOf("-webkit-backdrop-filter", at);
        if (before < 0) return true;
        return CSS_TEXT.slice(before, at).includes("}");
      })
      .map(({ text }) => text);

    expect(offenders).toEqual([]);
  });

  it("keeps the standard backdrop-filter, not only the prefixed one", () => {
    // Declared after `-webkit-`, so a minifier that keeps the last declaration
    // cannot drop the standard property for its default targets.
    const webkit = CSS_TEXT.indexOf("-webkit-backdrop-filter: blur(var(--glass-blur");
    const standard = CSS_TEXT.indexOf("backdrop-filter: blur(var(--glass-blur", webkit + 10);
    expect(webkit).toBeGreaterThanOrEqual(0);
    expect(standard).toBeGreaterThan(webkit);
  });
});
