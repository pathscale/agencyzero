import { type JSX, Match, Show, Switch } from "solid-js";
import { IconSprite } from "~/components/IconSprite";
import { DraftTab } from "~/features/draft/DraftTab";
import { HomeTab } from "~/features/home/HomeTab";
import { ProjectTab } from "~/features/project/ProjectTab";
import { SettingsTab } from "~/features/settings/SettingsTab";
import { TabStrip } from "~/features/tabs/TabStrip";
import { useWorkspace, WorkspaceProvider } from "~/stores/workspace";

/**
 * The window: a tab strip over one screen at a time.
 *
 * Only the active tab is mounted. A background tab holds no DOM — its state
 * lives in the workspace store and its dot in the strip, which is the whole
 * point of the dot.
 */
function Workspace(): JSX.Element {
  const { state, activeTab, activeProject } = useWorkspace();

  return (
    <div class="az-desk flex h-full flex-col overflow-hidden">
      <TabStrip />

      <main class="flex min-h-0 flex-1 gap-3 px-3 pt-1.5 pb-3">
        <Show when={state.isLoaded} fallback={<Booting />}>
          <Switch>
            <Match when={activeTab().kind === "home"}>
              <HomeTab />
            </Match>
            <Match when={activeTab().kind === "settings"}>
              <SettingsTab />
            </Match>
            <Match when={activeTab().kind === "draft"}>
              <DraftTab tab={activeTab()} />
            </Match>
            <Match when={activeTab().kind === "project" && activeProject()}>
              {(project) => <ProjectTab tab={activeTab()} project={project()} />}
            </Match>
          </Switch>
        </Show>
      </main>

      <Show when={state.backend === "mock"}>
        <MockBanner />
      </Show>
    </div>
  );
}

function Booting(): JSX.Element {
  return (
    <div class="flex flex-1 items-center justify-center text-[12.5px] text-az-muted">
      Loading workspace…
    </div>
  );
}

/**
 * Says out loud that nothing here is real.
 *
 * Fixtures that look like live data are the failure mode this whole layer
 * risks, so the window states which backend it is on rather than letting a
 * screenshot imply a working agent.
 */
function MockBanner(): JSX.Element {
  return (
    <div class="flex flex-none items-center justify-center gap-2 border-az-hairline-soft border-t px-3 py-1.5 text-[10.5px] text-az-faint">
      <span class="size-1.5 rounded-full bg-warning" />
      Design fixtures — the Rust commands are not implemented yet
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <>
      <IconSprite />
      <WorkspaceProvider>
        <Workspace />
      </WorkspaceProvider>
    </>
  );
}
