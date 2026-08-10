import { describe, expect, it } from "vitest";
import {
  portablePrefsSnapshot,
  prefs,
  preparePortablePrefsRestore,
  restorePortablePrefs,
  samePortablePrefs,
  setPrefs,
  UI_SCALES,
} from "~/stores/prefs";

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
  it("treats reordered backend preference keys as the same JSON value", () => {
    const local = {
      panelSections: { usage: true, settings: false },
      openTabKeys: ["agencyzero", "worktable"],
    };
    const backend = {
      openTabKeys: ["agencyzero", "worktable"],
      panelSections: { settings: false, usage: true },
    };

    expect(samePortablePrefs(local, backend)).toBe(true);
    expect(samePortablePrefs(local, { ...backend, openTabKeys: ["worktable"] })).toBe(false);
  });

  it("normalizes restored enum preferences before controls consume them", () => {
    preparePortablePrefsRestore();
    restorePortablePrefs(
      {
        itemSortBy: "unknown",
        itemSortDirection: "sideways",
        homeSortBy: "unknown",
        homeSortDirection: "sideways",
        taskPlacement: "somewhere",
      } as unknown as Parameters<typeof restorePortablePrefs>[0],
      "invalid-enums",
    );

    expect(prefs.itemSortBy).toBe("status");
    expect(prefs.itemSortDirection).toBe("asc");
    expect(prefs.homeSortBy).toBe("status");
    expect(prefs.homeSortDirection).toBe("asc");
    expect(prefs.taskPlacement).toBe("panel");
  });

  it("persists sidebar visibility and expanded composers as UI preferences", () => {
    setPrefs("projectPanelVisible", false);
    setPrefs("expandedComposerKeys", ["project:abc"]);

    expect(prefs.projectPanelVisible).toBe(false);
    expect(prefs.expandedComposerKeys).toEqual(["project:abc"]);

    setPrefs("projectPanelVisible", true);
    setPrefs("expandedComposerKeys", []);
  });

  it("backs up stable preferences and leaves unfinished owner text local", () => {
    setPrefs("uiSize", "extra-large");
    setPrefs("expandedComposerKeys", ["project:abc"]);
    setPrefs("composerDrafts", "project:abc", "unfinished message");
    setPrefs("replyQuestionIds", "project:abc", "question-1");

    const snapshot = portablePrefsSnapshot();
    expect(snapshot.uiSize).toBe("extra-large");
    expect(snapshot.expandedComposerKeys).toEqual(["project:abc"]);
    expect(snapshot).not.toHaveProperty("composerDrafts");
    expect(snapshot).not.toHaveProperty("replyQuestionIds");

    preparePortablePrefsRestore();
    restorePortablePrefs({ uiSize: "normal", expandedComposerKeys: [] }, "backup-1");
    expect(prefs.uiSize).toBe("normal");
    expect(prefs.expandedComposerKeys).toEqual([]);
    expect(prefs.composerDrafts["project:abc"]).toBe("unfinished message");
    expect(prefs.replyQuestionIds["project:abc"]).toBe("question-1");

    setPrefs("uiSize", "extra-large");
    restorePortablePrefs({ uiSize: "normal" }, "backup-1");
    expect(prefs.uiSize).toBe("extra-large");

    preparePortablePrefsRestore();
    restorePortablePrefs({ uiSize: "normal" }, "backup-1");
    expect(prefs.uiSize).toBe("normal");

    setPrefs("composerDrafts", "project:abc", "");
    setPrefs("replyQuestionIds", "project:abc", "");
  });

  it("restores portable preferences from a WorkTable settings snapshot", () => {
    setPrefs("uiSize", "extra-large");
    expect(() => preparePortablePrefsRestore()).not.toThrow();
    expect(() => restorePortablePrefs({ uiSize: "normal" }, "worktable-backup")).not.toThrow();
    expect(prefs.uiSize).toBe("normal");
  });
});
