import { createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import type { UiPrefs } from "~/types";

const STORAGE_KEY = "agencyzero:ui-prefs";

const DEFAULTS: UiPrefs = {
  lastModel: "sonnet",
  lastPermission: "read_only",
  // Settings starts collapsed: working directories are set once and then left
  // alone, while the other three change while you watch.
  panelSections: { settings: false, items: true, running: true, log: true },
  lastTabKey: "home",
  taskPlacement: "panel",
};

function load(): UiPrefs {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const stored = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      ...DEFAULTS,
      ...stored,
      panelSections: { ...DEFAULTS.panelSections, ...stored.panelSections },
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

export { prefs, setPrefs };

export function togglePanelSection(section: keyof UiPrefs["panelSections"]): void {
  setPrefs("panelSections", section, (open) => !open);
}
