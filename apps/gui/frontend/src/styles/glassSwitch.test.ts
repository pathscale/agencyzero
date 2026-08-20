import { describe, expect, it } from "vitest";
import { applyTheme, iconStrokeColor, writeAccentPreview } from "~/lib/theme";
import type { ThemeSettings } from "~/types";

/**
 * Glass has to be something you can turn off, not only turn down.
 *
 * Every other glass field is a shade of "how much": the opacity axis stops at
 * a film that is still a film, and taking blur, refraction and depth to zero
 * leaves translucent surfaces behind. Asked for directly, and worth asserting
 * as behaviour rather than as the presence of a switch in the markup, because
 * the switch is easy and what it has to reach is not.
 *
 * Off means four things stop together: this app's film, its control tint, its
 * desk alpha and the library's root class. Any one left behind is a window
 * with some surfaces solid and some not, which reads as a rendering fault
 * rather than as a setting.
 */

function themeWith(overrides: Partial<ThemeSettings> = {}): ThemeSettings {
  return {
    surface: "",
    accent: "",
    wash: 30,
    softness: 0,
    textBrightness: 0,
    ...overrides,
  };
}

/** A fresh root, so one case cannot inherit another's custom properties. */
function root(): HTMLElement {
  const element = document.createElement("div");
  element.dataset.colorMode = "dark";
  document.body.append(element);
  return element;
}

const read = (element: HTMLElement, property: string) =>
  element.style.getPropertyValue(property).trim();

describe("the glass off switch", () => {
  it("is on when the setting has never been written", () => {
    const element = root();
    applyTheme(themeWith(), element);

    expect(element.classList.contains("glass")).toBe(true);
    expect(read(element, "--glass-background-opacity")).not.toBe("");
  });

  it("is on when explicitly enabled", () => {
    const element = root();
    applyTheme(themeWith({ glassEnabled: true, glassOpacity: 55 }), element);

    expect(element.classList.contains("glass")).toBe(true);
    expect(read(element, "--glass-background-opacity")).toBe("55%");
  });

  /*
   * The four together. Each was a separate bug at some point in this feature's
   * life, and fixing one alone changes nothing anyone can see.
   */
  it("takes every translucent surface solid at once when off", () => {
    const element = root();
    applyTheme(themeWith({ glassEnabled: false, glassOpacity: 55 }), element);

    // The library's components follow this class and nothing else.
    expect(element.classList.contains("glass")).toBe(false);
    // This app's own panels.
    expect(read(element, "--glass-background-opacity")).toBe("");
    // The controls, which take their own share of the film.
    expect(read(element, "--glass-control-opacity")).toBe("");
    // The desk and the body, which cover the whole window.
    expect(read(element, "--az-glass-alpha")).toBe("");
  });

  /*
   * Off has to beat the axis rather than be averaged with it, or the switch
   * does nothing whenever a stored opacity happens to be set - which is always,
   * since the axis has a default.
   */
  it("stays off however high the opacity axis is set", () => {
    const element = root();
    applyTheme(themeWith({ glassEnabled: false, glassOpacity: 95 }), element);

    expect(element.classList.contains("glass")).toBe(false);
    expect(read(element, "--glass-background-opacity")).toBe("");
  });

  it("restores the stored numbers when switched back on", () => {
    const element = root();
    applyTheme(themeWith({ glassEnabled: false, glassOpacity: 70 }), element);
    applyTheme(themeWith({ glassEnabled: true, glassOpacity: 70 }), element);

    expect(element.classList.contains("glass")).toBe(true);
    expect(read(element, "--glass-background-opacity")).toBe("70%");
  });
});

describe("the control tint", () => {
  /*
   * Controls take part of the film, not all of it and not none.
   *
   * All of it and a switch track reads as disabled with an illegible label.
   * None of it, which is the library's default, and every control is the only
   * solid thing left in a glassed window: reported repeatedly as the language
   * button, the model pickers and the segmented pills showing as bright slabs.
   */
  it("sits between the panel film and fully opaque", () => {
    const element = root();
    applyTheme(themeWith({ glassOpacity: 55 }), element);

    const control = Number.parseFloat(read(element, "--glass-control-opacity"));
    expect(control).toBeGreaterThan(55);
    expect(control).toBeLessThan(100);
  });

  it("follows the opacity axis rather than being pinned", () => {
    const solid = root();
    applyTheme(themeWith({ glassOpacity: 80 }), solid);
    const sheer = root();
    applyTheme(themeWith({ glassOpacity: 20 }), sheer);

    expect(Number.parseFloat(read(solid, "--glass-control-opacity"))).toBeGreaterThan(
      Number.parseFloat(read(sheer, "--glass-control-opacity")),
    );
  });
});

describe("the second accent", () => {
  /*
   * Chrome and artwork are different jobs. The first accent carries
   * interactive state and has to stay legible on the surfaces it sits on; the
   * second is for what is *drawn* - icon and SVG fills, where the colour is the
   * content rather than a signal about it.
   *
   * Empty follows the first, so a record written before this axis existed
   * renders exactly as it did.
   */
  it("is cleared when unset, rather than mirroring the first accent", () => {
    const element = root();
    applyTheme(themeWith({ accent: "#3366cc" }), element);

    /*
     * Cleared, so the stylesheet's own artwork fallback decides. Mirroring the
     * control accent here is what let picking a control colour repaint every
     * icon in the window, since `svg:not(.az-icon-inherit)` colours from this
     * token.
     */
    expect(read(element, "--color-accent-2")).toBe("");
  });

  it("takes its own colour once chosen", () => {
    const element = root();
    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "#cc3366" }), element);

    expect(read(element, "--color-accent-2")).toBe("#cc3366");
    expect(read(element, "--color-primary-fill")).toBe("#3366cc");
  });

  it("gets its own readable ink rather than the first accent's", () => {
    const element = root();
    // A near-white second accent needs dark ink even when the first is dark.
    applyTheme(themeWith({ accent: "#111111", accentTwo: "#eeeeee" }), element);

    const ink = read(element, "--color-accent-2-content");
    expect(ink).not.toBe("");
    expect(ink).not.toBe(read(element, "--color-accent-content"));
  });

  it("ignores a value that is not a hex colour", () => {
    const element = root();
    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "not a colour" }), element);

    // A value that is not a colour is treated as unset, so the token is cleared
    // rather than falling back to the control accent.
    expect(read(element, "--color-accent-2")).toBe("");
  });
});

describe("the accent as text", () => {
  /*
   * `text-primary` on `bg-primary/8` is an accent chip: both sides resolve to
   * the same hue, so a dark accent makes the label and its background the same
   * colour. Measured through the renderer's computed styles at accent #662d21 -
   * four elements at a contrast ratio of exactly 1.00 and 97 under 3.0.
   */
  const luminance = (hex: string) => {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    const channel = (at: number) => {
      const srgb = Number.parseInt(full.slice(at, at + 2), 16) / 255;
      return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  };
  const against = (hex: string, desk: number) => {
    const l = luminance(hex);
    const [hi, lo] = l > desk ? [l, desk] : [desk, l];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("lifts a dark accent until it can be read on a dark desk", () => {
    const element = root();
    // The accent that produced the 1.00 ratios in the live window.
    applyTheme(themeWith({ accent: "#662d21" }), element);

    const text = read(element, "--color-primary-text");
    expect(text).not.toBe("");
    expect(against(text, 0.02)).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves an already legible accent alone", () => {
    const element = root();
    applyTheme(themeWith({ accent: "#e8c15a" }), element);

    expect(read(element, "--color-primary-text").toLowerCase()).toBe("#e8c15a");
  });

  it("keeps the fill accent unchanged, so only text moves", () => {
    const element = root();
    applyTheme(themeWith({ accent: "#662d21" }), element);

    // The fill keeps the picked colour; the text token carries the lift.
    expect(read(element, "--color-primary-fill")).toBe("#662d21");
    expect(read(element, "--color-primary-text")).not.toBe("#662d21");
  });
});

describe("the second accent reaches the icons, not just the token", () => {
  /*
   * The token resolving is not the feature. Inline SVG is serialised and handed
   * to usvg with `currentColor` already substituted, and that tree is rebuilt
   * only on construction damage - which writing a custom property on the root
   * does not produce. So an icon keeps the stroke it was built with while
   * `--color-accent-2` reads correctly, which is exactly how this shipped
   * "working" twice.
   */
  it("writes the picked colour onto the icon's stroke attribute", () => {
    const element = root();
    const icon = element.ownerDocument.createElement("svg");
    icon.setAttribute("stroke", "currentColor");
    // Inside the themed root: the repaint is scoped to the tree it is handed,
    // so an icon parked on `body` is deliberately out of scope.
    element.appendChild(icon);

    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "#cc3366" }), element);

    expect(icon.getAttribute("stroke")).toBe("#cc3366");
    icon.remove();
  });

  it("leaves an icon that follows its label alone", () => {
    const element = root();
    const wrapper = element.ownerDocument.createElement("span");
    wrapper.className = "az-icon-inherit";
    const icon = element.ownerDocument.createElement("svg");
    icon.setAttribute("stroke", "currentColor");
    wrapper.appendChild(icon);
    element.appendChild(wrapper);

    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "#cc3366" }), element);

    expect(icon.getAttribute("stroke")).toBe("currentColor");
    wrapper.remove();
  });
});

describe("an icon that mounts after the pick", () => {
  /*
   * The reported symptom: the top-right icons kept the old colour until an
   * unrelated setting was changed. `applyTheme` only runs when a theme value
   * changes, so chrome that mounts later never got restroked.
   *
   * A `MutationObserver` was the obvious fix and is not available: this
   * renderer has none, and constructing one threw during startup, which
   * surfaced as the workspace failing to load. So the accent is published as a
   * signal and `Icon` reads it while rendering.
   */
  it("publishes the picked accent for icons that render later", () => {
    const element = root();
    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "#cc3366" }), element);

    expect(iconStrokeColor()).toBe("#cc3366");
  });

  it("does not stroke with the first accent when no second one is picked", () => {
    const element = root();
    applyTheme(themeWith({ accent: "#3366cc" }), element);

    /*
     * No second accent means no restroke at all, so an icon keeps whatever the
     * stylesheet gives it. Stroking with the control accent here is what made
     * the gear in the title bar flash accent 1 on a fresh load.
     */
    expect(iconStrokeColor()).not.toBe("#3366cc");
  });
});

describe("a picked accent paints before the store write", () => {
  /*
   * `onPick` reaches the tokens only once a settings round trip has returned,
   * so picking quickly queued one write per pick behind the event loop. On the
   * stall frames `max_interval_ms` reached 70 to 92 while `paint_avg_ms` and
   * `renderer_avg_ms` were both 0.00: the renderer did no work at all, so the
   * delay was the loop waiting rather than anything being drawn. That is why
   * reducing renderer work did not move it.
   */
  it("writes the accent tokens without waiting for a save", () => {
    const element = root();
    writeAccentPreview("#3366cc", { root: element });

    expect(read(element, "--color-primary-fill")).toBe("#3366cc");
    // The artwork token is left alone: picking a control accent must not
    // repaint the icons, which is the whole reason the axes are separate.
    expect(read(element, "--color-accent-2")).toBe("");
  });

  it("keeps an independently chosen artwork accent", () => {
    const element = root();
    writeAccentPreview("#3366cc", { accentTwo: "#cc3366", root: element });

    expect(read(element, "--color-primary-fill")).toBe("#3366cc");
    expect(read(element, "--color-accent-2")).toBe("#cc3366");
  });

  it("agrees with what applyTheme writes for the same pick", () => {
    // The preview and the persisted path must not drift: a pick that painted
    // one colour and settled to another would read as a flicker.
    const previewed = root();
    writeAccentPreview("#3366cc", { accentTwo: "#cc3366", root: previewed });

    const applied = root();
    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "#cc3366" }), applied);

    for (const token of ["--color-accent-2", "--color-accent-2-content", "--color-primary-fill"]) {
      expect(read(previewed, token), token).toBe(read(applied, token));
    }
  });
});
