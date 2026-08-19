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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Read off disk, and deliberately not through `import … from "./theme.css?raw"`:
 * Tailwind's pipeline claims `.css` first and hands `?raw` back an empty string,
 * so that import silently asserts nothing. The reference above pulls in the
 * `@types/node` that vitest already brings — nothing new is installed, and the
 * app's own tsconfig keeps `types: []`.
 */
const CSS = readFileSync(join(process.cwd(), "src/styles/theme.css"), "utf8");

describe("PathScale UI theme contract", () => {
  it("defines the visible default and accent tokens used by sliders and toggles", () => {
    expect(CSS).toContain("--color-default: var(--color-base-300)");
    expect(CSS).toContain("--color-default-foreground: var(--color-base-content)");
    expect(CSS).toContain("--color-accent-foreground: var(--color-accent-content)");
  });

  /*
   * The slider is the library's, themed through the variables it exposes rather
   * than overridden through its internals. Three rounds of `!important` against
   * `[data-slot=slider-thumb]` is what made a bespoke copy look tempting; the
   * copy was thrown away and the real defects fixed upstream instead.
   */
  it("themes the library slider through its own variables", () => {
    expect(CSS).not.toContain("az-cost-warning-slider");
    expect(CSS).not.toContain("--az-slider-percent");
    expect(CSS).not.toContain(".az-slider__thumb");

    // The rail has to be visible against the panel it sits on.
    expect(CSS).toContain(
      "--slider-track-bg: color-mix(in oklab, var(--color-base-content) 18%, transparent)",
    );
    // And the knob must not be the accent's *text* colour, which is near black.
    expect(CSS).toContain("--slider-thumb-bg: var(--color-primary)");
  });
});

/*
 * Every colour in the app is now an expression over three axes rather than a
 * literal, so "the palette did not move" stopped being something you can see by
 * reading the diff. This reduces each token at the default axis values and
 * checks it against what the file held before the refactor.
 *
 * It is a regression guard as much as a one-off proof: change an axis default
 * and this fails, naming the token that shifted. The numbers below are the
 * literals from the commit before the axes existed — do not update them to
 * match new output without knowing why the palette moved.
 */

/** The axis defaults, read from the stylesheet rather than assumed. */
function axisDefaults(): Record<string, number> {
  const axes: Record<string, number> = {};
  for (const [, name, raw] of CSS.matchAll(
    /--(az-hue|az-hue-text|az-tint|az-lift|az-damp):\s*([^;]+);/g,
  )) {
    axes[`--${name}`] = Number.parseFloat(raw);
  }
  return axes;
}

/**
 * Reduce one `oklch(...)` token to numbers.
 *
 * Handles exactly the two shapes the stylesheet uses — `calc(N% ± var(--axis))`
 * and `calc(N * var(--axis))` — and throws on anything else, so a new shape
 * cannot slip through as a silent pass.
 */
function anchorOf(token: string): string {
  /*
   * Tokens now read `color-mix(in oklab, var(--color-primary) <wash>, oklch(...))`.
   * At the default 0% wash the mix is the anchor exactly, so the anchor is what
   * decides whether the palette moved — pull it out and reduce that.
   */
  const decl = CSS.match(new RegExp(`--color-${token}:\\s*([\\s\\S]*?);\\n`))?.[1];
  if (!decl) throw new Error(`no token named --color-${token}`);
  const anchor = decl.match(/oklch\(((?:[^()]|\([^()]*(?:\([^()]*\))?[^()]*\))*)\)/);
  if (!anchor) throw new Error(`no oklch anchor in --color-${token}: ${decl}`);
  return anchor[1];
}

function reduce(token: string, axes: Record<string, number>): [number, number, number] {
  const body = anchorOf(token);

  // `calc(15% + var(--az-lift))` nests one level, so the component matcher has
  // to allow an inner pair of parens before closing.
  const parts = body
    .replace(/\s+/g, " ")
    .trim()
    .match(/(calc\((?:[^()]|\([^()]*\))*\)|[^\s]+)/g);
  if (parts?.length !== 3) throw new Error(`cannot split ${token}: ${body}`);

  return parts.map((part: string) => {
    const plain = Number.parseFloat(part);
    if (!part.startsWith("calc(")) {
      // A bare `var(--az-hue)` resolves to its default; a bare number is itself.
      return part.startsWith("var(") ? axes[part.slice(4, -1)] : plain;
    }
    const sum = part.match(/calc\(\s*([\d.]+)%?\s*([+-])\s*var\((--[\w-]+)\)\s*\)/);
    if (sum) {
      const [, base, op, axis] = sum;
      return op === "+" ? Number(base) + axes[axis] : Number(base) - axes[axis];
    }
    const product = part.match(/calc\(\s*([\d.]+)\s*\*\s*var\((--[\w-]+)\)\s*\)/);
    if (product) return Number(product[1]) * axes[product[2]];
    throw new Error(`unrecognised expression in ${token}: ${part}`);
  }) as [number, number, number];
}

/** What each token rendered as before the axes existed. */
const BEFORE: Record<string, [number, number, number]> = {
  "base-100": [15, 0.005, 240],
  "base-200": [10.5, 0.004, 240],
  "base-300": [20, 0.008, 240],
  "base-content": [84, 0.008, 245],
  "az-title": [86, 0.008, 245],
  "az-strong": [80, 0.008, 245],
  "az-body": [75, 0.009, 245],
  "az-muted": [66, 0.01, 245],
  "az-faint": [62, 0.01, 245],
  "az-void": [8, 0.003, 240],
  "az-desk": [10.5, 0.004, 240],
  "az-inset": [12.5, 0.005, 240],
  "az-tab": [16, 0.006, 240],
  // Were inline in class lists, not in this file; values carried over exactly.
  "az-sunken": [13, 0.004, 240],
  "az-hover": [17, 0.006, 240],
  "az-badge": [24, 0.01, 240],
  "az-dim": [56, 0.01, 245],
  "az-ghost": [48, 0.01, 245],
  /*
   * Converted from #1e1e1e / #2a2a2a / #e0e0e0, then given the neutral ladder's
   * hue so the reply follows the theme instead of staying grey. Lightness is
   * what still separates it from the user's bubble at base-300's 20%.
   *
   * Chroma matches the tier each one belongs to rather than sitting under it:
   * the surface takes `base-300`'s 0.008, the text takes `az-title`'s 0.008.
   * Held below them, the reply read as the one card that missed the theme.
   */
  "az-bubble": [23.5, 0.008, 240],
  "az-bubble-edge": [28.5, 0.008, 240],
  "az-bubble-text": [90.67, 0.008, 245],
};

describe("the theme axes", () => {
  it("are identity at their defaults", () => {
    const axes = axisDefaults();
    expect(axes["--az-tint"]).toBe(1);
    expect(axes["--az-lift"]).toBe(0);
    expect(axes["--az-damp"]).toBe(0);
  });

  const axes = axisDefaults();
  for (const [token, expected] of Object.entries(BEFORE)) {
    it(`leaves --color-${token} where it was`, () => {
      expect(reduce(token, axes)).toEqual(expected);
    });
  }

  /*
   * The point of the refactor: one write to an axis has to move everything.
   * A token that forgot its `var(--az-lift)` would pass the table above and
   * still stay put when the picker moves, so surfaces are checked for the
   * axis by name.
   */
  it("wires every surface to the lift, and every text rung to the damp", () => {
    const surfaces = [
      "base-100",
      "base-200",
      "base-300",
      "az-void",
      "az-desk",
      "az-inset",
      "az-tab",
      "az-sunken",
      "az-hover",
      "az-badge",
      "az-bubble",
      "az-bubble-edge",
    ];
    for (const token of surfaces) {
      expect(anchorOf(token), `--color-${token} must follow --az-lift`).toContain("--az-lift");
    }
    const text = [
      "base-content",
      "az-title",
      "az-strong",
      "az-body",
      "az-muted",
      "az-faint",
      "az-dim",
      "az-ghost",
      "az-bubble-text",
    ];
    for (const token of text) {
      expect(anchorOf(token), `--color-${token} must follow --az-damp`).toContain("--az-damp");
    }
  });

  /*
   * Everything the accent should reach. A literal here would keep its colour
   * when the wheel moves — which is exactly what three of these did until it
   * was noticed in the running app, because they hide inside shadow and
   * gradient values rather than colour ones.
   */
  it("derives the app's chrome from the accent rather than from literals", () => {
    expect(CSS, "no palette yellow may be spelled out outside the accent tokens").not.toMatch(
      /rgb\(255 238 88|#fff176/,
    );
    for (const rule of [
      "--color-az-hairline:",
      "--color-az-hairline-soft:",
      "--color-az-hairline-strong:",
      "--color-az-primary-hover:",
    ]) {
      const decl = CSS.match(new RegExp(`${rule}\\s*([^;]+);`))?.[1] ?? "";
      expect(decl, `${rule} must follow the accent`).toMatch(/var\(--color-primary\)/);
    }
    // The ring pair, the halo, the desk's dot grid and both scrollbar rules.
    expect(CSS.match(/rgb\(from var\(--color-primary\)/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it("derives every washed surface from its own base colour", () => {
    expect(CSS.match(/var\(--az-surface\)[\s\S]{0,80}var\(--az-wash/g)?.length).toBeGreaterThan(20);
    expect(CSS).not.toMatch(/var\(--color-primary\)\s+(?:calc\()?var\(--az-wash\)/);
    for (const multiplier of ["105", "110", "120"]) {
      expect(CSS).toContain(`--az-wash-${multiplier}: min(100%`);
    }
  });
});

describe("light mode", () => {
  it("overrides the complete surface and text ladder under the root mode selector", () => {
    const rule = [
      ...CSS.matchAll(/\[data-theme="agencyzero"\]\[data-color-mode="light"\]\s*\{([\s\S]*?)\n\}/g),
    ]
      .map((match) => match[1])
      .join("\n");

    expect(rule).not.toBe("");
    for (const token of [
      "--color-base-100:",
      "--color-base-200:",
      "--color-base-300:",
      "--color-base-content:",
      "--color-az-desk:",
      "--color-az-inset:",
      "--color-az-title:",
      "--color-az-muted:",
      "--color-az-bubble:",
      "--color-az-bubble-text:",
    ]) {
      expect(rule, `${token} must have a light-mode value`).toContain(token);
    }
  });

  it("changes neutral sheen with the mode instead of baking white into chrome", () => {
    expect(CSS).toContain("--az-sheen: 255 255 255;");
    expect(CSS).toContain("--az-sheen: 17 24 39;");
    expect(CSS).not.toMatch(/rgb\(255 255 255 \/ 0\.1[25]\)/);
  });

  it("drifts the composer accent only under a class the composer can drop", () => {
    const rule = CSS.match(/\.az-ring-composer\s*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";

    // The accent itself must stay static. An animation here runs for the life
    // of the document, and Blitz reads that as an active document: it kept
    // submitting full frames for an idle window, for decoration alone.
    expect(rule).toContain("var(--color-primary)");
    expect(rule).not.toContain("animation:");

    // The drift lives on its own class, which the composer adds on a keystroke
    // and drops a few seconds after the last one, so the render loop lasts as
    // long as someone is writing rather than as long as the cursor sits in the
    // box. Keyed on focus it held 46% CPU for as long as nobody typed.
    const drift = CSS.match(/\.az-ring-drift\s*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(drift).toContain("az-composer-ring-drift");
    expect(CSS).toContain("@keyframes az-composer-ring-drift");
  });
});

describe("the PathScale/UI button compatibility reset", () => {
  /*
   * `:where()` zeroes a rule's specificity. PathScale/UI's own `.button`
   * (0,1,0) lives in this same `components` layer and later in source, so a
   * `:where()`-wrapped reset loses every declaration it makes: the 40px pill,
   * its hover fill and `isolation: isolate` all come back. Measured in the
   * running app, that put a 46px "GitHub ›" control inside a 36px row with its
   * hover background painted across the branch name beside it, and turned a
   * 15px chevron into a blob.
   *
   * Caller utilities still win without it, because Tailwind's `utilities`
   * layer comes after `components` and a later layer beats any specificity.
   * That is what the `:where()` was reaching for, and it was never needed.
   */
  it("keeps enough specificity to beat the library's own .button", () => {
    expect(CSS).toContain(".button.az-ui-button-neutral {");
    expect(CSS).not.toContain(":where(.button.az-ui-button-neutral");
  });

  it("stays inside the components layer, so caller utilities still override it", () => {
    const reset = CSS.indexOf(".button.az-ui-button-neutral {");
    const components = CSS.lastIndexOf("@layer components", reset);
    expect(components).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(components);
  });
});

/*
 * Glass has to survive the renderer that actually ships.
 *
 * The opaque fallback used to sit behind `@supports not ((backdrop-filter: …)
 * or (-webkit-backdrop-filter: …))`, which reads as a safe progressive
 * enhancement and is anything but on blitz: stylo keeps `backdrop-filter`
 * behind `servo_pref = "layout.unimplemented"`, so the property is never
 * advertised to `@supports` even though blitz-paint implements it. The probe
 * matched on every frame, the 78% opaque fallback won, and glass rendered at no
 * transparency at all whatever the three axes said.
 *
 * A property the engine implements but does not declare cannot be feature
 * detected from inside CSS, so the guard is that no glass rule may be gated on
 * asking.
 */
describe("glass survives a renderer that under-reports itself", () => {
  it("never gates the glass fallback on a backdrop-filter @supports probe", () => {
    // Only real at-rules: the comment above the fallback names the probe it
    // replaced, and explaining the bug must not read as committing it.
    const atRules = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(atRules).not.toMatch(/@supports[^{]*backdrop-filter/);
  });

  it("keeps the translucent surface as the rule that normally wins", () => {
    const glass = CSS.indexOf(".az-glass {");
    expect(glass).toBeGreaterThanOrEqual(0);
    /*
     * The surface has to be able to produce transparency at all, which is what
     * makes it glass rather than a second opaque colour.
     *
     * Asserted on the alpha rather than on the spelling. This used to require
     * `color-mix(… transparent …)` literally, and that turned out to be the
     * form that *loses* the alpha: Lightning CSS emits a `color-mix` as
     * progressive enhancement and synthesised an opaque fallback, so every
     * panel shipped solid while this test passed. `rgb(from … / alpha)` carries
     * the same alpha in one declaration a minifier cannot split.
     */
    const rule = CSS.slice(glass, CSS.indexOf("}", CSS.indexOf("backdrop-filter", glass)));
    // Whitespace-agnostic: the declaration wraps across lines.
    const background = rule.slice(rule.indexOf("background-color:"));
    const flat = background.replace(/\s+/g, " ");
    expect(flat).toContain("var(--glass-background-opacity");
    expect(
      /rgb\( from .*\/ var\(--glass-background-opacity/.test(flat) ||
        flat.includes("transparent calc(100% - var(--glass-background-opacity"),
      `the glass surface cannot produce transparency: ${flat.slice(0, 200)}`,
    ).toBe(true);
    expect(rule).toContain("backdrop-filter: blur(var(--glass-blur");
  });

  it("puts the opaque fallback behind a class the app controls", () => {
    expect(CSS).toContain(".az-no-backdrop .az-glass {");
  });
});

/*
 * Moved here from `Button.test.tsx`, which renders and therefore needs jsdom.
 * These assert the shipped stylesheet's text, and reading a file with
 * `node:fs` is exactly what this file already does.
 */
describe("the neutral Button reset", () => {
  /*
   * Written first against `:where(.button.az-ui-button-neutral)`, which was
   * wrong in the one way that matters: `:where()` zeroes specificity, so the
   * library's own `.button` outranked the reset and kept its fill. That is what
   * sized section headers to a 40px control and put a blob around the chevron.
   *
   * The bare selector is therefore load-bearing, and these assert it stays bare.
   */
  it("keeps the compatibility reset above the library's own .button", () => {
    expect(CSS).toContain(".button.az-ui-button-neutral {");
    expect(CSS).not.toContain(":where(.button.az-ui-button-neutral)");
  });

  it("neutralizes transient PathScale pressed paint", () => {
    expect(CSS).toContain(".button.az-ui-button-neutral:active");
    expect(CSS).toContain('.button.az-ui-button-neutral[data-pressed="true"]');
    expect(CSS).toContain("transform: none");
    expect(CSS).not.toContain(":where(.button.az-ui-button-neutral:active)");
  });

  it("does not override existing call-site hover paint", () => {
    expect(CSS).not.toContain(".button.az-ui-button-neutral:hover");
    expect(CSS).not.toContain('.button.az-ui-button-neutral[data-hovered="true"]');
    expect(CSS).toContain("--button-bg-hover: transparent");
  });
});
