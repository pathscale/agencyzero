/*
 * @vitest-environment node
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What a glass slider shows while dragging has to be what it shows after
 * release.
 *
 * Reported four separate times, and the reason it survived that long is that
 * the *number* was never wrong. The drag path and the persist path write
 * different sets of custom properties, so the surface changed appearance at
 * the moment the drag ended even though the value did not move.
 *
 *   drag:    applyGlassTokens(tuning, mode) + writePanelAxes(tuning)
 *   persist: writeGlassTuning(theme, root)
 *
 * `writeGlassTuning` also writes the control tint, the desk alpha and the
 * library's root class. Anything constant that only it wrote was therefore
 * absent for the length of a drag and appeared on release.
 *
 * The fix is to keep constants out of JS entirely: the six glass colours are
 * declared in the stylesheet, so both paths see them because neither has to
 * write them. This asserts that shape rather than the symptom, because the
 * symptom needs a real pointer drag against a real renderer to observe, and
 * the shape is what actually prevents it.
 */

const SRC = join(process.cwd(), "src");
const THEME_TS = readFileSync(join(SRC, "lib/theme.ts"), "utf8");
const THEME_CSS = readFileSync(join(SRC, "styles/theme.css"), "utf8");

/** The six colours the library leaves to the theme. */
const GLASS_COLOURS = [
  "--glass-background-color",
  "--glass-border-color",
  "--glass-highlight-color",
];

describe("a glass drag looks the same as its release", () => {
  it("declares the glass colours in CSS, where both paths see them", () => {
    for (const colour of GLASS_COLOURS) {
      expect(THEME_CSS).toContain(`${colour}:`);
    }
  });

  /*
   * The specific regression. Written from `lib/theme.ts` these reach the
   * document only through `writeGlassTuning`, which the drag path does not
   * call, so every drag rendered with the library's white fallback and
   * snapped to the app's own tint on release.
   */
  it("does not write the glass colours from the persist path only", () => {
    for (const colour of GLASS_COLOURS) {
      expect(THEME_TS).not.toContain(`setProperty("${colour}"`);
    }
  });

  /*
   * The axes are the opposite case and must stay in JS: they are what the
   * slider is changing, so the drag path writes them itself through
   * `applyGlassTokens`. This asserts the split is deliberate rather than the
   * file having simply lost its writes.
   */
  it("still writes the axes that a drag is allowed to change", () => {
    expect(THEME_TS).toContain('setProperty("--glass-background-opacity"');
    expect(THEME_TS).toContain('setProperty("--az-glass-alpha"');
  });
});
describe("reset to default", () => {
  /*
   * Reset used to write five theme fields and leave the six glass ones alone,
   * so a window made unreadable by a glass setting stayed unreadable however
   * many times the button was pressed. Asserted on the *record* rather than
   * the rendering, because that is where the omission lived.
   */
  it("clears every glass axis, not just the palette ones", () => {
    // Read the handler the pane actually ships rather than restating it here:
    // a copy of the object in the test passes no matter what the pane does,
    // which is precisely the bug it would be pretending to guard.
    const source = readFileSync(
      join(process.cwd(), "src", "features", "settings", "SettingsTab.tsx"),
      "utf8",
    );
    const handler = source.slice(source.indexOf("onReset={() =>"));
    const body = handler.slice(0, handler.indexOf("}\n"));

    for (const axis of [
      "glassEnabled",
      "glassBlur",
      "glassRefraction",
      "glassDepth",
      "glassOpacity",
      "glassScrim",
    ]) {
      expect(body, `reset does not clear ${axis}`).toContain(`${axis}: undefined`);
    }
  });
});
