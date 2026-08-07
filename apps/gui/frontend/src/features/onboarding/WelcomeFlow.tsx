import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Icon, type IconProps } from "~/components/Icon";
import { LanguageSwitcher } from "~/components/LanguageSwitcher";
import { AGENT_LABELS, agentStateLabel, permissionLabel } from "~/lib/labels";
import { describeError } from "~/lib/log";
import { tx } from "~/stores/i18n";
import { useWorkspace } from "~/stores/workspace";
import type { Agent, ChatImportSource, Permission, StoreBackupSelection } from "~/types";

const LAST_STEP = 4;
const PROJECT_AGENTS: Agent[] = ["claude", "codex"];
type GuidedPermission = Extract<Permission, "read_only" | "ask" | "auto">;

const SECURITY: GuidedPermission[] = ["read_only", "ask", "auto"];

const SECURITY_HINT: Record<GuidedPermission, string> = {
  read_only: tx("Read files and run checks, but do not change the workspace."),
  ask: tx("Ask before a tool crosses the current approval rules."),
  auto: tx("Edit inside the approved workspace and use routine network access automatically."),
};

/**
 * First-run setup, also replayed by Help.
 *
 * This coordinates existing settings and import capabilities; it owns no
 * second copy of their persistence logic. Closing an unfinished first run is
 * window-local, while completion is stored with the rest of GlobalSettings.
 */
export function WelcomeFlow(): JSX.Element {
  const { state, actions, isLive, permissionsFor } = useWorkspace();
  const [step, setStep] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  const [securityConfirmed, setSecurityConfirmed] = createSignal(false);
  const [sources, setSources] = createSignal<ChatImportSource[]>([]);
  const [importsLoaded, setImportsLoaded] = createSignal(false);
  const [restoreSelection, setRestoreSelection] = createSignal<StoreBackupSelection | null>(null);

  const visible = () =>
    state.boot.status === "ready" &&
    Boolean(state.settings) &&
    (state.onboardingOpen ||
      (state.settings?.onboardingCompleted === false && !state.onboardingDeferred));
  const isReplay = () => state.settings?.onboardingCompleted === true;
  const connectedProjectAgents = createMemo(() =>
    state.agents.filter(
      (status) => PROJECT_AGENTS.includes(status.agent) && status.state === "connected",
    ),
  );
  const defaultAgentReady = () =>
    connectedProjectAgents().some((status) => status.agent === state.settings?.defaultAgent);
  const enabledModels = () => {
    const agent = state.settings?.defaultAgent;
    if (!agent) return [];
    const enabled = state.settings?.models[agent]?.enabled ?? [];
    return (
      state.models
        .find((catalogue) => catalogue.agent === agent)
        ?.models.filter((model) => enabled.includes(model.id)) ?? []
    );
  };

  createEffect(() => {
    if (!visible()) {
      setStep(0);
      setNote(null);
      setSecurityConfirmed(false);
    } else if (isReplay()) {
      setSecurityConfirmed(true);
    }
  });

  createEffect(() => {
    if (!visible() || step() !== 3 || importsLoaded()) return;
    setImportsLoaded(true);
    if (!isLive("discoverChatImports")) return;
    void actions
      .discoverChatImports()
      .then(setSources)
      .catch((cause) => setNote(describeError(cause)));
  });

  onMount(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && visible() && !busy()) actions.deferOnboarding();
    };
    window.addEventListener("keydown", closeOnEscape);
    onCleanup(() => window.removeEventListener("keydown", closeOnEscape));
  });

  const chooseAgent = async (agent: Agent): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await actions.saveSettings({ defaultAgent: agent });
    } catch (cause) {
      setNote(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const chooseSecurity = async (permission: Permission): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await actions.saveSettings({ defaultPermission: permission });
      setSecurityConfirmed(true);
    } catch (cause) {
      setNote(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectBackup = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const picked = await actions.selectStoreBackup();
      if (picked) setRestoreSelection(picked);
    } catch (cause) {
      setNote(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await actions.restoreStoreBackup();
    } catch (cause) {
      setNote(describeError(cause));
      setBusy(false);
    }
  };

  const importAll = async (source: ChatImportSource): Promise<void> => {
    setBusy(true);
    setNote(null);
    let imported = 0;
    try {
      for (const session of source.sessions.filter((candidate) => candidate.importable)) {
        await actions.importChatSession(source.source, session.id);
        imported += 1;
      }
      setNote(
        tx("Imported {count} chats from {source}", { count: imported, source: source.label }),
      );
      setSources(await actions.discoverChatImports());
    } catch (cause) {
      setNote(
        `${tx("Imported {count} chats from {source}", {
          count: imported,
          source: source.label,
        })} · ${describeError(cause)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const canContinue = () => {
    if (step() === 0) return isReplay() || state.workspaceRoot?.exists === true;
    if (step() === 1) return connectedProjectAgents().length > 0;
    if (step() === 2) return defaultAgentReady() && securityConfirmed();
    return true;
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await actions.completeOnboarding();
    } catch (cause) {
      setNote(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={visible()}>
      <div class="absolute inset-0 z-50 flex items-center justify-center bg-black/72 px-6 py-8 backdrop-blur-[3px]">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="welcome-title"
          class="flex max-h-full w-full max-w-[760px] flex-col overflow-hidden rounded-[20px] border border-primary/24 bg-base-200 shadow-[0_28px_90px_rgba(0,0,0,.7)]"
        >
          <header class="flex items-start justify-between gap-5 border-az-hairline-soft border-b px-6 py-5">
            <div class="flex min-w-0 items-center gap-3.5">
              <div class="az-halo-primary flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-primary/30 bg-primary/12 text-primary">
                <Icon name="sparkles" class="text-[21px]" />
              </div>
              <div>
                <h1 id="welcome-title" class="font-semibold text-[18px] text-az-title">
                  {tx("Welcome to AgencyZero")}
                </h1>
                <p class="mt-0.5 text-[11.5px] text-az-muted">
                  {tx("Set up the workspace once, then start with a real task.")}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => actions.deferOnboarding()}
              disabled={busy()}
              title={isReplay() ? tx("Close setup") : tx("Finish setup later")}
              aria-label={isReplay() ? tx("Close setup") : tx("Finish setup later")}
              class="rounded-lg p-1.5 text-az-muted hover:bg-white/6 hover:text-base-content disabled:opacity-40"
            >
              <Icon name="x" class="text-[16px]" />
            </button>
          </header>

          <div
            role="progressbar"
            aria-label={tx("Setup progress")}
            aria-valuemin={1}
            aria-valuemax={LAST_STEP + 1}
            aria-valuenow={step() + 1}
            class="flex items-center gap-1.5 px-6 pt-4"
          >
            <For each={Array.from({ length: LAST_STEP + 1 })}>
              {(_, index) => (
                <span
                  class={`h-1 flex-1 rounded-full ${index() <= step() ? "bg-primary" : "bg-az-inset"}`}
                />
              )}
            </For>
          </div>

          <div class="az-scroll min-h-0 flex-1 px-6 py-5">
            <Show when={step() === 0}>
              <SetupHeading
                icon="folder"
                title={tx("Choose Home and language")}
                hint={tx("New projects start in Home; the interface changes language immediately.")}
              />
              <SetupRow
                title={tx("Interface language")}
                hint={tx("Choose the language used by AgencyZero.")}
              >
                <LanguageSwitcher align="end" />
              </SetupRow>
              <SetupRow
                title={tx("Home Project directory")}
                hint={
                  state.workspaceRoot?.exists
                    ? tx("Ready for new projects")
                    : tx("Choose or create the directory before continuing")
                }
              >
                <div class="flex max-w-[430px] flex-col items-end gap-2">
                  <code class="max-w-full truncate font-mono text-[11px] text-az-body">
                    {state.workspaceRoot?.path ?? tx("Not available")}
                  </code>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy()}
                      onClick={() => void actions.chooseWorkspaceRoot()}
                      class="rounded-lg border border-az-hairline-strong px-3 py-1.5 text-[11.5px] text-az-body hover:border-primary hover:text-primary disabled:opacity-40"
                    >
                      {tx("Choose folder…")}
                    </button>
                    <Show when={!state.workspaceRoot?.exists}>
                      <button
                        type="button"
                        disabled={busy()}
                        onClick={() => void actions.createWorkspaceRoot()}
                        class="rounded-lg border border-primary/50 px-3 py-1.5 text-[11.5px] text-primary hover:bg-primary/10 disabled:opacity-40"
                      >
                        {tx("Create recommended folder")}
                      </button>
                    </Show>
                  </div>
                </div>
              </SetupRow>
              <div class="mt-4 flex items-center justify-between gap-5 rounded-xl border border-primary/22 bg-primary/7 px-4 py-3.5">
                <div class="min-w-0">
                  <p class="font-medium text-[12.5px] text-az-strong">
                    {tx("Restoring from backup?")}
                  </p>
                  <p class="mt-0.5 text-[10.5px] text-az-muted">
                    {tx("Select an AgencyZero backup, then restore it before continuing setup.")}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <Show when={restoreSelection()}>
                    {(picked) => (
                      <code class="max-w-[190px] truncate font-mono text-[10.5px] text-az-body">
                        {picked().fileName}
                      </code>
                    )}
                  </Show>
                  <button
                    type="button"
                    disabled={busy() || !isLive("selectStoreBackup")}
                    onClick={() => void selectBackup()}
                    class="rounded-lg border border-az-hairline-strong px-3 py-1.5 text-[11.5px] text-az-body hover:border-primary hover:text-primary disabled:opacity-40"
                  >
                    {tx("Select backup file…")}
                  </button>
                  <Show when={restoreSelection()}>
                    <button
                      type="button"
                      disabled={busy()}
                      onClick={() => void restoreBackup()}
                      class="rounded-lg border border-warning/50 px-3 py-1.5 font-semibold text-[11.5px] text-warning hover:border-warning disabled:opacity-40"
                    >
                      {tx("Restore")}
                    </button>
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={step() === 1}>
              <SetupHeading
                icon="terminal"
                title={tx("Confirm your agents")}
                hint={tx("AgencyZero checks the installed CLI, version, and sign-in state.")}
              />
              <div class="mt-4 overflow-hidden rounded-xl border border-az-hairline bg-az-inset">
                <For each={state.agents}>
                  {(status) => (
                    <div class="flex items-center justify-between gap-4 border-az-hairline-soft border-b px-4 py-3 last:border-b-0">
                      <div class="flex items-center gap-3">
                        <Icon
                          name={
                            status.agent === "claude"
                              ? "vendor-claude"
                              : status.agent === "codex"
                                ? "vendor-openai"
                                : "vendor-copilot"
                          }
                          class="text-[17px] text-az-body"
                        />
                        <div>
                          <p class="font-medium text-[12.5px] text-az-strong">
                            {AGENT_LABELS[status.agent]}
                          </p>
                          <p class="mt-0.5 text-[10.5px] text-az-muted">
                            {status.version ?? tx("No installed version detected")}
                          </p>
                        </div>
                      </div>
                      <span
                        class={`rounded-full px-2 py-1 font-medium text-[10.5px] ${
                          status.state === "connected"
                            ? "bg-success/12 text-success"
                            : status.state === "logged_out"
                              ? "bg-error/10 text-error"
                              : "bg-warning/10 text-warning"
                        }`}
                      >
                        {agentStateLabel(status.state)}
                      </span>
                    </div>
                  )}
                </For>
              </div>
              <div class="mt-3 flex items-center justify-between gap-3">
                <p class="text-[11px] text-az-muted">
                  {connectedProjectAgents().length > 0
                    ? tx("At least one project agent is ready.")
                    : tx("Install and sign in to Claude or Codex before continuing.")}
                </p>
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void actions.recheckAgents()}
                  class="flex items-center gap-1.5 rounded-lg border border-az-hairline-strong px-3 py-1.5 text-[11.5px] text-az-body hover:border-primary hover:text-primary disabled:opacity-40"
                >
                  <Icon name="refresh-cw" class="text-[12px]" />
                  {tx("Run checks again")}
                </button>
              </div>
            </Show>

            <Show when={step() === 2 && state.settings}>
              {(settings) => (
                <>
                  <SetupHeading
                    icon="shield"
                    title={tx("Choose defaults and security")}
                    hint={tx("These choices seed new projects; every project can override them.")}
                  />
                  <div class="mt-4 grid grid-cols-2 gap-3">
                    <For each={connectedProjectAgents()}>
                      {(status) => (
                        <button
                          type="button"
                          disabled={busy()}
                          onClick={() => void chooseAgent(status.agent)}
                          class={`rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-40 ${
                            settings().defaultAgent === status.agent
                              ? "border-primary/60 bg-primary/10"
                              : "border-az-hairline bg-az-inset hover:border-primary/40"
                          }`}
                        >
                          <span class="font-medium text-[12.5px] text-az-strong">
                            {AGENT_LABELS[status.agent]}
                          </span>
                          <span class="mt-1 block text-[10.5px] text-az-muted">
                            {tx("Default project agent")}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                  <SetupRow
                    title={tx("Default model")}
                    hint={tx("Choose from the enabled models for this agent.")}
                  >
                    <select
                      aria-label={tx("Default model")}
                      value={settings().models[settings().defaultAgent].default}
                      disabled={busy() || !defaultAgentReady()}
                      onChange={(event) =>
                        void actions.setDefaultModel(
                          settings().defaultAgent,
                          event.currentTarget.value,
                        )
                      }
                      class="h-9 min-w-[250px] rounded-lg border border-az-hairline bg-az-inset px-2.5 text-[12px] text-az-body outline-none disabled:opacity-40"
                    >
                      <For each={enabledModels()}>
                        {(model) => <option value={model.id}>{model.name}</option>}
                      </For>
                    </select>
                  </SetupRow>
                  <div class="mt-4">
                    <p class="font-medium text-[12.5px] text-az-strong">{tx("Security posture")}</p>
                    <p class="mt-0.5 text-[11px] text-az-muted">
                      {tx("Choose explicitly; AgencyZero never widens access on its own.")}
                    </p>
                    <div class="mt-3 grid grid-cols-3 gap-2.5">
                      <For
                        each={SECURITY.filter((permission) =>
                          permissionsFor(settings().defaultAgent).includes(permission),
                        )}
                      >
                        {(permission) => (
                          <button
                            type="button"
                            disabled={busy()}
                            onClick={() => void chooseSecurity(permission)}
                            class={`min-h-[112px] rounded-xl border p-3 text-left transition-colors disabled:opacity-40 ${
                              settings().defaultPermission === permission && securityConfirmed()
                                ? "border-primary/60 bg-primary/10"
                                : "border-az-hairline bg-az-inset hover:border-primary/40"
                            }`}
                          >
                            <span class="font-semibold text-[12px] text-az-strong">
                              {permissionLabel(permission)}
                            </span>
                            <span class="mt-1.5 block text-[10.5px] text-az-muted leading-[1.45]">
                              {SECURITY_HINT[permission]}
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </>
              )}
            </Show>

            <Show when={step() === 3}>
              <SetupHeading
                icon="messages-square"
                title={tx("Bring existing chats")}
                hint={tx("Import is read-only: provider transcripts are copied into new projects.")}
              />
              <div class="mt-4 overflow-hidden rounded-xl border border-az-hairline bg-az-inset">
                <Show
                  when={sources().length > 0}
                  fallback={
                    <p class="px-4 py-5 text-center text-[11.5px] text-az-muted">
                      {importsLoaded()
                        ? tx("No importable local sessions were found.")
                        : tx("Checking known provider stores…")}
                    </p>
                  }
                >
                  <For each={sources()}>
                    {(source) => {
                      const importable = () =>
                        source.sessions.filter((session) => session.importable);
                      return (
                        <div class="flex items-center justify-between gap-4 border-az-hairline-soft border-b px-4 py-3 last:border-b-0">
                          <div>
                            <p class="font-medium text-[12.5px] text-az-strong">{source.label}</p>
                            <p class="mt-0.5 text-[10.5px] text-az-muted">
                              {tx("{count} chats available", { count: importable().length })}
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={busy() || importable().length === 0}
                            onClick={() => void importAll(source)}
                            class="rounded-lg border border-primary/45 px-3 py-1.5 font-medium text-[11.5px] text-primary hover:bg-primary/10 disabled:opacity-40"
                          >
                            {tx("Import all")}
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
              <p class="mt-3 text-[11px] text-az-muted">
                {tx("Import is optional. You can return to it from Settings at any time.")}
              </p>
            </Show>

            <Show when={step() === 4 && state.settings}>
              {(settings) => (
                <>
                  <SetupHeading
                    icon="check"
                    title={tx("Ready for the first project")}
                    hint={tx("Review update checks, then open a project and send a real task.")}
                  />
                  <SetupRow
                    title={tx("Automatic update checks")}
                    hint={tx(
                      "Checks after launch; AgencyZero never installs an update automatically.",
                    )}
                  >
                    <div class="flex rounded-lg border border-az-hairline bg-az-inset p-1">
                      <For each={[true, false]}>
                        {(enabled) => (
                          <button
                            type="button"
                            disabled={busy()}
                            onClick={() =>
                              void actions.saveSettings({ automaticUpdateChecks: enabled })
                            }
                            class={`rounded-md px-3 py-1 text-[11.5px] ${
                              settings().automaticUpdateChecks === enabled
                                ? "bg-primary/16 font-medium text-primary"
                                : "text-az-muted"
                            }`}
                          >
                            {enabled ? tx("On") : tx("Off")}
                          </button>
                        )}
                      </For>
                    </div>
                  </SetupRow>
                  <div class="mt-4 rounded-xl border border-primary/22 bg-primary/7 px-4 py-4">
                    <p class="font-medium text-[12.5px] text-az-strong">
                      {tx("What happens next")}
                    </p>
                    <p class="mt-1 text-[11px] text-az-muted leading-[1.55]">
                      {tx(
                        "AgencyZero opens an Untitled project. Describe the outcome you want; the first reply names the project and can create tracked work items.",
                      )}
                    </p>
                  </div>
                </>
              )}
            </Show>

            <Show when={note()}>
              {(message) => (
                <p class="mt-4 rounded-lg border border-warning/24 bg-warning/8 px-3 py-2 text-[11px] text-az-body">
                  {message()}
                </p>
              )}
            </Show>
          </div>

          <footer class="flex items-center justify-between gap-4 border-az-hairline-soft border-t px-6 py-4">
            <div class="flex items-center gap-2">
              <button
                type="button"
                disabled={busy() || step() === 0}
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                class="rounded-lg px-3 py-1.5 text-[11.5px] text-az-muted hover:bg-white/5 hover:text-base-content disabled:opacity-30"
              >
                {tx("Back")}
              </button>
              <button
                type="button"
                disabled={busy()}
                onClick={() => actions.deferOnboarding()}
                class="rounded-lg px-3 py-1.5 text-[11.5px] text-az-muted hover:bg-white/5 hover:text-base-content disabled:opacity-30"
              >
                {isReplay() ? tx("Close") : tx("Finish later")}
              </button>
            </div>
            <button
              type="button"
              disabled={busy() || !canContinue()}
              onClick={() =>
                step() === LAST_STEP ? void finish() : setStep((current) => current + 1)
              }
              class="flex min-w-[128px] items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-semibold text-[12px] text-primary-content hover:bg-az-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {step() === LAST_STEP ? tx("Create first project") : tx("Continue")}
              <Show when={step() !== LAST_STEP}>
                <Icon name="chevron-right" class="text-[13px]" />
              </Show>
            </button>
          </footer>
        </section>
      </div>
    </Show>
  );
}

function SetupHeading(props: {
  icon: IconProps["name"];
  title: string;
  hint: string;
}): JSX.Element {
  return (
    <div class="flex items-start gap-3">
      <div class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon name={props.icon} class="text-[17px]" />
      </div>
      <div>
        <h2 class="font-semibold text-[16px] text-az-title">{props.title}</h2>
        <p class="mt-1 text-[11.5px] text-az-muted">{props.hint}</p>
      </div>
    </div>
  );
}

function SetupRow(props: { title: string; hint: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="mt-4 flex items-center justify-between gap-5 rounded-xl border border-az-hairline bg-az-inset px-4 py-3.5">
      <div class="min-w-0">
        <p class="font-medium text-[12.5px] text-az-strong">{props.title}</p>
        <p class="mt-0.5 text-[10.5px] text-az-muted">{props.hint}</p>
      </div>
      <div class="shrink-0">{props.children}</div>
    </div>
  );
}
