import { createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import type { UiPrefs } from "~/types";

const STORAGE_KEY = "agencyzero:ui-prefs";

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

function load(): UiPrefs {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const stored = JSON.parse(raw) as Partial<UiPrefs> & { seenSections?: string[] };

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
      panelSections: sections,
      seenSections: [...new Set([...seen, ...RESET_ONCE])],
    };
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

export function togglePanelSection(section: keyof UiPrefs["panelSections"]): void {
  setPrefs("panelSections", section, (open) => !open);
}
