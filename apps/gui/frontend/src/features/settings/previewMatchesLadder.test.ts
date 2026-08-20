/*
 * @vitest-environment node
 *
 * Reads both sources with `node:fs` rather than rendering: the point is that
 * two files agree, which is a property of the text, not of a mounted component.
 */
/// <reference types="node" />

/**
 * A preview swatch shows the surface it stands for, or it is decoration.
 *
 * The appearance rows preview each stop by rebuilding the surface expression in
 * TypeScript, because a swatch has to show what the stop *would* produce rather
 * than what is currently applied. That duplication is the hazard: `theme.css`
 * owns the real ladder, and when it changes the preview silently keeps showing
 * a surface the app no longer builds.
 *
 * It has drifted twice. First by hardcoding chroma and hue, so a theme that
 * moved its hue got a blue-grey row while the surfaces leaned toward the
 * accent. Then when the ladder was reordered to put the picked colour on the
 * panel rather than the desk: the row went on previewing the desk, anchored at
 * 10.5% lightness, and mixing any colour into something that close to black at
 * 10% or at 50% lands in nearly the same place. All five strength swatches
 * rendered as near-identical dark circles, and the softness row was worse,
 * since the anchor is the only thing its stops vary.
 *
 * So this asserts the two agree on the tier being previewed: the panel, which
 * is what the eye reads as the app and the tier the pick is meant to land on.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "src/styles/theme.css"), "utf8");
const PICKER = readFileSync(join(process.cwd(), "src/features/settings/ThemePicker.tsx"), "utf8");

/** The `--color-base-100` declaration for one colour mode. */
function panelBlock(from: number): string {
  const at = CSS.indexOf("--color-base-100: color-mix(", from);
  expect(at, "the panel tier should be declared").toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf(");", at));
}

describe("the preview swatches show the surface the ladder builds", () => {
  const dark = panelBlock(0);

  it("previews the panel's wash multiplier, not another tier's", () => {
    const step = dark.match(/var\(--az-surface\)\s+var\(--az-wash-(\d+)\)/);
    expect(step, `panel should mix at a wash step: ${dark}`).not.toBeNull();

    // `--az-wash-120` in CSS is `* 1.2` in the preview.
    const multiplier = (Number(step![1]) / 100).toFixed(1);
    expect(PICKER).toContain(`wash * ${multiplier}`);
  });

  it("previews the panel's own lightness and chroma", () => {
    const anchor = dark.match(
      /oklch\(calc\((\d+(?:\.\d+)?)% \+ var\(--az-lift\)\)\s*calc\((0\.\d+)/,
    );
    expect(anchor, `panel should anchor in oklch: ${dark}`).not.toBeNull();
    const [, lightness, chroma] = anchor!;

    expect(PICKER).toContain(`calc(${lightness}% +`);
    expect(PICKER).toContain(`calc(${chroma} *`);
  });

  it("reads chroma and hue from the live tokens rather than literals", () => {
    // The first drift: a hardcoded 0.004 and 240 pinned every theme's swatches
    // to blue-grey however far the hue had moved.
    expect(PICKER).toContain('deskVar("--az-tint"');
    expect(PICKER).toContain('deskVar("--az-hue"');
  });
});
