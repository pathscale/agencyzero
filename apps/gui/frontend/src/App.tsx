import { Flex } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { IconSprite } from "~/components/IconSprite";
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
 * Built once for the life of the window and never gated on a `Show`: the
 * project it reads changes, its DOM does not. `ProjectPanel` already reads
 * everything through `props.project.id`, so re-pointing it is the whole
 * mechanism.
 *
 * Hidden rather than removed when a fork is open or the sidebar is collapsed,
 * for the same reason the panes are: removing it would reconstruct it, which is
 * exactly what this exists to stop.
 */
function ActiveProjectPanel(): JSX.Element {
  const { state } = useWorkspace();
  /*
   * The last project seen, not merely the active one.
   *
   * `activeKey` is Home or Settings as often as it is a project, and letting
   * this go null there would dispose the panel and rebuild it on the way back,
   * which is the reconstruction this whole arrangement exists to remove. Once a
   * project has been opened the panel stays pointed at one; the container above
   * hides it while a non-project tab is in front.
   */
  let lastSeen: { project: Project; tab: Tab } | null = null;
  const active = createMemo(() => {
    const project = state.projects.find((candidate) => candidate.id === state.activeKey);
    const tab = state.tabs.find((candidate) => candidate.key === state.activeKey);
    if (project && tab) lastSeen = { project, tab };
    return lastSeen;
  });
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
      <Show when={active()}>
        {(current) => <ProjectPanel project={current().project} agent={current().tab.agent} />}
      </Show>
    </div>
  );
}

/**
 * How many project panes keep their DOM while not on screen.
 *
 * A retained pane is hidden, not absent: it holds its whole subtree, its style
 * and layout nodes and its Solid reactive graph. Measured against the live app,
 * one pane is about a thousand DOM nodes, and at eight the hidden panes held
 * 5,461 of 10,988 nodes, half the tree, for panes nobody was looking at.
 *
 * Two was chosen for "the pane in front of you and the one you just came from",
 * and that is not how the window is used. Working across three or four tabs,
 * every switch evicts a pane that is about to be needed again: driving four
 * tabs for three cycles rebuilt the same three panes twelve times, 251 to
 * 461ms each, and the owner sees each of those as the side panel blanking and
 * refilling. Retention that never survives one lap is not retention.
 *
 * Two keeps what retention was for. The path retention exists to make cheap is
 * the back-and-forth between the pane in front of you and the one you just
 * came from, and two covers exactly that. Going further back rebuilds, which is
 * the cost retention was already paying on the ninth tab.
 *
 * **Do not raise this to buy fewer rebuilds.** It was tried at five, and the
 * live window went grey while the DOM stayed intact and correctly laid out.
 * `target/blitz-frame.log` named the cause: `layers_used_max=45` at
 * `layer_depth_max=8`, 38 of them from `overflow` alone, one set per retained
 * pane's scrollers, with `renderer_avg_ms=1245.99` and `paint_avg_ms=328.43`.
 * The compositor, not the node count, is the binding constraint here, and the
 * ceiling is far lower than "half the tree" suggests. Any change to this number
 * needs a `blitz-bench paint` reading and that log, not a node count.
 */
export const RETAINED_PROJECT_LIMIT = 2;

export function nextRetainedProjects(
  current: readonly string[],
  active: string | null,
  open: readonly string[],
): string[] {
  const openSet = new Set(open);
  const next = current.filter((key) => openSet.has(key) && key !== active);
  if (active && openSet.has(active)) next.push(active);
  return next.slice(-RETAINED_PROJECT_LIMIT);
}

/**
 * The window: a tab strip over one screen at a time.
 *
 * Home and the eight most recently visited project tabs retain their DOM. That
 * makes the common back-and-forth path a visibility toggle instead of a full
 * Solid/Boa reconstruction, while the hard limit prevents a long-lived tab
 * strip from rebuilding the old unbounded background DOM.
 */
export function Workspace(): JSX.Element {
  const { state, actions, activeTab, activeProject } = useWorkspace();
  const shell = useAppShell();
  const [retainedProjects, setRetainedProjects] = createSignal<string[]>([]);

  createEffect(
    () => [state.tabs, state.activeKey] as const,
    () => {
      const active = activeTab();
      const activeProjectId = active.kind === "project" ? active.projectId : null;
      const openProjectIds = state.tabs.flatMap((tab) =>
        tab.kind === "project" && tab.projectId ? [tab.projectId] : [],
      );
      setRetainedProjects((current) => {
        const next = nextRetainedProjects(current, activeProjectId, openProjectIds);
        return next.length === current.length && next.every((key, index) => key === current[index])
          ? current
          : next;
      });
    },
  );

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
            <div
              data-retained-tab="home"
              aria-hidden={activeTab().kind !== "home" ? "true" : "false"}
              class={activeTab().kind === "home" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}
            >
              <HomeTab />
            </div>

            {/*
              Settings mounts on demand, unlike Home and the project panes.

              It was retained the same way they are, rendered always and hidden
              with a class, and it is the largest subtree in the application:
              measured on the running app at 835x9308px, hidden, still holding
              layout. `blitz-bench ghost` reported 1,942 hidden nodes against a
              healthy 58, and this was most of them. Every tab switch then
              walked it in `propagate_damage_flags`, which is where the lag came
              from - `commit 0ms, frame 33-168ms`, a state change that lands
              instantly followed by up to twenty dropped frames at 120Hz.

              Retention earns its cost for tabs someone flips between. Settings
              is a destination, so its rebuild is paid once on the way in rather
              than on every switch between two projects.
            */}
            <Show when={activeTab().kind === "settings"}>
              <div data-retained-tab="settings" class="flex min-h-0 min-w-0 flex-1">
                <SettingsTab />
              </div>
            </Show>

            {/*
              The panes and *one* side panel, in a row.

              Each retained pane used to carry its own `ProjectPanel`, so opening
              a project built a second complete 332px column - 24 component
              instances per item row, its own scrollers, its own compositor
              layers - to show data the store already held. That duplication was
              the panel's whole first-build cost, the reason retention had to
              stop at two, and the reason five panes greyed the window with
              `overflow` layers.

              `ProjectPanel` reads everything through `props.project.id`, so it
              never cared which project it was pointed at; it simply was not
              given the chance to be re-pointed. One instance lives here, beside
              the panes rather than inside them, and a tab switch changes the
              project it reads instead of revealing another copy of the
              furniture. It is a plain child, never gated on a `Show`, so it is
              built once for the life of the window.
            */}
            <div class={activeTab().kind === "project" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
              <For each={retainedProjects()}>
                {(projectId) => {
                  const view = createMemo(() => {
                    const project = state.projects.find((candidate) => candidate.id === projectId);
                    const tab = state.tabs.find((candidate) => candidate.key === projectId);
                    return project && tab ? { project, tab } : null;
                  });
                  return (
                    <Show when={view()}>
                      {(retained) => (
                        <div
                          data-retained-project={projectId}
                          aria-hidden={state.activeKey !== projectId ? "true" : "false"}
                          class={
                            state.activeKey === projectId ? "flex min-h-0 min-w-0 flex-1" : "hidden"
                          }
                        >
                          <ProjectTab tab={retained().tab} project={retained().project} />
                        </div>
                      )}
                    </Show>
                  );
                }}
              </For>
              <ActiveProjectPanel />
            </div>

            <Show
              when={
                activeTab().kind !== "home" &&
                activeTab().kind !== "project" &&
                activeTab().kind !== "settings"
              }
            >
              <div class="flex min-h-0 min-w-0 flex-1">
                <Switch>
                  <Match when={activeTab().kind === "analytics"}>
                    <AnalyticsTab />
                  </Match>
                  <Match when={activeTab().kind === "draft"}>
                    <DraftTab tab={activeTab()} />
                  </Match>
                </Switch>
              </div>
            </Show>

            <Show when={activeTab().kind === "project" && !activeProject()}>
              {/*
              A project tab whose record is not in state. Previously this matched
              nothing and the window rendered an unexplained black void, which is
              the worst possible failure: no content, no error, no way to tell a
              missing record from a broken render.
            */}
              <div class="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-panel border border-az-hairline bg-az-sunken">
                <p class="text-[13.5px] text-az-title">{tx("This project could not be loaded")}</p>
                <p class="max-w-[420px] text-center text-[11.5px] text-az-muted">
                  {tx(
                    "The tab is open but its record is missing from the workspace. Reopening the window will re-read it from the database.",
                  )}
                </p>
              </div>
            </Show>
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
    <>
      <IconSprite />
      <WorkspaceProvider>
        <Workspace />
      </WorkspaceProvider>
    </>
  );
}
