import { createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import type { PortableUiPrefs, UiPrefs } from "~/types";

export const UI_SCALES: Record<UiPrefs["uiSize"], number> = {
  normal: 1,
  large: 1.08,
  "extra-large": 1.16,
};

const DEFAULTS: UiPrefs = {
  lastModel: "sonnet",
  lastPermission: "read_only",
  uiSize: "large",
  colorMode: "dark",
  projectPanelVisible: true,
  itemSortBy: "status",
  itemSortDirection: "asc",
  homeSortBy: "status",
  homeSortDirection: "asc",
  lastExtraThinking: true,
  // Settings starts collapsed: working directories are set once and then left
  // alone, while the other three change while you watch.
  // `io` open by default: it is the panel you want the moment something looks
  // wrong, and closed-by-default made it effectively invisible.
  panelSections: {
    usage: true,
    settings: false,
    items: true,
    running: true,
    log: true,
    io: true,
    pinned: true,
    recent: true,
    homeIo: true,
    tmDebug: false,
    // Closed by default: empty until a compaction has happened, so an open
    // section reading "nothing kept yet" on every project would be furniture.
    notes: false,
  },
  lastTabKey: "home",
  openTabKeys: [],
  collapsedGroups: [],
  advancedComposerKeys: [],
  expandedComposerKeys: [],
  taskPlacement: "panel",
  seenSections: [],
  composerDrafts: {},
  replyQuestionIds: {},
  costWarningsDisabled: false,
  costWarningSnoozedUntil: 0,
  costWarningDismissals: 0,
};

/**
 * Sections whose default has changed since they were first shipped.
 *
 * Stored prefs win over defaults, which is right for a section someone has
 * actually collapsed and wrong for one that shipped closed, was never seen, and
 * has since been made to open by default. Dropping the stored value once lets
 * the new default through; after that the user's own choice sticks, because
 * `seenSections` records that the reset has happened.
 *
 * Agent I/O is here because it shipped closed at the bottom of a scrolling
 * column, which made it invisible rather than merely collapsed.
 */
const RESET_ONCE: (keyof UiPrefs["panelSections"])[] = ["io"];

function normalize(stored: Partial<UiPrefs>): UiPrefs {
  const seen = new Set(stored.seenSections ?? []);
  const sections = { ...DEFAULTS.panelSections, ...stored.panelSections };
  for (const section of RESET_ONCE) {
    if (!seen.has(section)) sections[section] = DEFAULTS.panelSections[section];
  }

  return {
    ...DEFAULTS,
    ...stored,
    uiSize: stored.uiSize && stored.uiSize in UI_SCALES ? stored.uiSize : DEFAULTS.uiSize,
    colorMode:
      stored.colorMode === "light" || stored.colorMode === "dark"
        ? stored.colorMode
        : DEFAULTS.colorMode,
    itemSortBy:
      stored.itemSortBy === "status" || stored.itemSortBy === "time"
        ? stored.itemSortBy
        : DEFAULTS.itemSortBy,
    itemSortDirection:
      stored.itemSortDirection === "asc" || stored.itemSortDirection === "desc"
        ? stored.itemSortDirection
        : DEFAULTS.itemSortDirection,
    homeSortBy:
      stored.homeSortBy === "status" ||
      stored.homeSortBy === "time" ||
      stored.homeSortBy === "turns"
        ? stored.homeSortBy
        : stored.itemSortBy === "status" || stored.itemSortBy === "time"
          ? stored.itemSortBy
          : DEFAULTS.homeSortBy,
    homeSortDirection:
      stored.homeSortDirection === "asc" || stored.homeSortDirection === "desc"
        ? stored.homeSortDirection
        : stored.itemSortDirection === "asc" || stored.itemSortDirection === "desc"
          ? stored.itemSortDirection
          : DEFAULTS.homeSortDirection,
    taskPlacement:
      stored.taskPlacement === "panel" ||
      stored.taskPlacement === "dock" ||
      stored.taskPlacement === "inline"
        ? stored.taskPlacement
        : DEFAULTS.taskPlacement,
    panelSections: sections,
    seenSections: [...new Set([...seen, ...RESET_ONCE])],
  };
}

/**
 * UI preferences: which sections are open, what a new tab starts with, and
 * where the window was left.
 *
 * WorkTable's settings row is the sole durable source. This store starts from
 * defaults and is hydrated before the workspace paints; no browser database
 * exists in the pure-Rust Blitz runtime.
 */
const [prefs, setPrefs] = createStore<UiPrefs>(DEFAULTS);

createEffect(() => {
  if (typeof document === "undefined") return;
  const scale = UI_SCALES[prefs.uiSize];
  document.documentElement.style.setProperty("--az-ui-scale", String(scale));
});

createEffect(() => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.colorMode = prefs.colorMode;
  document.documentElement.style.colorScheme = prefs.colorMode;
});

export { prefs, setPrefs };

/** Snapshot only durable choices; drafts and staged replies are live owner content. */
export function portablePrefsSnapshot(): PortableUiPrefs {
  const snapshot = JSON.parse(JSON.stringify(prefs)) as UiPrefs;
  const { composerDrafts: _drafts, replyQuestionIds: _replies, ...portable } = snapshot;
  return portable;
}

/**
 * Compare JSON-shaped preference records structurally.
 *
 * Rust stores these preferences as `serde_json::Value`, whose object key order
 * is not part of the value contract. Comparing `JSON.stringify` output made a
 * response with reordered keys look different forever, so the 250 ms autosave
 * wrote the same settings row continuously while the app was idle.
 */
export function samePortablePrefs(left: unknown, right: unknown): boolean {
  if (left === right) return true;

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => samePortablePrefs(value, right[index]))
    );
  }

  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) && samePortablePrefs(leftRecord[key], rightRecord[key]),
    )
  );
}

let portableRevisionFallback = "";

function readPortableRevision(): string {
  return portableRevisionFallback;
}

function writePortableRevision(revision: string): void {
  portableRevisionFallback = revision;
}

/** Apply a restored preference snapshot without replacing local unfinished text. */
export function restorePortablePrefs(stored: Partial<PortableUiPrefs>, revision: string): void {
  if (!revision || Object.keys(stored).length === 0) return;
  if (readPortableRevision() === revision) return;
  setPrefs(
    normalize({
      ...stored,
      composerDrafts: prefs.composerDrafts,
      replyQuestionIds: prefs.replyQuestionIds,
    }),
  );
  writePortableRevision(revision);
}

/** Mark the local snapshot current after capturing it into this same store. */
export function markPortablePrefsCurrent(revision: string): void {
  if (revision) writePortableRevision(revision);
}

/** Force a selected backup's snapshot to apply after the restore relaunch. */
export function preparePortablePrefsRestore(): void {
  writePortableRevision("");
}

export function togglePanelSection(section: keyof UiPrefs["panelSections"]): void {
  setPrefs("panelSections", section, (open) => !open);
}
