/* Reads shipped source with `node:fs`; renderer behavior belongs in ps-qa. */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Seeing the desktop through the app is a property of a *stack*, not of one
 * declaration, and that is why it kept not working.
 *
 * Light reaches the desktop only if every layer covering the whole window is
 * translucent at once. There are three, and each was independently opaque at
 * some point in this feature's life:
 *
 *   1. the native window, which composites opaque while `backgroundColor` is
 *      set, no matter what the page paints
 *   2. `body`, which paints over the window
 *   3. `.az-desk`, which paints over the body and fills the window
 *
 * Fixing any one of them changes nothing observable, so a screenshot is the
 * only feedback and every attempt looks identical to the last. These assert the
 * whole chain instead: turn the opacity axis down and every layer in it has to
 * admit light.
 */

// `process.cwd()` is the frontend package root under vitest, which is what
// `deadSelectors.test.ts` relies on too. `import.meta.dir` is Bun-only and
// fails the production type check.
const SRC = join(process.cwd(), "src");
const THEME_CSS = readFileSync(join(SRC, "styles/theme.css"), "utf8");
const TAURI_CONF = readFileSync(join(process.cwd(), "..", "tauri.conf.json"), "utf8");

/** The declaration block for one selector, as written in the stylesheet. */
function ruleFor(selector: string): string {
  const at = THEME_CSS.indexOf(`${selector} {`);
  if (at < 0) return "";
  return THEME_CSS.slice(at, THEME_CSS.indexOf("\n  }", at));
}

describe("the window can be seen through", () => {
  /*
   * Layer 1. `backgroundColor` makes macOS composite an opaque surface behind
   * the webview, so the page cannot be transparent however it is styled. This
   * is the one that made every CSS fix look like it had failed.
   */
  it("does not give the native window an opaque background colour", () => {
    const window = JSON.parse(TAURI_CONF).app.windows[0];
    expect(window.backgroundColor).toBeUndefined();
    expect(window.transparent).toBe(true);
  });

  /*
   * Layers 2 and 3. Both must read the same alpha, or the opaque one hides the
   * translucent one and the slider appears to do nothing.
   */
  /*
   * A surface inside a glass container must not paint its own film.
   *
   * Alpha stacks multiplicatively: two surfaces at 54% composite to 79%, and
   * the result reads as a flat slab rather than glass. That is what the project
   * panel's sections did once the sidebar column started carrying the blur, and
   * it is invisible to every other test here because each declaration is
   * individually correct.
   */
  it("keeps a shared glass surface from painting a second film", () => {
    const rule = ruleFor("  .az-glass-shared");
    expect(rule).toContain("backdrop-filter: none");
    expect(rule, "a shared surface has to clear its background, not just its filter").toContain(
      "background-color: transparent",
    );
  });

  it.each(["body", "  .az-desk"])("makes %s follow the opacity axis", (selector) => {
    const rule = ruleFor(selector.trim() === "body" ? "  body" : selector);
    expect(rule).toContain("--az-glass-alpha");
    expect(rule).toContain("transparent");
  });
});
