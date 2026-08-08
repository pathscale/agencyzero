import { type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Icon } from "~/components/Icon";
import { IconSprite } from "~/components/IconSprite";
import { AnalyticsTab } from "~/features/analytics/AnalyticsTab";
import { DraftTab } from "~/features/draft/DraftTab";
import { HomeTab } from "~/features/home/HomeTab";
import { WelcomeFlow } from "~/features/onboarding/WelcomeFlow";
import { ProjectTab } from "~/features/project/ProjectTab";
import { SettingsTab } from "~/features/settings/SettingsTab";
import { CloseConfirm } from "~/features/shell/CloseConfirm";
import { useAppShell } from "~/features/shell/useAppShell";
import { TabStrip } from "~/features/tabs/TabStrip";
import { installSelectionCopy } from "~/lib/clipboard";
import { tx } from "~/stores/i18n";
import { useWorkspace, WorkspaceProvider } from "~/stores/workspace";

/**
 * The window: a tab strip over one screen at a time.
 *
 * Only the active tab is mounted. A background tab holds no DOM — its state
 * lives in the workspace store and its dot in the strip, which is the whole
 * point of the dot.
 */
function Workspace(): JSX.Element {
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
        <Show
          when={
            state.boot.status === "ready" ||
            (activeTab().kind === "settings" && state.settings !== null)
          }
          fallback={
            <Show when={state.boot.status === "error"} fallback={<Booting />}>
              <BootFailed
                message={state.boot.status === "error" ? state.boot.message : ""}
                onRetry={() => void actions.retryInit()}
                onOpenSettings={actions.openSettings}
              />
            </Show>
          }
        >
          <Switch>
            <Match when={activeTab().kind === "home"}>
              <HomeTab />
            </Match>
            <Match when={activeTab().kind === "settings"}>
              <SettingsTab />
            </Match>
            <Match when={activeTab().kind === "analytics"}>
              <AnalyticsTab />
            </Match>
            <Match when={activeTab().kind === "draft"}>
              <DraftTab tab={activeTab()} />
            </Match>
            <Match when={activeTab().kind === "project" && activeProject()}>
              {(project) => <ProjectTab tab={activeTab()} project={project()} />}
            </Match>
            {/*
              A project tab whose record is not in state. Previously this matched
              nothing and the window rendered an unexplained black void, which is
              the worst possible failure: no content, no error, no way to tell a
              missing record from a broken render.
            */}
            <Match when={activeTab().kind === "project"}>
              <div class="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-panel border border-az-hairline bg-az-sunken">
                <p class="text-[13.5px] text-az-title">{tx("This project could not be loaded")}</p>
                <p class="max-w-[420px] text-center text-[11.5px] text-az-muted">
                  {tx(
                    "The tab is open but its record is missing from the workspace. Reopening the window will re-read it from the database.",
                  )}
                </p>
              </div>
            </Match>
          </Switch>
        </Show>
      </main>

      <Show when={state.backend === "mock"}>
        <MockBanner />
      </Show>

      <WelcomeFlow />

      <CloseConfirm
        isOpen={shell.isClosing()}
        error={shell.closeError()}
        onCancel={shell.cancelClose}
        onConfirm={shell.confirmClose}
      />
    </div>
  );
}

export function Booting(): JSX.Element {
  return (
    <div
      role="status"
      aria-label={tx("Loading workspace…")}
      class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-panel border border-az-hairline bg-az-sunken"
    >
      <div class="absolute top-1/2 left-1/2 size-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/7 blur-[90px]" />
      <div class="relative flex flex-col items-center">
        <div class="az-halo-primary flex size-[58px] items-center justify-center rounded-[18px] border border-primary/28 bg-primary/11 text-primary shadow-[0_16px_45px_rgb(from_var(--color-primary)_r_g_b/.12)]">
          <Icon name="sparkles" class="text-[27px]" />
        </div>
        <p class="mt-4 font-semibold text-[18px] text-az-title tracking-[-.02em]">
          {tx("AgencyZero")}
        </p>
        <p class="mt-1 text-[11.5px] text-az-muted">{tx("Loading workspace…")}</p>
        <div class="mt-4 h-1 w-32 overflow-hidden rounded-full bg-primary/10">
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
      <div class="flex items-center gap-2">
        <button
          type="button"
          onClick={props.onRetry}
          class="rounded-lg bg-primary px-3.5 py-1.5 font-semibold text-[12.5px] text-primary-content transition-colors hover:bg-az-primary-hover"
        >
          {tx("Try again")}
        </button>
        <button
          type="button"
          onClick={props.onOpenSettings}
          class="rounded-lg border border-az-hairline px-3.5 py-1.5 font-semibold text-[12.5px] text-az-body transition-colors hover:bg-white/6 hover:text-base-content"
        >
          {tx("Open Settings")}
        </button>
      </div>
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
  onMount(() => {
    onCleanup(installSelectionCopy());
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
