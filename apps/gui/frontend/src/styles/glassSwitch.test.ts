import { describe, expect, it } from "vitest";
import { applyTheme } from "~/lib/theme";
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
  it("follows the first accent when unset", () => {
    const element = root();
    applyTheme(themeWith({ accent: "#3366cc" }), element);

    expect(read(element, "--color-accent-2")).toBe(read(element, "--color-accent"));
  });

  it("takes its own colour once chosen", () => {
    const element = root();
    applyTheme(themeWith({ accent: "#3366cc", accentTwo: "#cc3366" }), element);

    expect(read(element, "--color-accent-2")).toBe("#cc3366");
    expect(read(element, "--color-accent")).toBe("#3366cc");
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

    expect(read(element, "--color-accent-2")).toBe(read(element, "--color-accent"));
  });
});
