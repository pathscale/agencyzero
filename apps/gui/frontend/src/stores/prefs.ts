import { createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import type { PortableUiPrefs, UiPrefs } from "~/types";

const STORAGE_KEY = "agencyzero:ui-prefs";
const PORTABLE_REVISION_KEY = "agencyzero:portable-ui-prefs-revision";

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

function load(): UiPrefs {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return normalize(JSON.parse(raw) as Partial<UiPrefs>);
  } catch {
    // A prefs file we can't read is not worth failing a launch over.
    return DEFAULTS;
  }
}

/**
 * GUI-local preferences: which sections are open, what a new tab starts with,
 * where the window was left.
 *
 * Deliberately outside the Project and ProjectItem model — these are per
 * install, not per project, and they must not travel with a session.
 */
const [prefs, setPrefs] = createStore<UiPrefs>(load());

createEffect(() => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked — the app still works, it just forgets.
  }
});

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

/** Apply a restored preference snapshot without replacing local unfinished text. */
export function restorePortablePrefs(stored: Partial<PortableUiPrefs>, revision: string): void {
  if (!revision || Object.keys(stored).length === 0) return;
  if (localStorage.getItem(PORTABLE_REVISION_KEY) === revision) return;
  setPrefs(
    normalize({
      ...stored,
      composerDrafts: prefs.composerDrafts,
      replyQuestionIds: prefs.replyQuestionIds,
    }),
  );
  localStorage.setItem(PORTABLE_REVISION_KEY, revision);
}

/** Mark the local snapshot current after capturing it into this same store. */
export function markPortablePrefsCurrent(revision: string): void {
  if (revision) localStorage.setItem(PORTABLE_REVISION_KEY, revision);
}

/** Force a selected backup's snapshot to apply after the restore relaunch. */
export function preparePortablePrefsRestore(): void {
  localStorage.removeItem(PORTABLE_REVISION_KEY);
}

export function togglePanelSection(section: keyof UiPrefs["panelSections"]): void {
  setPrefs("panelSections", section, (open) => !open);
}
