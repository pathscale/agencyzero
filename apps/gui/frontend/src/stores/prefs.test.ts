import { describe, expect, it } from "vitest";
import { prefs, setPrefs, UI_SCALES } from "~/stores/prefs";

describe("interface size", () => {
  it("offers the three ordered scales requested by the picker", () => {
    expect(UI_SCALES).toEqual({ normal: 1, large: 1.08, "extra-large": 1.16 });
  });

  it("applies a picked scale without shrinking the viewport twice", async () => {
    setPrefs("uiSize", "extra-large");
    await Promise.resolve();

    expect(prefs.uiSize).toBe("extra-large");
    expect(document.documentElement.style.getPropertyValue("--az-ui-scale")).toBe("1.16");
    expect(document.documentElement.style.getPropertyValue("--az-ui-inverse-scale")).toBe("");
  });
});

describe("colour mode", () => {
  it("persists the selected palette on the document root", async () => {
    setPrefs("colorMode", "light");
    await Promise.resolve();

    expect(prefs.colorMode).toBe("light");
    expect(document.documentElement.dataset.colorMode).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");

    setPrefs("colorMode", "dark");
  });
});

describe("workspace layout", () => {
  it("persists sidebar visibility and expanded composers as UI preferences", () => {
    setPrefs("projectPanelVisible", false);
    setPrefs("expandedComposerKeys", ["project:abc"]);

    expect(prefs.projectPanelVisible).toBe(false);
    expect(prefs.expandedComposerKeys).toEqual(["project:abc"]);

    setPrefs("projectPanelVisible", true);
    setPrefs("expandedComposerKeys", []);
  });
});
