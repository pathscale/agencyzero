import { flush } from "solid-js";
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
    expect(UI_SCALES).toEqual({ normal: 1, large: 1.12, "extra-large": 1.25 });
  });

  it("stores a picked scale", async () => {
    setPrefs((d) => {
      d.uiSize = "extra-large";
    });
    await Promise.resolve();

    expect(prefs.uiSize).toBe("extra-large");
  });
});

describe("colour mode", () => {
  it("stores the selected palette", async () => {
    setPrefs((d) => {
      d.colorMode = "light";
    });
    await Promise.resolve();

    expect(prefs.colorMode).toBe("light");

    setPrefs((d) => {
      d.colorMode = "dark";
    });
  });
});

describe("workspace layout", () => {
  it("treats reordered backend preference keys as the same JSON value", () => {
    const local = {
      panelSections: { usage: true, settings: false },
      openTabKeys: ["quux", "worktable"],
    };
    const backend = {
      openTabKeys: ["quux", "worktable"],
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
    setPrefs((d) => {
      d.projectPanelVisible = false;
    });
    setPrefs((d) => {
      d.expandedComposerKeys = ["project:abc"];
    });

    flush();

    expect(prefs.projectPanelVisible).toBe(false);
    expect(prefs.expandedComposerKeys).toEqual(["project:abc"]);

    setPrefs((d) => {
      d.projectPanelVisible = true;
    });
    setPrefs((d) => {
      d.expandedComposerKeys = [];
    });
  });

  it("backs up stable preferences and leaves unfinished owner text local", () => {
    setPrefs((d) => {
      d.uiSize = "extra-large";
    });
    setPrefs((d) => {
      d.expandedComposerKeys = ["project:abc"];
    });
    setPrefs((d) => {
      d.composerDrafts["project:abc"] = "unfinished message";
    });
    setPrefs((d) => {
      d.replyQuestionIds["project:abc"] = "question-1";
    });

    flush();
    const snapshot = portablePrefsSnapshot();
    expect(snapshot.uiSize).toBe("extra-large");
    expect(snapshot.expandedComposerKeys).toEqual(["project:abc"]);
    expect(snapshot).not.toHaveProperty("composerDrafts");
    expect(snapshot).not.toHaveProperty("replyQuestionIds");

    preparePortablePrefsRestore();
    restorePortablePrefs({ uiSize: "normal", expandedComposerKeys: [] }, "backup-1");
    flush();
    expect(prefs.uiSize).toBe("normal");
    expect(prefs.expandedComposerKeys).toEqual([]);
    expect(prefs.composerDrafts["project:abc"]).toBe("unfinished message");
    expect(prefs.replyQuestionIds["project:abc"]).toBe("question-1");

    setPrefs((d) => {
      d.uiSize = "extra-large";
    });
    restorePortablePrefs({ uiSize: "normal" }, "backup-1");
    flush();
    expect(prefs.uiSize).toBe("extra-large");

    preparePortablePrefsRestore();
    restorePortablePrefs({ uiSize: "normal" }, "backup-1");
    flush();
    expect(prefs.uiSize).toBe("normal");

    setPrefs((d) => {
      d.composerDrafts["project:abc"] = "";
    });
    setPrefs((d) => {
      d.replyQuestionIds["project:abc"] = "";
    });
  });

  it("restores portable preferences from a WorkTable settings snapshot", () => {
    setPrefs((d) => {
      d.uiSize = "extra-large";
    });
    expect(() => preparePortablePrefsRestore()).not.toThrow();
    expect(() => restorePortablePrefs({ uiSize: "normal" }, "worktable-backup")).not.toThrow();
    expect(prefs.uiSize).toBe("normal");
  });
});
