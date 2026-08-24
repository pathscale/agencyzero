import { Flex } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, Match, onCleanup, onSettled, Show, Switch } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { AnalyticsTab } from "~/features/analytics/AnalyticsTab";
import { DraftTab } from "~/features/draft/DraftTab";
import { HomeTab } from "~/features/home/HomeTab";
import { WelcomeFlow } from "~/features/onboarding/WelcomeFlow";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { ProjectTab } from "~/features/project/ProjectTab";
import { SettingsTab } from "~/features/settings/SettingsTab";
import { CloseConfirm } from "~/features/shell/CloseConfirm";
import { useAppShell } from "~/features/shell/useAppShell";
import { TabStrip } from "~/features/tabs/TabStrip";
import { installSelectionCopy } from "~/lib/clipboard";
import { log } from "~/lib/log";
import { tx } from "~/stores/i18n";
import { prefs } from "~/stores/prefs";
import { type BootState, useWorkspace, WorkspaceProvider } from "~/stores/workspace";
import type { Project, Tab } from "~/types";

/**
 * The one side panel, pointed at whichever project is in front.
 *
 * Built once while project tabs remain active: the project it reads changes,
 * its DOM does not. Leaving the project surface unmounts the branch.
 *
 * Its contents are absent when a fork is open or the sidebar is collapsed, so
 * controls nobody can reach do not remain in the semantic or layout tree.
 */
function ActiveProjectPanel(): JSX.Element {
  const { state } = useWorkspace();
  /*
   * The transcript and composer are the project surface; the side panel is
   * supplementary. Give the main surface one paint before constructing the
   * panel's paged item and task-log trees, so opening a project cannot spend
   * several seconds on an optional column before `Send` becomes usable.
   */
  const [panelReady, setPanelReady] = createSignal(false);
  let readyFrame: number | undefined;
  let readyTimer: number | undefined;
  onSettled(() => {
    const mount = (): void => {
      readyTimer = window.setTimeout(() => setPanelReady(true), 0);
    };
    if (typeof requestAnimationFrame === "undefined") mount();
    else readyFrame = requestAnimationFrame(mount);
    return () => {
      if (readyFrame !== undefined) cancelAnimationFrame(readyFrame);
      if (readyTimer !== undefined) window.clearTimeout(readyTimer);
    };
  });
  /*
   * A signal makes the active project and tab one reactive value. The enclosing
   * project `Match` disposes this component before `activeKey` can represent a
   * non-project surface.
   */
  const [lastSeen, setLastSeen] = createSignal<{ project: Project; tab: Tab } | null>(null);
  createEffect(
    () => {
      const project = state.projects.find((candidate) => candidate.id === state.activeKey);
      const tab = state.tabs.find((candidate) => candidate.key === state.activeKey);
      return project && tab ? { project, tab } : null;
    },
    (current) => {
      if (current) setLastSeen(current);
    },
  );
  const active = lastSeen;
  /*
   * A fork's pane hides the panel: its column is the fork's parent context, and
   * the fork has none of its own. Read here rather than passed down, so the
   * panel does not need to know which pane is in front.
   */
  const forked = () => Boolean(active()?.project.forkedFrom?.itemId);
  const shown = () => Boolean(active()) && prefs.projectPanelVisible && !forked();

  return (
    <div
      aria-hidden={shown() ? "false" : "true"}
      class={`min-h-0 flex-none overflow-hidden ${
        shown()
          ? "ml-4 w-[332px] translate-x-0 opacity-100"
          : "pointer-events-none ml-0 w-0 translate-x-3 opacity-0"
      }`}
    >
      <Show when={shown() && panelReady() ? active() : null}>
        {(current) => <ProjectPanel project={current().project} agent={current().tab.agent} />}
      </Show>
    </div>
  );
}

/**
 * The window: a tab strip over one screen at a time.
 *
 * Exactly one surface is mounted. Project tabs share one `Match` branch, so a
 * project-to-project switch re-points one component tree at the new store keys
 * instead of keeping an invisible tree for every recently visited project.
 * This matters in Blitz: a `display:none` ancestor does not reliably release
 * its descendants' layout boxes, so retained controls remain addressable to
 * automation and keep the renderer walking work nobody can see.
 */
export function Workspace(): JSX.Element {
  const { state, actions, activeTab, activeProject } = useWorkspace();
  const shell = useAppShell();

  return (
    <div class="az-desk relative flex h-full flex-col overflow-hidden">
      <Show when={state.boot.status !== "loading"}>
        <TabStrip />
      </Show>

      <Show when={shell.persistenceFailure()}>
        {(failure) => (
          <div
            role="alert"
            class="mx-3 mt-1.5 flex flex-none items-start gap-2 rounded-lg border border-error/35 bg-error/12 px-3 py-2 text-[11.5px] text-error"
          >
            <Icon name="shield" class="mt-px shrink-0 text-[14px]" />
            <div class="min-w-0">
              <p class="font-semibold">{tx("Storage stopped saving")}</p>
              <p data-selectable class="mt-0.5 break-words font-mono text-[10.5px] leading-[1.45]">
                {failure()}
              </p>
              <p class="mt-1 text-az-body">
                {tx("Copy anything important from the current turn, then restart AgencyZero.")}
              </p>
            </div>
          </div>
        )}
      </Show>

      <main class="flex min-h-0 flex-1 gap-3 px-3 pt-1.5 pb-3">
        {/*
          `Switch`, not a `Show` with a `Show` in its fallback.
          The nested form kept the splash mounted for the whole session: it was
          laid out at the full size of the window from the first frame, over the
          real content, and painted its own background into whichever panel it
          landed in. That is the blank page, and its `animate-pulse` also kept
          the document animating, which is a render loop for as long as the app
          is open. `Switch` renders exactly one branch and unmounts the others.
        */}
        <Switch
          fallback={
            <BootFailed
              /*
               * The union is narrowed through an explicit alias. Solid 2's
               * store proxy maps each property through a wrapper type, and the
               * discriminant check on `state.boot.status` no longer tells the
               * checker which arm `state.boot` is, so the `message` arm reads
               * as absent.
               */
              message={
                (state.boot as Extract<BootState, { status: "error" }>).status === "error"
                  ? (state.boot as Extract<BootState, { status: "error" }>).message
                  : ""
              }
              onRetry={() => void actions.retryInit()}
              onOpenSettings={actions.openSettings}
            />
          }
        >
          <Match when={state.boot.status === "loading"}>
            <Booting />
          </Match>
          <Match
            when={
              state.boot.status === "ready" ||
              (activeTab().kind === "settings" && state.settings !== null)
            }
          >
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
              <Match when={activeTab().kind === "draft"}>
                <div data-active-tab="draft" class="flex min-h-0 min-w-0 flex-1">
                  <DraftTab tab={activeTab()} />
                </div>
              </Match>
              <Match when={activeTab().kind === "project" && activeProject()}>
                {(project) => (
                  <div data-active-project={project().id} class="flex min-h-0 min-w-0 flex-1">
                    <ProjectTab tab={activeTab()} project={project()} />
                    <ActiveProjectPanel />
                  </div>
                )}
              </Match>
              <Match when={activeTab().kind === "project"}>
                {/*
                  A project tab whose record is not in state. Previously this matched
                  nothing and the window rendered an unexplained black void, which is
                  the worst possible failure: no content, no error, no way to tell a
                  missing record from a broken render.
                */}
                <div class="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-panel border border-az-hairline bg-az-sunken">
                  <p class="text-[13.5px] text-az-title">
                    {tx("This project could not be loaded")}
                  </p>
                  <p class="max-w-[420px] text-center text-[11.5px] text-az-muted">
                    {tx(
                      "The tab is open but its record is missing from the workspace. Reopening the window will re-read it from the database.",
                    )}
                  </p>
                </div>
              </Match>
            </Switch>
          </Match>
        </Switch>
      </main>

      <Show when={state.backend === "mock"}>
        <MockBanner />
      </Show>

      <WelcomeFlow />

      <CloseConfirm
        isOpen={shell.isClosing()}
        error={shell.closeError()}
        quitsProxy={shell.quitsProxy()}
        onCancel={shell.cancelClose}
        onConfirm={shell.confirmClose}
      />
    </div>
  );
}

export function Booting(): JSX.Element {
  /*
   * The splash is the whole window when it renders, so if it comes back after
   * boot the app looks blank. That has been reported and never reproduced by
   * driving, so it says when it arrives and when it leaves, with the reason it
   * was allowed to.
   */
  onSettled(() => log.warn("boot: splash mounted"));
  onCleanup(() => log.info("boot: splash unmounted"));

  return (
    <div
      role="status"
      aria-label={tx("Loading workspace…")}
      class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-panel border border-az-hairline bg-az-sunken"
    >
      <div class="absolute top-1/2 left-1/2 size-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-az-chip blur-[90px]" />
      <div class="relative flex flex-col items-center">
        <div class="az-halo-primary flex size-[58px] items-center justify-center rounded-[18px] border border-primary/28 bg-az-chip text-primary shadow-[0_16px_45px_rgb(from_var(--color-primary)_r_g_b/.12)]">
          <Icon name="sparkles" class="text-[27px]" />
        </div>
        <p class="mt-4 font-semibold text-[18px] text-az-title tracking-[-.02em]">
          {tx("AgencyZero")}
        </p>
        <p class="mt-1 text-[11.5px] text-az-muted">{tx("Loading workspace…")}</p>
        <div class="mt-4 h-1 w-32 overflow-hidden rounded-full bg-az-chip">
          <div class="h-full w-2/3 animate-pulse rounded-full bg-primary/65" />
        </div>
      </div>
    </div>
  );
}

/**
 * Boot failed, and says so.
 *
 * A half-loaded workspace must not render as though it were whole: the tabs
 * would be there, the panels would be empty, and nothing would explain why.
 */
export function BootFailed(props: {
  message: string;
  onRetry: () => void;
  onOpenSettings: () => void;
}): JSX.Element {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-3.5 px-8">
      <div class="flex size-[54px] items-center justify-center rounded-2xl border border-error/26 bg-error/8">
        <Icon name="shield" class="text-[24px] text-error" />
      </div>
      <div class="flex flex-col items-center gap-1.5">
        <p class="font-semibold text-[15px] text-base-content">
          {tx("Could not load the workspace")}
        </p>
        <p
          data-selectable
          class="max-w-[460px] text-center font-mono text-[11.5px] text-az-muted leading-[1.55]"
        >
          {props.message}
        </p>
      </div>
      <Flex align="center" gap="sm">
        <Button
          type="button"
          onClick={props.onRetry}
          class="rounded-lg bg-primary px-3.5 py-1.5 font-semibold text-[12.5px] text-primary-content transition-colors hover:bg-az-primary-hover"
        >
          {tx("Try again")}
        </Button>
        <Button
          type="button"
          onClick={props.onOpenSettings}
          class="rounded-lg border border-az-hairline px-3.5 py-1.5 font-semibold text-[12.5px] text-az-body transition-colors hover:bg-white/6 hover:text-base-content"
        >
          {tx("Open Settings")}
        </Button>
      </Flex>
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
      {tx("Design fixtures — the Rust commands are not implemented yet")}
    </div>
  );
}

export default function App(): JSX.Element {
  onSettled(() => {
    // Returned, not `onCleanup`: Solid 2 forbids it inside `onSettled`, and
    // this is the root component, so a throw here is the shape that leaves
    // `boot.status` stuck on "loading".
    return installSelectionCopy();
  });

  return (
    <WorkspaceProvider>
      <Workspace />
    </WorkspaceProvider>
  );
}
