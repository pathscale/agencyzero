import type { JSX } from "@solidjs/web";
import { createMemo, Match, Show, Switch } from "solid-js";
import { AnalyticsTab } from "~/features/analytics/AnalyticsTab";
import { HomeTab } from "~/features/home/HomeTab";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { ProjectTab } from "~/features/project/ProjectTab";
import { SettingsTab } from "~/features/settings/SettingsTab";
import { prefs } from "~/stores/prefs";
import { useWorkspace } from "~/stores/workspace";
import type { Project, Tab } from "~/types";

/** The active project's side panel, mounted in the same render as its pane. */
function ActiveProjectPanel(): JSX.Element {
  const { state } = useWorkspace();
  const currentProject = () =>
    state.projects.find((candidate) => candidate.id === state.activeKey) ?? null;
  const shown = () =>
    Boolean(currentProject()) && prefs.projectPanelVisible && !currentProject()?.forkedFrom?.itemId;
  const active = createMemo<{ project: Project; tab: Tab } | null>(() => {
    const project = currentProject();
    const tab = state.tabs.find((candidate) => candidate.key === state.activeKey);
    return project && tab && shown() ? { project, tab } : null;
  });

  return (
    <div
      id={currentProject() ? `project-${currentProject()!.id}-panel` : undefined}
      aria-hidden={shown() ? "false" : "true"}
      class={`min-h-0 flex-none overflow-hidden ${
        shown()
          ? "ml-8 w-[332px] translate-x-0 opacity-100"
          : "pointer-events-none ml-8 w-0 translate-x-8 opacity-0"
      }`}
    >
      <Show when={active()}>
        {(current) => <ProjectPanel project={current().project} agent={current().tab.agent} />}
      </Show>
    </div>
  );
}

/** Exactly one active workspace pane and one project-side owner. */
export function WorkspacePanes(): JSX.Element {
  const { activeTab, activeProject } = useWorkspace();

  return (
    <Switch>
      <Match when={activeTab().kind === "home"}>
        <div data-active-tab="home" class="flex min-h-0 min-w-0 flex-1">
          <HomeTab />
        </div>
      </Match>
      <Match when={activeTab().kind === "settings"}>
        <div data-active-tab="settings" class="flex min-h-0 min-w-0 flex-1">
          <SettingsTab />
        </div>
      </Match>
      <Match when={activeTab().kind === "analytics"}>
        <div data-active-tab="analytics" class="flex min-h-0 min-w-0 flex-1">
          <AnalyticsTab />
        </div>
      </Match>
      <Match when={activeTab().kind === "project" && activeProject() !== null}>
        <div class="flex min-h-0 min-w-0 flex-1">
          {/* Keep one gutter in both panel states. The toggle stays attached to
              this boundary; only its arrow changes direction. The side panel
              begins after the standard tab's outer padding. */}
          <div class="relative min-h-0 min-w-0 flex-1">
            <div
              data-active-project={activeProject()?.id}
              class="absolute inset-0 flex min-h-0 min-w-0"
            >
              <ProjectTab tab={activeTab()} project={activeProject()!} />
            </div>
          </div>
          <ActiveProjectPanel />
        </div>
      </Match>
    </Switch>
  );
}
