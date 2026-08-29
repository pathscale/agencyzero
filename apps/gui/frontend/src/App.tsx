import { Flex } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { For, Match, onCleanup, onSettled, Show, Switch } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { DraftTab } from "~/features/draft/DraftTab";
import { WelcomeFlow } from "~/features/onboarding/WelcomeFlow";
import { CloseConfirm } from "~/features/shell/CloseConfirm";
import { useAppShell } from "~/features/shell/useAppShell";
import { TabStrip } from "~/features/tabs/TabStrip";
import { WorkspacePanes } from "~/features/tabs/WorkspacePanes";
import { installSelectionCopy } from "~/lib/clipboard";
import { log } from "~/lib/log";
import { i18n, tx } from "~/stores/i18n";
import { type BootState, useWorkspace, WorkspaceProvider } from "~/stores/workspace";

/**
 * The window: a tab strip over one screen at a time.
 *
 * Only the active pane is mounted. Its reactive and native layout ownership is
 * destroyed at a tab change instead of leaking into the next surface.
 */
export function Workspace(): JSX.Element {
  const { state, actions, activeTab, activeProject } = useWorkspace();
  const shell = useAppShell();

  return (
    <div id="application-surface" class="az-desk relative flex h-full flex-col overflow-hidden">
      <Show when={state.boot.status !== "loading"}>
        <TabStrip />
      </Show>

      <Show when={shell.persistenceFailure()}>
        {(failure) => (
          <div
            role="alert"
            class="mx-3 mt-1.5 flex flex-none items-start gap-2 rounded-lg border border-error/35 bg-error/12 px-3 py-2 text-error text-ui-detail"
          >
            <Icon name="shield" class="mt-px shrink-0 text-ui-control" />
            <div class="min-w-0">
              <p class="font-semibold">{tx("Storage stopped saving")}</p>
              <p
                data-selectable
                class="mt-0.5 break-words font-mono text-ui-caption-sm leading-[1.45]"
              >
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
            <WorkspacePanes />
            <Switch>
              <Match when={activeTab().kind === "draft"}>
                <div data-active-tab="draft" class="flex min-h-0 min-w-0 flex-1">
                  <DraftTab tab={activeTab()} />
                </div>
              </Match>
              <Match when={activeTab().kind === "project" && activeProject() === null}>
                {/*
                  A project tab whose record is not in state. Previously this matched
                  nothing and the window rendered an unexplained black void, which is
                  the worst possible failure: no content, no error, no way to tell a
                  missing record from a broken render.
                */}
                <div class="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-panel border border-az-hairline bg-az-sunken">
                  <p class="text-az-title text-ui-body-lg">
                    {tx("This project could not be loaded")}
                  </p>
                  <p class="max-w-[420px] text-center text-az-muted text-ui-detail">
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
          <Icon name="sparkles" class="text-ui-hero" />
        </div>
        <p class="mt-4 font-semibold text-az-title text-ui-heading tracking-[-.02em]">
          {tx("AgencyZero")}
        </p>
        <p class="mt-1 text-az-muted text-ui-detail">{tx("Loading workspace…")}</p>
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
        <Icon name="shield" class="text-error text-ui-display-lg" />
      </div>
      <div class="flex flex-col items-center gap-1.5">
        <p class="font-semibold text-base-content text-ui-lead">
          {tx("Could not load the workspace")}
        </p>
        <p
          data-selectable
          class="max-w-[460px] text-center font-mono text-az-muted text-ui-detail leading-[1.55]"
        >
          {props.message}
        </p>
      </div>
      <Flex align="center" gap="sm">
        <Button
          id="boot-retry"
          type="button"
          onClick={props.onRetry}
          class="rounded-lg bg-primary px-3.5 py-1.5 font-semibold text-primary-content text-ui-label-lg transition-colors hover:bg-az-primary-hover"
        >
          {tx("Try again")}
        </Button>
        <Button
          id="boot-open-settings"
          type="button"
          onClick={props.onOpenSettings}
          class="rounded-lg border border-az-hairline px-3.5 py-1.5 font-semibold text-az-body text-ui-label-lg transition-colors hover:bg-white/6 hover:text-base-content"
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
    <div class="flex flex-none items-center justify-center gap-2 border-az-hairline-soft border-t px-3 py-1.5 text-az-faint text-ui-caption-sm">
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
      {/*
        Translation helpers are ordinary function calls used throughout the
        component tree. Some renderer/compiler paths evaluate an attribute
        expression only when its owner mounts, which left a language change
        with a new selector value but stale labels elsewhere in the window.

        Keep the long-lived data owner and its subscriptions intact, but key
        the visible workspace by locale so every text and accessibility
        attribute is rebuilt from one catalogue.
      */}
      <For each={[i18n.locale]}>{() => <Workspace />}</For>
    </WorkspaceProvider>
  );
}
