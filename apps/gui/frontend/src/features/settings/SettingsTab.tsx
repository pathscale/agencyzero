import { Toggle } from "@pathscale/ui";
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
  useContext,
} from "solid-js";
import { Icon, type IconProps } from "~/components/Icon";
import { LanguageSwitcher } from "~/components/LanguageSwitcher";
import { Panel } from "~/components/Panel";
import { PillMenu } from "~/components/PillMenu";
import { AgentStateDot } from "~/components/StatusDot";
import { countdown, formatBytes, relativeTime } from "~/lib/format";
import { AGENT_LABELS, agentStateLabel, envPolicyLabel, permissionLabel } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { DEFAULT_WASH, normalizeWash } from "~/lib/theme";
import { t, tx, type UiMessage } from "~/stores/i18n";
import { prefs, setPrefs } from "~/stores/prefs";
import { useNow, useWorkspace } from "~/stores/workspace";
import type {
  Agent,
  AgentModels,
  AgentState,
  AgentStatus,
  BuildInfo,
  ChatImportSource,
  CostSummary,
  EnvPolicy,
  Model,
  ModelSelection,
  ModelSource,
  Permission,
  StoreBackupSelection,
  StoreBackupStatus,
  StudySummary,
  TableSize,
  TaskManagerSettings,
} from "~/types";
import { ThemePicker } from "./ThemePicker";

const STATE_TONE: Record<AgentState, string> = {
  connected: "text-success",
  outdated: "text-warning",
  logged_out: "text-error",
  missing: "text-az-muted",
};

/** Weakest evidence behind a catalogue, phrased for someone deciding whether to trust it. */
const SOURCE_LABELS = {
  cli: "reported by the CLI",
  picker: "read from the interactive picker",
  docs: "from vendor documentation",
} satisfies Record<ModelSource, UiMessage>;

/**
 * What each agent's selection is currently wired to.
 *
 * The two project providers can also own the Home task manager. Copilot stays
 * collected for the later project integration.
 */
const AGENT_USE = {
  claude: "available to projects and Task Manager",
  codex: "available to projects and Task Manager",
  copilot: "ready for later project support",
} satisfies Record<Agent, UiMessage>;

/**
 * What the search box at the top holds.
 *
 * Module scope rather than a prop threaded through eleven sections and their
 * rows. The alternative was passing a signal into every `Section` and `Row`,
 * which is the same coupling written out longhand.
 */
const [settingsQuery, setSettingsQuery] = createSignal("");

/** Whether some label or hint answers what is being searched for. */
function matchesSearch(text: string): boolean {
  const needle = settingsQuery().trim().toLowerCase();
  return needle === "" || text.toLowerCase().includes(needle);
}

/**
 * How a row tells its section that it matched.
 *
 * A section is shown when its own words match *or* when anything inside it
 * does, and only the rows know the latter. So they report, and the section
 * counts. Both hide with a class rather than unmounting: a row removed from
 * the DOM stops reporting, and a section that has forgotten it ever had a
 * matching row can never come back when the query changes.
 */
const SearchScope = createContext<{
  titleMatches: () => boolean;
  report: (label: string, hit: boolean) => void;
}>();

/**
 * Global settings, opened by the gear as a real tab you can leave open.
 *
 * Real controls only — detected agent status, the defaults a new tab starts
 * from, the moderator, notifications, and what the agent process inherits from
 * this machine. Changes save as you make them; there is no Save button because
 * there is nothing to batch.
 */
export function SettingsTab(): JSX.Element {
  const { state, actions, isLive, effortsFor, permissionsFor } = useWorkspace();
  const settings = () => state.settings;

  /**
   * Why a section is not wired yet, or `undefined` when it is.
   *
   * Two different gaps, and they are worth telling apart. A command Rust has not
   * implemented is a backend gap the capability probe already knows about. A
   * setting that persists correctly but that nothing reads is a *consumer* gap:
   * `set_settings` stores the moderator config faithfully and no moderator runs,
   * because the agent run path does not exist. Only the second needs saying by
   * hand, and it is deliberately short.
   */
  const runPathPending = (): string | undefined =>
    isLive("sendMessage") ? undefined : "needs the agent run path";

  /** The moderator rides the same run, so it unblocks with it. */
  const moderatorPending = (): string | undefined => runPathPending();

  /**
   * The catalogue entries this agent's picker may show.
   *
   * Ordered by the catalogue rather than by the selection, so a picker reads in
   * the vendor's own ranking whatever order the ids were checked in.
   */
  /**
   * The effort ladder the default model accepts, from the catalogue.
   *
   * Per model rather than a shared list, which is why it is read from the
   * default model's entry rather than hardcoded. Empty catalogues fall back to
   * the current value alone, so the menu is never blank.
   */
  const effortOptions = (): string[] => {
    const settings = state.settings;
    if (!settings) return [];
    const ladder = effortsFor(
      settings.defaultAgent,
      settings.models[settings.defaultAgent]?.default ?? "",
    );
    return ladder.length > 0 ? ladder : [settings.defaultEffort];
  };

  /** The effort ladder for the task manager's own model, not the default's. */
  const taskManagerEfforts = (): string[] => {
    const settings = state.settings;
    if (!settings) return [];
    const ladder = effortsFor(settings.taskManager.agent, settings.taskManager.model);
    return ladder.length > 0 ? ladder : [settings.taskManager.effort];
  };

  const selectDefaultAgent = (agent: Agent): void => {
    const settings = state.settings;
    if (!settings) return;
    const model = settings.models[agent].default;
    const ladder = effortsFor(agent, model);
    const permissions = permissionsFor(agent);
    void actions.saveSettings({
      defaultAgent: agent,
      defaultEffort: ladder.includes(settings.defaultEffort)
        ? settings.defaultEffort
        : (ladder[0] ?? settings.defaultEffort),
      defaultPermission: permissions.includes(settings.defaultPermission)
        ? settings.defaultPermission
        : (permissions[0] ?? "read_only"),
    });
  };

  const selectTaskManagerAgent = (agent: Agent): void => {
    const settings = state.settings;
    if (!settings) return;
    const taskManager = settings.taskManager;
    const model = settings.models[agent].default;
    const ladder = effortsFor(agent, model);
    const permissions = permissionsFor(agent);
    void actions.saveSettings({
      taskManager: {
        ...taskManager,
        agent,
        model,
        effort: ladder.includes(taskManager.effort)
          ? taskManager.effort
          : (ladder[0] ?? taskManager.effort),
        permission: permissions.includes(taskManager.permission)
          ? taskManager.permission
          : (permissions[0] ?? "read_only"),
      },
    });
  };

  const selectTaskManagerModel = (model: string): void => {
    const settings = state.settings;
    if (!settings) return;
    const taskManager = settings.taskManager;
    const ladder = effortsFor(taskManager.agent, model);
    void actions.saveSettings({
      taskManager: {
        ...taskManager,
        model,
        effort: ladder.includes(taskManager.effort)
          ? taskManager.effort
          : (ladder[0] ?? taskManager.effort),
      },
    });
  };

  const enabledModels = (agent: Agent): Model[] => {
    const catalogue = state.models.find((entry) => entry.agent === agent);
    const selection = state.settings?.models[agent];
    if (!catalogue || !selection) return [];
    return catalogue.models.filter((model) => selection.enabled.includes(model.id));
  };

  return (
    <div class="az-scroll flex min-w-0 flex-1 justify-center rounded-panel border border-az-hairline bg-az-sunken">
      <div class="flex w-full max-w-[720px] flex-col gap-3 px-6 pt-5.5 pb-7">
        <div class="flex items-baseline gap-2.5 pb-0.5">
          <h1 class="font-semibold text-[18px] text-az-title tracking-[-.01em]">
            {tx("Settings")}
          </h1>
          <span class="text-[11.5px] text-az-muted">
            {tx("defaults for every new tab · each project can override")}
          </span>
        </div>

        {/*
          Eleven sections and something over sixty rows, which is past the
          point where reading them all is how you find one.
        */}
        <div class="flex items-center gap-2.5 rounded-[11px] border border-primary/11 bg-az-inset px-3 py-2.5 focus-within:border-primary/40">
          <Icon name="search" class="shrink-0 text-[14px] text-primary/70" />
          <input
            type="search"
            value={settingsQuery()}
            onInput={(event) => setSettingsQuery(event.currentTarget.value)}
            placeholder={tx("Search settings…")}
            aria-label={tx("Search settings")}
            class="min-w-0 flex-1 bg-transparent text-[12.5px] text-base-content placeholder:text-az-muted focus:outline-none"
          />
        </div>

        <div class="flex items-center justify-between gap-4 rounded-[11px] border border-az-hairline bg-base-100 px-3.5 py-3">
          <div class="min-w-0">
            <div class="font-medium text-[12.5px] text-az-strong">{t("language.label")}</div>
            <div class="mt-0.5 text-[11px] text-az-muted">{t("language.hint")}</div>
          </div>
          <LanguageSwitcher align="end" />
        </div>

        <Show when={settings()}>
          {(current) => (
            <>
              <Section
                icon="shield"
                title={tx("Agents")}
                hint={tx("detected from the installed CLIs, not from configuration")}
              >
                <For each={state.agents}>{(agent) => <AgentRow status={agent} />}</For>
                <div class="flex items-center gap-2.5 px-3.5 pt-0 pb-3">
                  <button
                    type="button"
                    onClick={() => void actions.recheckAgents()}
                    class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary"
                  >
                    {tx("Re-check")}
                  </button>
                  <Show when={state.agents[0]}>
                    {(first) => (
                      <span class="text-[11.5px] text-az-muted">
                        {tx("last checked")} {relativeTime(first().checkedAt)}
                      </span>
                    )}
                  </Show>
                </div>
              </Section>

              <Section
                icon="sparkles"
                title={tx("Agent defaults")}
                hint={tx("what a new tab starts with")}
              >
                <Row label={tx("Agent")}>
                  <PillMenu<Agent>
                    label={tx("Default agent")}
                    icon="sparkles"
                    value={current().defaultAgent}
                    options={state.agents
                      .filter((agent) => agent.agent === "claude" || agent.agent === "codex")
                      .map((agent) => ({ value: agent.agent, label: AGENT_LABELS[agent.agent] }))}
                    onChange={selectDefaultAgent}
                  />
                </Row>
                <Row label={tx("Model")} hint={tx("chosen from what Models below has enabled")}>
                  <PillMenu
                    label={tx("Default model")}
                    value={current().models[current().defaultAgent].default}
                    options={enabledModels(current().defaultAgent).map((model) => ({
                      value: model.id,
                      label: model.name,
                    }))}
                    onChange={(id) => void actions.setDefaultModel(current().defaultAgent, id)}
                  />
                </Row>
                <Row label={tx("Effort")} hint={tx("reasoning level a new tab starts on")}>
                  <PillMenu
                    label={tx("Default effort")}
                    value={current().defaultEffort}
                    options={effortOptions().map((effort) => ({ value: effort, label: effort }))}
                    onChange={(defaultEffort) => void actions.saveSettings({ defaultEffort })}
                  />
                </Row>
                <Row
                  label={tx("Completed items")}
                  hint={tx("what manual completion does to the row")}
                >
                  <PillMenu
                    label={tx("Completed items")}
                    value={current().completedItems}
                    options={[
                      { value: "resolve", label: tx("Mark resolved") },
                      { value: "delete", label: tx("Delete") },
                    ]}
                    onChange={(completedItems) =>
                      void actions.saveSettings({
                        completedItems: completedItems as "resolve" | "delete",
                      })
                    }
                  />
                </Row>
                <Row
                  label={tx("Agent-finished retention")}
                  hint={tx("user turns kept before automatic retirement")}
                >
                  <PillMenu<"1" | "2" | "3">
                    label={tx("Agent-finished retention")}
                    value={String(current().agentFinishedRetentionTurns) as "1" | "2" | "3"}
                    options={[
                      { value: "1", label: tx("1 turn") },
                      { value: "2", label: tx("2 turns") },
                      { value: "3", label: tx("3 turns") },
                    ]}
                    onChange={(turns) =>
                      void actions.saveSettings({ agentFinishedRetentionTurns: Number(turns) })
                    }
                  />
                </Row>
                <Row
                  label={tx("Inject AgencyZero and Prompt Syntax per turn")}
                  hint={tx(
                    "extended features (items, questions, PR tracking); override with AgencyZeroPerTurn.md",
                  )}
                >
                  <SettingToggle
                    label={tx("Inject AgencyZero and Prompt Syntax per turn")}
                    checked={current().perTurnInjection}
                    onChange={(perTurnInjection) => void actions.saveSettings({ perTurnInjection })}
                  />
                </Row>
                <Row
                  label={tx("PR review prompt")}
                  hint={tx("what a PR review asks; empty uses the built-in prompt")}
                  stack
                >
                  <textarea
                    rows={3}
                    value={current().review?.prompt ?? ""}
                    placeholder={tx(
                      "Review this pull request for correctness bugs, security issues, and anything that would block merge. Be concrete: name the file and line, say what is wrong and why, and rank findings most severe first. If it is solid, say so briefly.",
                    )}
                    onChange={(event) =>
                      void actions.saveSettings({ review: { prompt: event.currentTarget.value } })
                    }
                    class="az-scroll w-full resize-none rounded-lg border border-az-hairline bg-base-300 px-2.5 py-2 text-[12px] text-az-body leading-[1.5] placeholder:text-az-faint focus:outline-none"
                  />
                </Row>
                <Row
                  label={tx("Permission posture")}
                  hint={tx("read_only is the crate default; widen deliberately")}
                  isLast
                >
                  <PillMenu<Permission>
                    label={tx("Default permission")}
                    icon="lock"
                    value={current().defaultPermission}
                    options={permissionsFor(current().defaultAgent).map((permission) => ({
                      value: permission,
                      label: permissionLabel(permission),
                    }))}
                    onChange={(defaultPermission) =>
                      void actions.saveSettings({ defaultPermission })
                    }
                  />
                </Row>
              </Section>

              <Section
                icon="sliders-horizontal"
                title={tx("Models")}
                hint={tx("what each picker offers")}
              >
                <For each={state.models}>
                  {(catalogue) => (
                    <AgentModelList
                      catalogue={catalogue}
                      selection={current().models[catalogue.agent]}
                    />
                  )}
                </For>
                <div class="flex flex-wrap items-center gap-2.5 px-3.5 pt-0 pb-3">
                  <button
                    type="button"
                    onClick={() => void actions.refreshModels()}
                    class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary"
                  >
                    {tx("Re-read from the CLIs")}
                  </button>
                  <span class="text-[11.5px] text-az-muted">
                    {tx("only Codex can enumerate; the other two stay on the compiled list")}
                  </span>
                </div>
              </Section>

              <Section
                icon="list-checks"
                title={tx("Task Manager")}
                hint={tx("the Home conversation that keeps the lists in order")}
              >
                <Row label={tx("Agent")}>
                  <PillMenu<Agent>
                    label={tx("Task manager agent")}
                    icon="sparkles"
                    value={current().taskManager.agent}
                    options={state.agents
                      .filter((status) => status.agent === "claude" || status.agent === "codex")
                      .map((status) => ({
                        value: status.agent,
                        label: AGENT_LABELS[status.agent],
                      }))}
                    onChange={selectTaskManagerAgent}
                  />
                </Row>
                <Row
                  label={tx("Model")}
                  hint={tx(
                    "its own, deliberately — a list keeper running unattended should not bill at the prompt's rates",
                  )}
                >
                  <PillMenu
                    label={tx("Task manager model")}
                    value={current().taskManager.model}
                    options={enabledModels(current().taskManager.agent).map((model) => ({
                      value: model.id,
                      label: model.name,
                    }))}
                    onChange={selectTaskManagerModel}
                  />
                </Row>
                <Row label={tx("Effort")}>
                  <PillMenu
                    label={tx("Task manager effort")}
                    value={current().taskManager.effort}
                    options={taskManagerEfforts().map((effort) => ({
                      value: effort,
                      label: effort,
                    }))}
                    onChange={(effort) =>
                      void actions.saveSettings({
                        taskManager: { ...current().taskManager, effort },
                      })
                    }
                  />
                </Row>
                <Row label={tx("Permission posture")}>
                  <PillMenu<Permission>
                    label={tx("Task manager permission")}
                    icon="lock"
                    value={current().taskManager.permission}
                    options={permissionsFor(current().taskManager.agent).map((permission) => ({
                      value: permission,
                      label: permissionLabel(permission),
                    }))}
                    onChange={(permission) =>
                      void actions.saveSettings({
                        taskManager: { ...current().taskManager, permission },
                      })
                    }
                  />
                </Row>
                <Row
                  label={tx("Working directories")}
                  hint={tx("the first is the working directory; empty means the workspace root")}
                >
                  <TaskManagerDirs taskManager={current().taskManager} />
                </Row>
                <Row
                  label={tx("Conversation")}
                  hint={tx(
                    "reset starts the next prompt fresh; the transcript and collected tasks stay",
                  )}
                  isLast
                >
                  <ResetTaskManagerButton />
                </Row>
              </Section>

              <CostSection />

              <Section icon="settings" title={tx("Application")} hint={tx("the running instance")}>
                <Row
                  label={tx("Build")}
                  hint={tx(
                    "version · commit · compiled — a * after the commit means uncommitted edits",
                  )}
                >
                  <BuildStamp />
                </Row>
                <Row
                  label={tx("Update")}
                  hint={tx("signed manifest; installing refuses while runs are active")}
                >
                  <UpdateControl />
                </Row>
                <Row
                  label={tx("Check for updates at launch")}
                  hint={tx("checks only; an update is never installed automatically")}
                >
                  <SettingToggle
                    label={tx("Check for updates at launch")}
                    checked={current().automaticUpdateChecks}
                    onChange={(automaticUpdateChecks) =>
                      void actions.saveSettings({ automaticUpdateChecks })
                    }
                  />
                </Row>
                <Row
                  label={tx("Agent restart authority")}
                  hint={tx("disabled by default; applies only after the agent's turn finishes")}
                >
                  <PillMenu<"disabled" | "restart" | "restart_and_update">
                    label={tx("Agent restart authority")}
                    value={current().agentRestartPolicy}
                    options={[
                      { value: "disabled", label: tx("Disabled") },
                      { value: "restart", label: tx("Restart only") },
                      { value: "restart_and_update", label: tx("Restart & update") },
                    ]}
                    onChange={(agentRestartPolicy) =>
                      void actions.saveSettings({ agentRestartPolicy })
                    }
                  />
                </Row>
                <Row
                  label={tx("Open source")}
                  hint={tx("If AgencyZero is useful, a GitHub star helps more people find it.")}
                >
                  <SourceActions />
                </Row>
                <Row
                  label={tx("Restart")}
                  hint={tx(
                    "drains the store, then reopens into the build currently on disk — the second half of a rebuild",
                  )}
                  isLast
                >
                  <RelaunchButton />
                </Row>
              </Section>

              <Section icon="sparkles" title={t("appearance.title")} hint={t("appearance.hint")}>
                <Row label={t("appearance.mode")} hint={t("appearance.modeHint")}>
                  <div class="flex items-center gap-1 rounded-full border border-az-hairline bg-az-inset p-1">
                    <For
                      each={[
                        { value: "dark" as const, label: t("appearance.dark") },
                        { value: "light" as const, label: t("appearance.light") },
                      ]}
                    >
                      {(option) => (
                        <button
                          type="button"
                          aria-pressed={prefs.colorMode === option.value}
                          onClick={() => setPrefs("colorMode", option.value)}
                          class={`rounded-full px-3 py-1 font-semibold text-[11px] transition-colors ${
                            prefs.colorMode === option.value
                              ? "bg-primary text-primary-content"
                              : "text-az-muted hover:bg-az-hover hover:text-az-title"
                          }`}
                        >
                          {option.label}
                        </button>
                      )}
                    </For>
                  </div>
                </Row>
                <Row label={t("appearance.size")} hint={t("appearance.sizeHint")}>
                  <div class="flex items-center gap-1 rounded-full border border-az-hairline bg-az-inset p-1">
                    <For
                      each={[
                        { value: "normal" as const, label: "N", name: t("appearance.normal") },
                        { value: "large" as const, label: "L", name: t("appearance.large") },
                        {
                          value: "extra-large" as const,
                          label: "XL",
                          name: t("appearance.extraLarge"),
                        },
                      ]}
                    >
                      {(option) => (
                        <button
                          type="button"
                          aria-label={`${option.name} ${t("appearance.size")}`}
                          aria-pressed={prefs.uiSize === option.value}
                          onClick={() => setPrefs("uiSize", option.value)}
                          class={`flex size-7 items-center justify-center rounded-full font-semibold text-[10.5px] transition-colors ${
                            prefs.uiSize === option.value
                              ? "bg-primary text-primary-content"
                              : "text-az-muted hover:bg-az-hover hover:text-az-title"
                          }`}
                        >
                          {option.label}
                        </button>
                      )}
                    </For>
                  </div>
                </Row>
                <ThemePicker
                  theme={current().theme}
                  onSurface={(surface) =>
                    void actions.saveSettings({
                      theme: {
                        surface,
                        wash: normalizeWash(current().theme.wash),
                      },
                    })
                  }
                  onAccent={(accent) => void actions.saveSettings({ theme: { accent } })}
                  onSoftness={(softness) => void actions.saveSettings({ theme: { softness } })}
                  onWash={(wash) => void actions.saveSettings({ theme: { wash } })}
                  onBrightness={(textBrightness) =>
                    void actions.saveSettings({ theme: { textBrightness } })
                  }
                  isDefault={
                    current().theme.surface === "" &&
                    current().theme.accent === "" &&
                    current().theme.softness === 0 &&
                    normalizeWash(current().theme.wash) === DEFAULT_WASH &&
                    current().theme.textBrightness === 0
                  }
                  onReset={() =>
                    void actions.saveSettings({
                      theme: {
                        surface: "",
                        accent: "",
                        softness: 0,
                        wash: DEFAULT_WASH,
                        textBrightness: 0,
                      },
                    })
                  }
                />
              </Section>

              <Section
                icon="folder"
                title={tx("Data")}
                hint={tx("where projects, items and messages are stored")}
              >
                <Show when={state.workspaceRoot}>
                  {(root) => (
                    <Row
                      label={tx("Workspace")}
                      hint={
                        root().exists
                          ? tx("new projects run here")
                          : tx("recommended, and not created yet")
                      }
                    >
                      <div class="flex items-center gap-2">
                        <span class="max-w-[280px] truncate font-mono text-[11.5px] text-az-body">
                          {root().path}
                        </span>
                        <Show when={!root().exists}>
                          <button
                            type="button"
                            onClick={() => void actions.createWorkspaceRoot()}
                            class="shrink-0 rounded-lg border border-primary/50 px-2.5 py-[4px] text-[11.5px] text-primary transition-colors hover:border-primary"
                          >
                            {tx("Create it")}
                          </button>
                        </Show>
                      </div>
                    </Row>
                  )}
                </Show>

                <Show when={state.dataLocation}>
                  {(location) => (
                    <>
                      <Row
                        label={tx("Location")}
                        hint={
                          location().source === "env"
                            ? tx("set by AZ_DATA_DIR, which a saved path cannot override")
                            : tx("a change takes effect on the next launch; nothing is moved")
                        }
                      >
                        <span class="max-w-[340px] truncate font-mono text-[11.5px] text-az-body">
                          {location().path}
                        </span>
                      </Row>
                      {/*
                       * The pending row is what makes a change visible at all.
                       * Nothing moves until the next launch, so without it a
                       * directory that was chosen and written looks exactly
                       * like a chooser that did nothing.
                       */}
                      <Show when={location().pending}>
                        {(pending) => (
                          <Row label={tx("Next launch")} hint={tx("relaunch to open here")}>
                            <span class="max-w-[340px] truncate font-mono text-[11.5px] text-primary">
                              {pending().path}
                            </span>
                          </Row>
                        )}
                      </Show>
                      <Row
                        label={tx("Tables")}
                        hint={tx("how much disk each one holds — the logs outgrow the transcript")}
                      >
                        <TableSizes />
                      </Row>
                      <Row label={tx("Change it")}>
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={!location().isEditable || !isLive("chooseDataDirectory")}
                            onClick={() => void actions.chooseDataLocation()}
                            class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {tx("Choose…")}
                          </button>
                          <button
                            type="button"
                            disabled={
                              !location().isEditable ||
                              // Whether there is a pointer left to clear, which
                              // after a change this session is what the pending
                              // half says — `source` describes how *this* launch
                              // resolved and no longer moves.
                              (location().pending ?? location()).source === "default"
                            }
                            onClick={() => void actions.setDataLocation(null)}
                            class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {tx("Use the default")}
                          </button>
                        </div>
                      </Row>
                      <Row
                        label={tx("Backups")}
                        hint={tx("closed-store copies verified byte for byte")}
                        isLast
                      >
                        <StoreBackupControls />
                      </Row>
                    </>
                  )}
                </Show>
              </Section>

              <ChatImportSettings />

              <StudySettings />

              <Section
                icon="lock"
                title={tx("Agent authority")}
                hint={tx("explicit capabilities delegated to Prompt Syntax")}
              >
                <Row
                  label={tx("Update app settings")}
                  hint={tx("off by default; allows only the settings keys this build declares")}
                  isLast
                >
                  <SettingToggle
                    label={tx("Allow agents to update app settings")}
                    checked={current().agentSettingsUpdates}
                    onChange={(agentSettingsUpdates) =>
                      void actions.saveSettings({ agentSettingsUpdates })
                    }
                  />
                </Row>
              </Section>

              <Section
                icon="shield"
                title={tx("Moderator")}
                hint={tx("a second agent watching the stream — costs tokens")}
                pending={moderatorPending()}
              >
                <Row
                  label={tx("Enabled by default")}
                  hint={tx("each session can turn it off in its Settings section")}
                >
                  <SettingToggle
                    label={tx("Moderator enabled by default")}
                    checked={current().moderator.enabled}
                    onChange={(enabled) => void actions.saveSettings({ moderator: { enabled } })}
                  />
                </Row>
                <Row label={tx("Moderator model")}>
                  <PillMenu
                    label={tx("Moderator model")}
                    value={current().moderator.model}
                    options={enabledModels("claude").map((model) => ({
                      value: model.id,
                      label: model.name,
                    }))}
                    onChange={(model) => void actions.saveSettings({ moderator: { model } })}
                  />
                </Row>
                <Row label={tx("Confine tool calls to the working directories")}>
                  <SettingToggle
                    label={tx("Confine tool calls to the working directories")}
                    checked={current().moderator.confineToDirs}
                    onChange={(confineToDirs) =>
                      void actions.saveSettings({ moderator: { confineToDirs } })
                    }
                  />
                </Row>

                <div class="flex flex-col gap-2.5 px-3.5 py-3">
                  <span class="font-semibold text-[11.5px] text-az-muted uppercase tracking-[.04em]">
                    {tx("On a hold")}
                  </span>

                  <HoldRow
                    severity="CHECK"
                    tone="warning"
                    description={tx(
                      "The step waits on you; everything else keeps running. Tab dot goes red.",
                    )}
                    checked={current().moderator.onCheck === "hold_step"}
                    onChange={(hold) =>
                      void actions.saveSettings({
                        moderator: { onCheck: hold ? "hold_step" : "notify" },
                      })
                    }
                  />
                  <HoldRow
                    severity="CRITICAL"
                    tone="error"
                    description={tx(
                      "Cancel the run and its whole process group, then wait. Tab dot goes red.",
                    )}
                    checked={current().moderator.onCritical === "cancel_run"}
                    onChange={(cancel) =>
                      void actions.saveSettings({
                        moderator: { onCritical: cancel ? "cancel_run" : "hold_step" },
                      })
                    }
                  />
                </div>
              </Section>

              <Section
                icon="info"
                title={tx("Notifications")}
                hint={tx("while you are in another window")}
                pending={runPathPending()}
              >
                <Row label={tx("A hold needs your approval")}>
                  <SettingToggle
                    label={tx("Notify on a hold")}
                    checked={current().notifications.onHold}
                    onChange={(onHold) => void actions.saveSettings({ notifications: { onHold } })}
                  />
                </Row>
                <Row label={tx("A run finishes")}>
                  <SettingToggle
                    label={tx("Notify when a run finishes")}
                    checked={current().notifications.onRunFinished}
                    onChange={(onRunFinished) =>
                      void actions.saveSettings({ notifications: { onRunFinished } })
                    }
                  />
                </Row>
                <Row label={tx("A task fails")}>
                  <SettingToggle
                    label={tx("Notify when a task fails")}
                    checked={current().notifications.onTaskFailed}
                    onChange={(onTaskFailed) =>
                      void actions.saveSettings({ notifications: { onTaskFailed } })
                    }
                  />
                </Row>
                <Row label={tx("Rate limited by the provider")}>
                  <SettingToggle
                    label={tx("Notify when rate limited")}
                    checked={current().notifications.onRateLimited}
                    onChange={(onRateLimited) =>
                      void actions.saveSettings({ notifications: { onRateLimited } })
                    }
                  />
                </Row>
                <Row label={tx("Play a sound")} isLast>
                  <SettingToggle
                    label={tx("Play a sound")}
                    checked={current().notifications.sound}
                    onChange={(sound) => void actions.saveSettings({ notifications: { sound } })}
                  />
                </Row>
              </Section>

              <Section
                icon="lock"
                title={tx("Environment")}
                pending={runPathPending()}
                hint={tx("what the agent process inherits from this machine")}
              >
                <Row
                  label={tx("Environment policy")}
                  hint={tx(
                    "Minimal passes only PATH, HOME and USER — the verified floor for all three CLIs",
                  )}
                >
                  <PillMenu<EnvPolicy>
                    label={tx("Environment policy")}
                    value={current().envPolicy}
                    options={(["minimal", "inherit"] as const).map((policy) => ({
                      value: policy,
                      label: envPolicyLabel(policy),
                    }))}
                    onChange={(envPolicy) => void actions.saveSettings({ envPolicy })}
                  />
                </Row>
                <Row
                  label={tx("Forward proxy and custom-CA variables")}
                  hint={tx("off by default: HTTPS_PROXY often embeds credentials")}
                  isLast
                >
                  <SettingToggle
                    label={tx("Forward proxy and custom-CA variables")}
                    checked={current().forwardProxyVars}
                    onChange={(forwardProxyVars) => void actions.saveSettings({ forwardProxyVars })}
                  />
                </Row>
              </Section>

              <Show when={isLive("claudeUsage")}>
                <ExperimentalSettings />
              </Show>

              <p class="flex gap-2 text-[11.5px] text-az-muted leading-[1.5]">
                <Icon name="info" class="relative top-0.5 shrink-0 text-[13px]" />
                <span>
                  {tx("Sessions are stored per project by agent-abstraction at")}{" "}
                  <code class="font-mono">{tx("<dir>/<project-slug>/<name>.json")}</code>.
                </span>
              </p>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

/** Discover provider-owned local transcripts and copy only an explicit choice. */
function ChatImportSettings(): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [sources, setSources] = createSignal<ChatImportSource[]>([]);
  const [selected, setSelected] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal<string | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  const available = () => isLive("discoverChatImports") && isLive("importChatSession");
  const importableSessions = (source: ChatImportSource) =>
    source.sessions.filter((session) => session.importable);

  const refresh = async (): Promise<void> => {
    if (!available()) return;
    setSources(await actions.discoverChatImports());
  };

  onMount(() => {
    void refresh().catch((cause) => setNote(describeError(cause)));
  });

  const importOne = async (source: string, sessionId: string): Promise<void> => {
    const key = `${source}:${sessionId}`;
    setBusy(key);
    setNote(null);
    try {
      const project = await actions.importChatSession(source, sessionId);
      setNote(tx("Imported as {name}", { name: project.name }));
      actions.openProject(project.id);
    } catch (cause) {
      setNote(describeError(cause));
    } finally {
      setBusy(null);
    }
  };
  const importAll = async (source: ChatImportSource): Promise<void> => {
    setBusy(`${source.source}:*`);
    setNote(null);
    let imported = 0;
    try {
      // Sequential on purpose: selected rollouts can be large, and importing
      // all of them concurrently would multiply both memory and store writes.
      for (const session of importableSessions(source)) {
        await actions.importChatSession(source.source, session.id);
        imported += 1;
      }
      setNote(
        tx("Imported {count} chats from {source}", {
          count: imported,
          source: source.label,
        }),
      );
    } catch (cause) {
      setNote(
        `${tx("Imported {count} chats from {source}", {
          count: imported,
          source: source.label,
        })} · ${describeError(cause)}`,
      );
    } finally {
      setBusy(null);
    }
  };
  const choice = (source: ChatImportSource) =>
    selected()[source.source] ?? importableSessions(source)[0]?.id ?? "";

  return (
    <Section
      icon="messages-square"
      title={tx("Import chats")}
      hint={tx("copy local provider transcripts into new AgencyZero projects")}
      pending={available() ? undefined : tx("requires the native import backend")}
    >
      <Show
        when={sources().length > 0}
        fallback={
          <Row label={tx("Local sources")} hint={tx("checking known provider stores")} isLast>
            <span class="text-[11.5px] text-az-muted">{tx("No sessions discovered")}</span>
          </Row>
        }
      >
        <For each={sources()}>
          {(source, sourceIndex) => (
            <Row
              label={source.label}
              hint={source.note}
              isLast={sourceIndex() === sources().length - 1}
            >
              <div class="flex max-w-[480px] flex-col items-end gap-1.5">
                <Show
                  when={importableSessions(source).length > 0}
                  fallback={
                    <span class="text-[11px] text-az-faint">
                      {source.available ? tx("No importable sessions") : tx("Not installed")}
                    </span>
                  }
                >
                  <div class="flex w-full items-center gap-2">
                    <select
                      value={choice(source)}
                      aria-label={tx("Choose a session from {source}", { source: source.label })}
                      onChange={(event) =>
                        setSelected((current) => ({
                          ...current,
                          [source.source]: event.currentTarget.value,
                        }))
                      }
                      class="h-9 min-w-0 flex-1 rounded-lg border border-az-hairline bg-az-inset px-2 text-[12px] text-az-body outline-none"
                    >
                      <For each={importableSessions(source)}>
                        {(session) => (
                          <option value={session.id}>
                            {session.title}
                            {session.messages > 0 ? ` · ${session.messages}` : ""}
                          </option>
                        )}
                      </For>
                    </select>
                    <button
                      type="button"
                      disabled={!choice(source) || busy() !== null}
                      onClick={() => void importOne(source.source, choice(source))}
                      class="h-9 shrink-0 rounded-lg border border-az-hairline-strong px-2.5 text-[11px] text-primary transition-colors hover:border-primary disabled:opacity-40"
                    >
                      {busy() === `${source.source}:${choice(source)}`
                        ? tx("Importing…")
                        : tx("Import")}
                    </button>
                    <button
                      type="button"
                      disabled={busy() !== null}
                      onClick={() => void importAll(source)}
                      class="h-9 shrink-0 rounded-lg border border-primary/45 px-2.5 font-medium text-[11px] text-primary transition-colors hover:border-primary hover:bg-primary/10 disabled:opacity-40"
                    >
                      {busy() === `${source.source}:*` ? tx("Importing all…") : tx("Import all")}
                    </button>
                  </div>
                </Show>
              </div>
            </Row>
          )}
        </For>
      </Show>
      <Show when={note()}>
        {(message) => <p class="px-3.5 py-2 text-[11.5px] text-az-muted">{message()}</p>}
      </Show>
    </Section>
  );
}

/**
 * Explicit local consent and lifecycle controls for the PS deployment study.
 *
 * This lives beside Data because the important fact is custody: rows stay in
 * this WorkTable store until the owner exports or deletes them. It is not a
 * generic analytics switch and no network destination exists.
 */
function StudySettings(): JSX.Element {
  const { state, actions, isLive } = useWorkspace();
  const [summary, setSummary] = createSignal<StudySummary | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  const available = () => state.backend === "mock" || isLive("getStudySummary");

  const refresh = async (): Promise<void> => {
    if (!available()) return;
    setSummary(await actions.getStudySummary());
  };

  onMount(() => {
    void refresh().catch((cause) => {
      setNote(`Study status unavailable: ${describeError(cause)}`);
    });
  });

  const toggle = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await actions.saveSettings({ studyAnalytics: { enabled } });
      await refresh();
      setNote(enabled ? "Collection started locally." : "Collection stopped.");
    } catch (cause) {
      setNote(`Could not change collection: ${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportEvents = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const path = await actions.exportStudyEvents();
      setNote(path ? "De-identified JSONL exported." : "Export canceled.");
    } catch (cause) {
      setNote(`Could not export: ${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const clearEvents = async (): Promise<void> => {
    if (!confirmingDelete()) {
      setConfirmingDelete(true);
      setNote("Choose Confirm delete to remove every stored study event.");
      return;
    }
    setBusy(true);
    try {
      await actions.clearStudyEvents();
      setConfirmingDelete(false);
      await refresh();
      setNote("Stored study events deleted. The collection setting was not changed.");
    } catch (cause) {
      setNote(`Could not delete study data: ${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const enabled = () => state.settings?.studyAnalytics.enabled ?? false;

  return (
    <Section
      icon="gauge"
      title={tx("Research")}
      hint={tx("local, opt-in PromptSyntax deployment study")}
      pending={available() ? undefined : tx("needs the study event backend")}
    >
      <div class="border-az-hairline-soft border-b px-3.5 py-3 text-[11.5px] text-az-muted leading-[1.55]">
        {tx(
          "Records timestamps, prompt character and line counts, attachment counts, whether you used PromptSyntax, operation types, providers, opaque links, timing and explicit outcomes. It does not copy prompt text, agent prose, task titles, paths, URLs, tool calls, tool output or attachment contents. Nothing is uploaded.",
        )}
      </div>
      <Row
        label={tx("PS deployment study")}
        hint={tx("off by default; disabling stops new rows but keeps existing data")}
      >
        <SettingToggle
          label={tx("PS deployment study")}
          checked={enabled()}
          disabled={!available() || busy()}
          onChange={(checked) => void toggle(checked)}
        />
      </Row>
      <Row
        label={tx("Stored events")}
        hint={
          summary()?.enabledAt
            ? tx("{kind} interval started {time}", {
                kind: enabled() ? tx("current") : tx("last"),
                time: relativeTime(summary()!.enabledAt!, Date.now()),
              })
            : tx("no study interval has been started")
        }
      >
        <span class="font-mono text-[12px] text-az-strong tabular-nums">
          {summary()?.eventCount ?? 0}
        </span>
      </Row>
      <Row
        label={tx("Study data")}
        hint={
          note() ??
          (enabled()
            ? tx("export is available now; stop collection before deleting stored events")
            : tx("export is de-identified JSONL; deletion is local and permanent"))
        }
        isLast
      >
        <div class="flex items-center gap-2">
          <button
            type="button"
            disabled={busy()}
            onClick={() => void exportEvents()}
            class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
          >
            {tx("Export JSONL")}
          </button>
          <button
            type="button"
            disabled={busy() || enabled() || (summary()?.eventCount ?? 0) === 0}
            onClick={() => void clearEvents()}
            onBlur={() => setConfirmingDelete(false)}
            class={`rounded-lg border px-3 py-[5px] text-[12px] transition-colors disabled:opacity-40 ${
              confirmingDelete()
                ? "border-error/60 text-error hover:border-error"
                : "border-az-hairline-strong text-az-muted hover:border-error/50 hover:text-error"
            }`}
          >
            {confirmingDelete() ? tx("Confirm delete") : tx("Delete data")}
          </button>
        </div>
      </Row>
    </Section>
  );
}

/** Provider usage controls compiled and advertised only by the experimental profile. */
function ExperimentalSettings(): JSX.Element {
  const { state, actions } = useWorkspace();
  const now = useNow();
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);

  const refresh = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await Promise.all([actions.refreshQuota(), actions.refreshClaudeUsage()]);
    } catch (cause) {
      setNote(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  onMount(() => void refresh());

  const windowValue = (value: { utilization: number; resetsAt: string | null } | null): string => {
    if (!value) return tx("not reported");
    const reset = value.resetsAt
      ? ` ${tx("· resets in {time}", { time: countdown(value.resetsAt, now()) })}`
      : "";
    const percent = Math.min(100, Math.max(0, value.utilization));
    return `${percent.toFixed(1)}%${reset}`;
  };

  const usage = () => state.claudeUsage;
  const codexWindow = () => {
    const windows = state.quota?.agents.find((agent) => agent.agent === "codex")?.windows ?? [];
    return windows.reduce<(typeof windows)[number] | null>(
      (longest, candidate) =>
        (candidate.windowMinutes ?? 0) > (longest?.windowMinutes ?? 0) ? candidate : longest,
      null,
    );
  };

  return (
    <Section
      icon="sparkles"
      title={tx("Experimental")}
      hint={tx("isolated capabilities in AgencyZero Experimental")}
    >
      <Row
        label={tx("Codex 7-day usage")}
        hint={tx("managed by Codex; refreshed through its local app-server")}
      >
        <span class="font-mono text-[11.5px] text-az-body">
          {codexWindow()?.usedFraction === null || codexWindow()?.usedFraction === undefined
            ? tx("not reported")
            : `${Math.round(Math.min(1, Math.max(0, codexWindow()!.usedFraction!)) * 100)}% used${
                codexWindow()?.resetsAt
                  ? ` ${tx("· resets in {time}", {
                      time: countdown(codexWindow()!.resetsAt!, now()),
                    })}`
                  : ""
              }`}
        </span>
      </Row>
      <Row
        label={tx("Claude login")}
        hint={tx(
          "managed by Claude Code; an expired credential is refreshed through its own /usage command",
        )}
      >
        <span class="font-mono text-[11.5px] text-az-body">{tx("Claude Code")}</span>
      </Row>
      <Row label={tx("Claude 5-hour usage")}>
        <span class="font-mono text-[11.5px] text-az-body">
          {windowValue(usage()?.fiveHour ?? null)}
        </span>
      </Row>
      <Row label={tx("Claude 7-day usage")}>
        <span class="font-mono text-[11.5px] text-az-body">
          {windowValue(usage()?.sevenDay ?? null)}
        </span>
      </Row>
      <Show when={usage()?.sevenDaySonnet}>
        {(value) => (
          <Row label={tx("Claude Sonnet 7-day usage")}>
            <span class="font-mono text-[11.5px] text-az-body">{windowValue(value())}</span>
          </Row>
        )}
      </Show>
      <Show when={(usage()?.limits.length ?? 0) > 0}>
        <For each={usage()?.limits ?? []}>
          {(limit) => (
            <Row label={`Claude ${limit.model ?? limit.kind}`}>
              <span class="font-mono text-[11.5px] text-az-body">
                {limit.percent.toFixed(1)}%
                {limit.resetsAt
                  ? ` ${tx("· resets in {time}", { time: countdown(limit.resetsAt, now()) })}`
                  : ""}
                {limit.severity ? ` · ${limit.severity}` : ""}
              </span>
            </Row>
          )}
        </For>
      </Show>
      <Row
        label={tx("Refresh usage")}
        hint={
          usage() ? `checked ${relativeTime(usage()!.checkedAt, now())}` : (note() ?? undefined)
        }
        isLast
      >
        <div class="flex items-center gap-2">
          <Show when={note()}>
            {(message) => <span class="max-w-[230px] text-[11px] text-error">{message()}</span>}
          </Show>
          <button
            type="button"
            disabled={busy()}
            onClick={() => void refresh()}
            class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
          >
            {busy() ? tx("Refreshing…") : tx("Refresh")}
          </button>
        </div>
      </Row>
    </Section>
  );
}

/**
 * The task manager's working directories — the fix for its sharpest failure.
 *
 * The first entry becomes the run's cwd and every later entry widens its
 * working scope. With none set, runs execute at the workspace root.
 */
/**
 * What each table costs on disk, largest first.
 *
 * Loaded on mount rather than at boot: it is a directory walk, and nothing else
 * in Settings needs it. Reads as a list because the *ordering* is the finding —
 * that the task log and the raw I/O dwarf the transcript is what tells you
 * where a growing store is going.
 */
function TableSizes(): JSX.Element {
  const { state, actions } = useWorkspace();
  const [sizes, setSizes] = createSignal<TableSize[] | null>(null);
  const [failed, setFailed] = createSignal(false);

  onMount(() => {
    void actions
      .listTableSizes()
      .then(setSizes)
      .catch((cause) => {
        setFailed(true);
        log.error(`could not measure the tables: ${describeError(cause)}`);
      });
  });

  const total = () => (sizes() ?? []).reduce((sum, table) => sum + table.bytes, 0);

  return (
    <Show
      when={sizes()}
      fallback={
        <span class="text-[11.5px] text-az-muted">
          {failed() ? tx("unavailable") : tx("measuring…")}
        </span>
      }
    >
      {(tables) => (
        <div class="flex max-w-[340px] flex-col gap-1">
          <For each={tables()}>
            {(table) => (
              <div class="flex items-baseline justify-between gap-3">
                <span class="truncate font-mono text-[11px] text-az-body">{table.name}</span>
                <span class="shrink-0 font-mono text-[11px] text-az-muted">
                  {formatBytes(table.bytes)}
                </span>
              </div>
            )}
          </For>
          <div class="mt-0.5 flex items-baseline justify-between gap-3 border-az-hairline border-t pt-1">
            <span class="font-semibold text-[11px] text-az-muted uppercase tracking-[.04em]">
              {tx("total")}
            </span>
            <span class="shrink-0 font-mono text-[11px] text-az-strong">
              {formatBytes(total())}
            </span>
          </div>
          <Show when={state.backend === "mock"}>
            <span class="text-[10.5px] text-az-faint">{tx("fixtures — no store to measure")}</span>
          </Show>
        </div>
      )}
    </Show>
  );
}

/**
 * Backup and restore deliberately restart the app. The angel waits until this
 * process has drained and released the store, then archives and byte-verifies
 * it while closed. Save and restore paths come only from native OS pickers.
 */
function StoreBackupControls(): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [status, setStatus] = createSignal<StoreBackupStatus | null>(null);
  const [error, setError] = createSignal("");
  const [selection, setSelection] = createSignal<StoreBackupSelection | null>(null);

  onMount(() => {
    void actions
      .getStoreBackupStatus()
      .then(setStatus)
      .catch((cause) => {
        const message = describeError(cause);
        setError(message);
        log.error(`could not list store backups: ${message}`);
      });
  });

  const backup = (): void => {
    setError("");
    void actions.createStoreBackup().catch((cause) => setError(describeError(cause)));
  };

  const selectBackup = (): void => {
    setError("");
    void actions
      .selectStoreBackup()
      .then((picked) => {
        if (picked) setSelection(picked);
      })
      .catch((cause) => setError(describeError(cause)));
  };

  const restore = (): void => {
    setError("");
    void actions.restoreStoreBackup().catch((cause) => {
      setError(describeError(cause));
    });
  };

  return (
    <div class="flex max-w-[390px] flex-col items-end gap-1.5">
      <span class="text-right text-[11px] text-az-muted">
        {tx("Portable .azbackup package · version and integrity checked")}
      </span>
      <span class="text-right text-[10.5px] text-az-faint">
        {tx("The app drains and restarts so the store is never copied while open.")}
      </span>
      <Show when={status()?.lastOperation}>
        {(operation) => (
          <span
            class={`text-right text-[10.5px] ${operation().ok ? "text-success" : "text-error"}`}
          >
            {operation().message}
          </span>
        )}
      </Show>
      <Show when={error()}>
        <span role="alert" class="text-right text-[10.5px] text-error">
          {error()}
        </span>
      </Show>
      <div class="flex items-center gap-2">
        <button
          type="button"
          disabled={!isLive("createStoreBackup")}
          onClick={backup}
          class="rounded-lg border border-primary/50 px-3 py-[5px] text-[12px] text-primary transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {tx("Back up & close")}
        </button>
        <Show
          when={selection()}
          fallback={
            <button
              type="button"
              disabled={!isLive("selectStoreBackup")}
              onClick={selectBackup}
              class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-muted transition-colors hover:border-warning hover:text-warning disabled:cursor-not-allowed disabled:opacity-40"
            >
              {tx("Select backup file…")}
            </button>
          }
        >
          <code class="max-w-[160px] truncate font-mono text-[10.5px] text-az-body">
            {selection()?.fileName}
          </code>
          <button
            type="button"
            onClick={restore}
            class="rounded-lg border border-warning/50 px-2.5 py-[4px] font-semibold text-[11.5px] text-warning hover:border-warning"
          >
            {tx("Restore")}
          </button>
          <button
            type="button"
            onClick={() => setSelection(null)}
            class="rounded-lg px-2 py-[4px] text-[11.5px] text-az-muted hover:text-base-content"
          >
            {tx("Cancel")}
          </button>
        </Show>
      </div>
    </div>
  );
}

function TaskManagerDirs(props: { taskManager: TaskManagerSettings }): JSX.Element {
  const { actions } = useWorkspace();
  const [path, setPath] = createSignal("");

  const save = (dirs: string[]): void => {
    void actions.saveSettings({ taskManager: { ...props.taskManager, dirs } });
  };

  const add = (): void => {
    const value = path().trim();
    if (!value) return;
    save([...props.taskManager.dirs, value]);
    setPath("");
  };

  return (
    <div class="flex min-w-0 max-w-[300px] flex-col items-end gap-1.5">
      <For each={props.taskManager.dirs}>
        {(dir) => (
          <span class="flex max-w-full items-center gap-1.5 rounded-md border border-az-hairline bg-base-300 px-2 py-0.5">
            <span class="truncate font-mono text-[11px] text-az-body">{dir}</span>
            <button
              type="button"
              onClick={() => save(props.taskManager.dirs.filter((kept) => kept !== dir))}
              aria-label={`Remove ${dir}`}
              class="shrink-0 text-az-faint transition-colors hover:text-error"
            >
              <Icon name="x" class="text-[11px]" />
            </button>
          </span>
        )}
      </For>
      <input
        value={path()}
        placeholder={tx("~/code/…")}
        aria-label={tx("Add a task manager directory")}
        onInput={(event) => setPath(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
        onBlur={add}
        class="w-[200px] rounded-md border border-az-hairline bg-az-inset px-2 py-1 font-mono text-[11px] text-az-body focus:border-primary/40 focus:outline-none"
      />
    </div>
  );
}

/**
 * Reset the task manager's conversation, with its session named beside it.
 *
 * Disabled when there is no session: reset is "start thinking again", and a
 * conversation that never started has nothing to start again.
 */
function ResetTaskManagerButton(): JSX.Element {
  const { state, actions, isLive } = useWorkspace();
  const [busy, setBusy] = createSignal(false);

  const reset = async (): Promise<void> => {
    setBusy(true);
    try {
      await actions.resetTaskManager();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex min-w-0 items-center gap-2.5">
      <Show
        when={state.taskManagerSession}
        fallback={
          <span class="font-mono text-[11px] text-az-faint">{tx("no conversation yet")}</span>
        }
      >
        {(session) => (
          <span class="max-w-[180px] truncate font-mono text-[11px] text-az-faint">
            {session()}
          </span>
        )}
      </Show>
      <button
        type="button"
        onClick={() => void reset()}
        disabled={busy() || !state.taskManagerSession || !isLive("resetTaskManager")}
        class="shrink-0 rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-warning hover:text-warning disabled:opacity-40"
      >
        {busy() ? tx("Resetting…") : tx("Reset")}
      </button>
    </div>
  );
}

/**
 * Restart into the binary currently on disk.
 *
 * "Restarting…" is optimistic and stays that way on success — the process is
 * replaced mid-await, so there is nothing to reset. The window vanishing is
 * the success state.
 */
/**
 * Which build this window is running, so "am I testing the fix?" is answered
 * by reading the screen instead of comparing binary timestamps in a shell.
 * The same stamp opens every log file and fills the About box.
 */
function BuildStamp(): JSX.Element {
  const { actions } = useWorkspace();
  const [build, setBuild] = createSignal<BuildInfo | null>(null);

  // Once per visit: the answer cannot change without the process being
  // replaced, and a replaced process remounts this anyway.
  onMount(() => {
    void actions
      .getBuildInfo()
      .then(setBuild)
      .catch(() => setBuild(null));
  });

  return (
    <Show when={build()} fallback={<span class="text-[12px] text-az-faint">—</span>}>
      {(info) => (
        <span class="font-mono text-[11.5px] text-az-body">
          {info().version} · {info().gitSha} {tx("· built")} {info().builtAt}
        </span>
      )}
    </Show>
  );
}

const AGENCYZERO_REPOSITORY = "https://github.com/pathscale/agencyzero";

/** A visible source link and a quiet, explicit star invitation—never a modal. */
function SourceActions(): JSX.Element {
  const { actions } = useWorkspace();
  const openRepository = () => void actions.openExternal(AGENCYZERO_REPOSITORY);
  return (
    <div class="flex items-center gap-2">
      <button
        type="button"
        onClick={openRepository}
        class="rounded-lg border border-az-hairline-strong px-2.5 py-1 text-[11.5px] text-az-muted transition-colors hover:border-primary hover:text-primary"
      >
        {tx("View source")}
      </button>
      <button
        type="button"
        onClick={openRepository}
        class="rounded-lg bg-primary px-2.5 py-1 text-[11.5px] text-primary-content transition-opacity hover:opacity-90"
      >
        {tx("Star on GitHub")}
      </button>
    </div>
  );
}

/**
 * The whole update story in one row: what the boot check found, a manual
 * re-check, and the install button. "Up to date" is only ever said after an
 * *explicit* check succeeds — the passive boot check's failure and a current
 * install look identical in state, and claiming freshness on a check that
 * never reached the CDN is the lie the backend was built to avoid.
 */
function UpdateControl(): JSX.Element {
  const { state, actions, isLive } = useWorkspace();
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);

  const check = (): void => {
    setBusy(true);
    setNote(null);
    void actions
      .checkForUpdate()
      .then((found) => setNote(found ? null : tx("up to date")))
      .catch((cause) => setNote(describeError(cause)))
      .finally(() => setBusy(false));
  };

  // Optimistic and stays that way on success: the process is replaced
  // mid-await, same as Restart. Failure (a live run, a download error)
  // lands in the note.
  const install = (): void => {
    setBusy(true);
    setNote(tx("downloading…"));
    void actions.installUpdate().catch((cause) => {
      setNote(describeError(cause));
      setBusy(false);
    });
  };

  return (
    <div class="flex items-center gap-2">
      <Show when={note()}>
        {(text) => <span class="max-w-[220px] truncate text-[11.5px] text-az-muted">{text()}</span>}
      </Show>
      <Show
        when={state.availableUpdate}
        fallback={
          <button
            type="button"
            onClick={check}
            disabled={busy() || !isLive("checkForUpdate")}
            class="shrink-0 rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
          >
            {busy() ? tx("Checking…") : tx("Check for update")}
          </button>
        }
      >
        {(update) => (
          <>
            <span class="shrink-0 font-mono text-[11.5px] text-primary">
              {update().version} {tx("available")}
            </span>
            <button
              type="button"
              onClick={install}
              disabled={busy() || !isLive("installUpdate")}
              class="shrink-0 rounded-lg border border-primary/50 px-3 py-[5px] font-semibold text-[12px] text-primary transition-colors hover:border-primary hover:bg-primary/10 disabled:opacity-40"
            >
              {busy() ? tx("Installing…") : tx("Install & Restart")}
            </button>
          </>
        )}
      </Show>
    </div>
  );
}

function RelaunchButton(): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [busy, setBusy] = createSignal(false);

  return (
    <button
      type="button"
      disabled={busy() || !isLive("relaunchApp")}
      onClick={() => {
        setBusy(true);
        void actions.relaunchApp().catch(() => setBusy(false));
      }}
      class="shrink-0 rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-warning hover:text-warning disabled:opacity-40"
    >
      {busy() ? tx("Restarting…") : tx("Restart")}
    </button>
  );
}

/**
 * Global spend, from the usage ledger — the durable record, not this window.
 *
 * Every run that reported a cost wrote a ledger row, so these figures span
 * every session and survive project deletion. Priced by the agent itself at
 * API list rates: on a subscription plan this measures consumption rather
 * than a bill, which is exactly what makes it comparable week to week.
 */
function CostSection(): JSX.Element {
  const { state, actions } = useWorkspace();
  const [summary, setSummary] = createSignal<CostSummary | null>(null);
  const [warningPreview, setWarningPreview] = createSignal<number | null>(null);
  const warningUsd = () => warningPreview() ?? state.settings?.costWarningUsd ?? 0.75;

  // Asked once per visit: the ledger only grows when a run finishes, and
  // Settings is not a screen left open while runs happen.
  onMount(() => {
    void actions
      .getCostSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  });

  const dollars = (value: number | undefined): string =>
    typeof value === "number" ? `$${value.toFixed(2)}` : "—";
  const figure = (value: number | undefined): JSX.Element => (
    <span class="font-mono text-[12.5px] text-az-strong">{dollars(value)}</span>
  );

  /*
   * When each window turns over, and how long that is from now.
   *
   * A figure labelled "Today" raises the question immediately: today by whose
   * clock, and how much of it is left. The ledger records UTC days, so these
   * reset at UTC midnight. The countdown is worth more than the time:
   * "$4.10 today" reads very differently at 23:50 than at 00:10.
   *
   * On the app's coarse clock, so these tick without a timer of their own.
   */
  const now = useNow();
  const nextMidnight = (from: number): Date => {
    const at = new Date(from);
    at.setUTCHours(24, 0, 0, 0);
    return at;
  };
  const nextMonth = (from: number): Date => {
    const at = new Date(from);
    at.setUTCHours(0, 0, 0, 0);
    at.setUTCDate(1);
    at.setUTCMonth(at.getUTCMonth() + 1);
    return at;
  };
  const untilMidnight = () => countdown(nextMidnight(now()).toISOString(), now());
  const untilMonth = () => countdown(nextMonth(now()).toISOString(), now());
  const monthLabel = () =>
    nextMonth(now()).toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });

  return (
    <Section
      icon="gauge"
      title={tx("Cost")}
      hint={tx("all sessions · summed from the usage ledger")}
    >
      <Row
        label={tx("Today")}
        hint={tx("resets at midnight UTC · in {time}", { time: untilMidnight() })}
      >
        {figure(summary()?.todayUsd)}
      </Row>
      {/*
       * No countdown on the week, because there is nothing to count down to.
       * It is a trailing window rather than a period that resets, and a timer
       * beside it would promise a reset that never comes. What happens at
       * midnight is that the oldest of the seven days falls off the back.
       */}
      <Row
        label={tx("This week")}
        hint={tx(
          "the trailing seven days, so a Monday reset cannot hide Sunday · the oldest day drops at midnight",
        )}
      >
        {figure(summary()?.weekUsd)}
      </Row>
      <Row
        label={tx("This month")}
        hint={tx("resets {date} · in {time}", { date: monthLabel(), time: untilMonth() })}
      >
        {figure(summary()?.monthUsd)}
      </Row>
      <Row
        label={tx("All time")}
        hint={tx(
          "{count} priced turn(s) · priced by the agent at API list rates — consumption, not a bill",
          { count: summary()?.turns ?? 0 },
        )}
      >
        {figure(summary()?.totalUsd)}
      </Row>
      <Row
        label={tx("Turn warning threshold")}
        hint={tx("warn when the projected cost of one turn reaches this amount")}
      >
        <div class="flex min-w-[260px] items-center gap-3">
          <input
            type="range"
            min="0.25"
            max="20"
            step="0.25"
            value={warningUsd()}
            aria-label={tx("Projected turn warning threshold")}
            onInput={(event) => setWarningPreview(Number(event.currentTarget.value))}
            onChange={(event) => {
              const costWarningUsd = Number(event.currentTarget.value);
              void actions.saveSettings({ costWarningUsd }).finally(() => setWarningPreview(null));
            }}
            class="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary"
          />
          <output class="w-14 shrink-0 text-right font-mono text-[12.5px] text-az-strong">
            ${warningUsd().toFixed(2)}
          </output>
        </div>
      </Row>
      <Row
        label={tx("Cost warnings")}
        hint={tx("turn off the large projected-cost warning; estimates and Compact remain visible")}
        isLast
      >
        <SettingToggle
          label={tx("Show projected-cost warnings")}
          checked={!prefs.costWarningsDisabled}
          onChange={(enabled) => setPrefs("costWarningsDisabled", !enabled)}
        />
      </Row>
    </Section>
  );
}

function Section(props: {
  icon: IconProps["name"];
  title: string;
  hint: string;
  /**
   * What this section still needs before its controls do anything.
   *
   * Present means not wired: the whole body renders disabled and says why. A
   * setting that saves correctly but that nothing reads is not finished, and
   * leaving it interactive invites someone to configure a moderator that will
   * never run.
   */
  pending?: string;
  children: JSX.Element;
}): JSX.Element {
  /*
   * Hidden with a class, never unmounted. An unmounted section takes its rows
   * with it, the rows stop reporting whether they match, and the section can
   * then never learn that a later query does match one of them.
   */
  const [hits, setHits] = createSignal(new Set<string>());
  const titleMatches = createMemo(() => matchesSearch(`${props.title} ${props.hint}`));
  const visible = () => settingsQuery().trim() === "" || titleMatches() || hits().size > 0;
  const report = (label: string, hit: boolean): void => {
    setHits((prev) => {
      const next = new Set(prev);
      if (hit) next.add(label);
      else next.delete(label);
      return next;
    });
  };

  return (
    <SearchScope.Provider value={{ titleMatches, report }}>
      <Panel class="flex-none rounded-[13px]" classList={{ hidden: !visible() }}>
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-3.5 pt-3 pb-2.5">
          <Icon name={props.icon} class="relative top-0.5 text-[14px] text-primary" />
          <h2
            class="font-semibold text-[13px]"
            classList={{ "text-az-title": !props.pending, "text-az-muted": !!props.pending }}
          >
            {props.title}
          </h2>
          <span class="text-[11.5px] text-az-muted">{props.hint}</span>
          <Show when={props.pending}>
            {(reason) => (
              <span class="ml-auto shrink-0 rounded border border-az-hairline px-1.5 py-px text-[10px] text-az-muted">
                {tx("not wired ·")} {reason()}
              </span>
            )}
          </Show>
        </div>
        {/*
        `inert` rather than a disabled prop on every control: it takes the whole
        subtree out of the tab order and out of pointer events in one place, so
        a control added later cannot be accidentally live.
      */}
        <div
          // @ts-expect-error inert is valid HTML but not yet in Solid's JSX types
          inert={props.pending ? "" : undefined}
          classList={{ "pointer-events-none opacity-45": !!props.pending }}
        >
          {props.children}
        </div>
      </Panel>
    </SearchScope.Provider>
  );
}

function Row(props: {
  label: string;
  hint?: string;
  isLast?: boolean;
  /**
   * Stack the control under the label instead of beside it. A wide control
   * (a full-width textarea) beside a `flex-1` label squeezes the label to
   * min-content, which wraps it one word per line; those rows stack instead.
   */
  stack?: boolean;
  children: JSX.Element;
}): JSX.Element {
  const scope = useContext(SearchScope);
  const hit = createMemo(() => matchesSearch(`${props.label} ${props.hint ?? ""}`));
  // Reported rather than read: only the row knows its own words, and the
  // section needs to know whether any of them answered the search.
  createEffect(() => scope?.report(props.label, hit()));
  onCleanup(() => scope?.report(props.label, false));
  // A section named by the query shows all of its rows: someone searching
  // "cost" wants the section, not the one row whose label repeats the word.
  const visible = () => settingsQuery().trim() === "" || scope?.titleMatches() === true || hit();

  return (
    <div
      classList={{ hidden: !visible() }}
      class={`px-3.5 py-2.5 ${props.isLast ? "" : "border-az-hairline-soft border-b"} ${
        props.stack ? "flex flex-col gap-2" : "flex items-center gap-3"
      }`}
    >
      <span class={`text-[12.5px] text-az-body ${props.stack ? "" : "min-w-0 flex-1"}`}>
        {props.label}
        <Show when={props.hint}>
          <span class="mt-0.5 block text-[11.5px] text-az-muted">{props.hint}</span>
        </Show>
      </span>
      {props.children}
    </div>
  );
}

function SettingToggle(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <Toggle
      aria-label={props.label}
      checked={props.checked}
      disabled={props.disabled}
      color="accent"
      class="shrink-0"
      onChange={(event) => props.onChange(event.currentTarget.checked)}
    />
  );
}

function AgentRow(props: { status: AgentStatus }): JSX.Element {
  const detail = () => {
    if (props.status.state === "outdated") {
      return `${agentStateLabel("outdated")} · needs ${props.status.minVersion}+`;
    }
    return agentStateLabel(props.status.state);
  };

  return (
    <div class="flex items-center gap-3 border-az-hairline-soft border-b px-3.5 py-2.5">
      <AgentStateDot state={props.status.state} />
      <span class="w-[88px] shrink-0 font-semibold text-[12.5px] text-az-strong">
        {AGENT_LABELS[props.status.agent]}
      </span>
      <span class="shrink-0 font-mono text-[11.5px] text-az-muted">
        {props.status.version ?? "—"}
      </span>
      <span class={`min-w-0 flex-1 text-[11.5px] ${STATE_TONE[props.status.state]}`}>
        {detail()}
      </span>
      <span class="flex shrink-0 gap-[5px]">
        <For each={props.status.caps}>
          {(cap) => (
            <span class="rounded-full border border-primary/25 bg-primary/8 px-[7px] py-0.5 font-mono text-[10.5px] text-primary/85">
              {cap}
            </span>
          )}
        </For>
      </span>
    </div>
  );
}

function HoldRow(props: {
  severity: string;
  tone: "warning" | "error";
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <div
      class={`flex items-center gap-2.5 rounded-[11px] border p-[10px_12px] ${
        props.tone === "warning" ? "border-warning/24 bg-warning/8" : "border-error/24 bg-error/8"
      }`}
    >
      <span
        class={`shrink-0 rounded-md px-2 py-0.5 font-bold text-[11px] ${
          props.tone === "warning" ? "bg-warning/20 text-warning" : "bg-error/20 text-error"
        }`}
      >
        {props.severity}
      </span>
      <span class="flex-1 text-[12px] text-az-body leading-[1.5]">{props.description}</span>
      <SettingToggle
        label={`${props.severity} hold behaviour`}
        checked={props.checked}
        onChange={props.onChange}
      />
    </div>
  );
}

/**
 * One agent's catalogue, with its provenance stated rather than implied.
 *
 * The provenance line is not decoration: two of the three lists were not
 * obtained from the installed binary, and a picker that presents a documented
 * list and an interrogated one identically invites the user to trust both
 * equally.
 */
function AgentModelList(props: { catalogue: AgentModels; selection: ModelSelection }): JSX.Element {
  const agent = () => props.catalogue.agent;

  return (
    <div class="flex flex-col border-az-hairline border-b last:border-b-0">
      <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 px-3.5 pt-3 pb-1">
        <span class="font-semibold text-[13px] text-az-title">{AGENT_LABELS[agent()]}</span>
        <span class="text-[11.5px] text-az-muted">{tx(AGENT_USE[agent()])}</span>
        <span class="ml-auto text-[11px] text-az-muted tabular-nums">
          {props.selection.enabled.length} {tx("of")} {props.catalogue.models.length}
        </span>
      </div>
      <p class="px-3.5 pb-2 text-[11px] text-az-muted">
        {props.catalogue.discovered
          ? tx("asked just now")
          : tx(SOURCE_LABELS[props.catalogue.source])}{" "}
        {tx("· checked")} {props.catalogue.checked} {tx("against")} {props.catalogue.against}
      </p>
      <div class="az-scroll flex max-h-[236px] flex-col pb-1.5">
        <For each={props.catalogue.models}>
          {(model) => (
            <ModelRow
              model={model}
              agent={agent()}
              isEnabled={props.selection.enabled.includes(model.id)}
              isDefault={props.selection.default === model.id}
              /*
               * Emptying a picker would leave the prompt with nothing to send,
               * so the last remaining entry is not removable. Disabling the
               * control says so where a rejected click would just look broken.
               */
              isLastEnabled={
                props.selection.enabled.length === 1 && props.selection.enabled[0] === model.id
              }
            />
          )}
        </For>
      </div>
    </div>
  );
}

/**
 * One model: offer it or not, and optionally make it the preselected one.
 *
 * "Make default" is always mounted and revealed on hover or focus rather than
 * mounted on hover, for the same reason the tab close button is: mounting on
 * hover changes the row's width and shoves the rest of the list sideways.
 */
function ModelRow(props: {
  model: Model;
  agent: Agent;
  isEnabled: boolean;
  isDefault: boolean;
  isLastEnabled: boolean;
}): JSX.Element {
  const { actions } = useWorkspace();

  return (
    <div class="group flex items-center gap-2.5 px-3.5 py-[3px] transition-colors hover:bg-az-hover">
      {/*
        A real checkbox rather than a styled button: this is a set of choices,
        and screen readers should hear it as one. The input carries the state and
        the keyboard behaviour; the span beside it is the visible box.
      */}
      <label
        class="shrink-0 cursor-pointer"
        title={props.isLastEnabled ? tx("The last enabled model cannot be removed") : undefined}
      >
        <input
          type="checkbox"
          class="peer sr-only"
          checked={props.isEnabled}
          disabled={props.isLastEnabled}
          aria-label={tx("Offer {name}", { name: props.model.name })}
          onChange={(event) =>
            void actions.toggleModel(props.agent, props.model.id, event.currentTarget.checked)
          }
        />
        <span
          aria-hidden="true"
          class="flex size-[15px] items-center justify-center rounded border transition-colors peer-focus-visible:ring-1 peer-focus-visible:ring-primary peer-disabled:opacity-40"
          classList={{
            "border-primary bg-primary text-az-sunken": props.isEnabled,
            "border-az-hairline-strong": !props.isEnabled,
          }}
        >
          <Show when={props.isEnabled}>
            <Icon name="check" class="size-2.5" />
          </Show>
        </span>
      </label>

      <div class="flex min-w-0 flex-1 flex-col leading-tight">
        <span class="flex items-baseline gap-1.5">
          <span class="truncate text-[12.5px] text-az-body">{props.model.name}</span>
          <span class="truncate font-mono text-[10.5px] text-az-muted">{props.model.id}</span>
          <Show when={props.model.kind === "alias"}>
            <span class="shrink-0 rounded border border-az-hairline px-1 text-[9.5px] text-az-muted uppercase tracking-[.04em]">
              {tx("alias")}
            </span>
          </Show>
        </span>
        <Show when={props.model.note}>
          <span class="truncate text-[11px] text-az-muted">{props.model.note}</span>
        </Show>
      </div>

      <Show
        when={!props.isDefault}
        fallback={
          <span class="shrink-0 rounded border border-primary px-1.5 py-px text-[10px] text-primary">
            {tx("default")}
          </span>
        }
      >
        <button
          type="button"
          onClick={() => void actions.setDefaultModel(props.agent, props.model.id)}
          aria-label={tx("Make {name} the default", { name: props.model.name })}
          class="shrink-0 rounded border border-az-hairline-strong px-1.5 py-px text-[10px] text-az-muted opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
        >
          {tx("make default")}
        </button>
      </Show>
    </div>
  );
}
