/*
 * @vitest-environment node
 *
 * Reads the stylesheet with `node:fs` rather than rendering. Under the suite's
 * default jsdom environment those builtins are externalised for the browser and
 * the import fails outright.
 */
/// <reference types="node" />

/**
 * The colour that was picked is the body, not the background.
 *
 * The surface ladder mixes `--az-surface` into three tiers, and which tier
 * takes the *most* of it decides what the control appears to do. It shipped
 * with the desk leading: `--color-base-200`, the window interior, took
 * `--az-wash-110` while `--color-base-100`, the panels, took plain
 * `--az-wash`. The reasoning was that deeper surfaces have the least chroma and
 * would otherwise stay grey.
 *
 * Rendered, that reads backwards. The interior behind the app carried more of
 * the pick than the panels in front of it, so the body looked like a washed-out
 * offset of the background rather than like the colour that was chosen: picking
 * a saturated pink produced a muted mauve body inside a darker surround.
 *
 * So the order is the assertion. The panel is what the eye reads as the app and
 * takes the strongest mix, the desk sits behind it, and cards step further again
 * to stay legible on the panel they sit on. A change that makes the desk lead
 * again fails here rather than being noticed in a screenshot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "src/styles/theme.css"), "utf8");

/** The wash multiplier a tier mixes `--az-surface` at, as written. */
function washFor(tier: string, from: number): { value: string; at: number } {
  const at = CSS.indexOf(`--color-${tier}: color-mix(`, from);
  expect(at, `${tier} should be declared after index ${from}`).toBeGreaterThan(-1);
  const block = CSS.slice(at, CSS.indexOf(");", at));
  const match = block.match(/var\(--az-surface\)\s+var\((--az-wash[\w-]*)\)/);
  expect(match, `${tier} should mix --az-surface at a wash step: ${block}`).not.toBeNull();
  return { value: match![1], at };
}

/** How much wash a step spends, relative to the base `--az-wash`. */
function weight(step: string): number {
  if (step === "--az-wash") return 1;
  const match = step.match(/--az-wash-(\d+)/);
  expect(match, `unknown wash step ${step}`).not.toBeNull();
  return Number(match![1]) / 100;
}

describe.each([
  ["dark", 0],
  ["light", CSS.indexOf('[data-color-mode="light"]')],
])("the %s surface ladder puts the pick on the body", (_mode, from) => {
  it("gives the panel more of the picked colour than the desk behind it", () => {
    const panel = washFor("base-100", from);
    const desk = washFor("base-200", from);

    expect(weight(panel.value)).toBeGreaterThan(weight(desk.value));
  });

  it("gives cards a step above the panel they sit on", () => {
    const panel = washFor("base-100", from);
    const card = washFor("base-300", from);

    expect(weight(card.value)).toBeGreaterThan(weight(panel.value));
  });

  it("keeps prose well below every surface", () => {
    // The one place a colour cast reads as a fault rather than as a theme, so
    // it takes a fraction rather than a multiple and is written as `calc`.
    const at = CSS.indexOf("--color-base-content: color-mix(", from);
    const block = CSS.slice(at, CSS.indexOf(");", at));
    expect(block).toMatch(/calc\(var\(--az-wash\)\s*\*\s*0\.\d+\)/);
  });
});
