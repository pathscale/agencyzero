import {
  applyGlassTokens,
  Checkbox,
  Flex,
  GLASS_DEFAULTS,
  GLASS_LIMITS,
  type GlassMode,
  type GlassTuning,
  Input,
  Select,
  Slider,
  Switch,
  Textarea,
} from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  onCleanup,
  onSettled,
  Show,
  useContext,
} from "solid-js";
import { Button } from "~/components/Button";
import { Icon, type IconProps } from "~/components/Icon";
import { LanguageSwitcher } from "~/components/LanguageSwitcher";
import { Panel } from "~/components/Panel";
import { PillMenu } from "~/components/PillMenu";
import { AgentStateDot } from "~/components/StatusDot";
import { countdown, formatBytes, relativeTime } from "~/lib/format";
import { AGENT_LABELS, agentStateLabel, envPolicyLabel, permissionLabel } from "~/lib/labels";
import { whileMounted } from "~/lib/live";
import { describeError, log } from "~/lib/log";
import { reset as perfReset, snapshot as perfSnapshot } from "~/lib/perf";
import {
  DEFAULT_GLASS_OPACITY,
  DEFAULT_GLASS_SCRIM,
  DEFAULT_WASH,
  MAX_GLASS_BLUR,
  normalizeWash,
  writePanelAxes,
} from "~/lib/theme";
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
  ThemeSettings,
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
let searchRevealFrame: number | undefined;

createRoot(() => {
  createEffect(
    // Tracked: the query being typed.
    () => settingsQuery(),
    // Untracked: revealing sections writes state, which would re-arm the
    // computation on its own write if it ran in the compute.
    (query) => {
      if (searchRevealFrame !== undefined) {
        cancelAnimationFrame(searchRevealFrame);
        searchRevealFrame = undefined;
      }
      if (query.trim() !== "") revealSearchSections();
    },
  );
});

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
/*
 * Defaulted to `null`, because a row outside a section is a supported shape.
 *
 * Every consumer reads this as `scope?.…`, so a `Row` rendered without a
 * `Section` around it has always been allowed. Solid 2 made that throw:
 * `getContext` raises `ContextNotFoundError` when the resolved value is
 * `undefined`, and it throws before the optional chain can run.
 *
 * The cost was not a bad row. The throw escaped a mount effect, halted the
 * reactive system, and left `boot.status` on "loading" forever, so every
 * `waitFor` on ready polled until the process died. That was the settings
 * suite's out-of-memory abort.
 */
const SearchScope = createContext<{
  titleMatches: () => boolean;
  report: (label: string, hit: boolean) => void;
} | null>(null);

/**
 * Global settings, opened by the gear as a real tab you can leave open.
 *
 * Real controls only — detected agent status, the defaults a new tab starts
 * from, the moderator, notifications, and what the agent process inherits from
 * this machine. Changes save as you make them; there is no Save button because
 * there is nothing to batch.
 */
export function SettingsTab(): JSX.Element {
  beginSettingsMount();
  const { state, actions, isLive, effortsFor, permissionsFor } = useWorkspace();
  const settings = () => state.settings;
  /**
   * Whether there are settings at all, as a boolean.
   *
   * `Show` re-mounts its children whenever `when` changes identity, and every
   * settings write replaces the record, so gating on the object itself rebuilt
   * the entire pane on every pick. A boolean flips once.
   */
  const hasSettings = () => Boolean(state.settings);
  /** The record, non-null inside the `Show` above. */
  const current = () => state.settings as NonNullable<typeof state.settings>;
  const [proxyAction, setProxyAction] = createSignal<
    "refresh" | "drain" | "terminate" | "stop" | null
  >(null);
  const [proxyNote, setProxyNote] = createSignal("");
  const [proxyRefreshGeneration, setProxyRefreshGeneration] = createSignal(0);
  const [agentCheckGeneration, setAgentCheckGeneration] = createSignal(0);
  const [modelRefreshGeneration, setModelRefreshGeneration] = createSignal(0);
  const [modelRefreshError, setModelRefreshError] = createSignal("");
  const [agentCheckError, setAgentCheckError] = createSignal("");
  const alive = whileMounted();
  const [terminateArmed, setTerminateArmed] = createSignal(false);
  const [blitzControlPending, setBlitzControlPending] = createSignal(false);
  const [blitzControlError, setBlitzControlError] = createSignal("");
  const [pendingBlitzControl, setPendingBlitzControl] = createSignal<boolean | null>(null);
  const displayedBlitzControl = () =>
    pendingBlitzControl() ?? settings()?.blitzControlEnabled ?? false;
  /*
   * Deep profiling gets the same optimistic overlay as inspection above.
   *
   * Without it the switch rendered `settings()` directly, which does not change
   * until `saveSettings` resolves and the store round trip lands. The click
   * therefore left the toggle sitting in its old position for the whole write
   * and then jumped — and because the control is disabled while pending, a
   * second click in that window was swallowed rather than queued. That reads as
   * a switch that flickers and cannot be turned on.
   */
  const [pendingDeepProfiling, setPendingDeepProfiling] = createSignal<boolean | null>(null);
  const displayedDeepProfiling = () =>
    pendingDeepProfiling() ?? settings()?.blitzDeepProfilingEnabled ?? false;

  const refreshProxy = (): void => {
    setProxyAction("refresh");
    setProxyNote("");
    void actions
      .refreshAgentProxy()
      .then(alive(() => setProxyRefreshGeneration((generation) => generation + 1)))
      .catch(alive((cause) => setProxyNote(describeError(cause))))
      .finally(alive(() => setProxyAction(null)));
  };

  const recheckAgents = (): void => {
    setAgentCheckError("");
    void actions
      .recheckAgents()
      .then(alive(() => setAgentCheckGeneration((generation) => generation + 1)))
      .catch(alive((cause) => setAgentCheckError(describeError(cause))));
  };

  const refreshModels = (): void => {
    setModelRefreshError("");
    void actions
      .refreshModels()
      .then(alive(() => setModelRefreshGeneration((generation) => generation + 1)))
      .catch(alive((cause) => setModelRefreshError(describeError(cause))));
  };

  // Settings needs one current snapshot when it opens. Later changes arrive
  // from run lifecycle events or the explicit Refresh button, without a timer
  // that repeatedly wakes or respawns an otherwise idle sidecar.
  onSettled(refreshProxy);

  const restartProxy = (mode: "drain" | "terminate"): void => {
    const active = state.agencyProxy?.activeRuns ?? 0;
    const wasConnected = state.agencyProxy?.connected ?? false;
    setProxyAction(mode);
    setTerminateArmed(false);
    setProxyNote(
      mode === "drain" && active > 0
        ? active === 1
          ? tx("Waiting for 1 live run to finish")
          : tx("Waiting for {count} live runs to finish", { count: active })
        : mode === "terminate"
          ? tx("Terminating live runs before restart")
          : "",
    );
    void actions
      .restartAgentProxy(mode)
      .then(
        alive(() =>
          setProxyNote(wasConnected ? tx("AgencyProxy restarted") : tx("AgencyProxy started")),
        ),
      )
      .catch(alive((cause) => setProxyNote(describeError(cause))))
      .finally(alive(() => setProxyAction(null)));
  };

  const stopProxy = (): void => {
    const active = state.agencyProxy?.activeRuns ?? 0;
    setProxyAction("stop");
    setProxyNote(
      active === 1
        ? tx("Waiting for 1 live run to finish")
        : active > 1
          ? tx("Waiting for {count} live runs to finish", { count: active })
          : "",
    );
    void actions
      .stopAgentProxy()
      .then(alive(() => setProxyNote(tx("AgencyProxy stopped"))))
      .catch(alive((cause) => setProxyNote(describeError(cause))))
      .finally(alive(() => setProxyAction(null)));
  };

  const setBlitzControl = (enabled: boolean): void => {
    // Reflect the category boundary before the async persistence round trip.
    // In particular, deep profiling must never remain visibly active under an
    // inspection toggle that the owner has already turned off.
    setPendingBlitzControl(enabled);
    setBlitzControlPending(true);
    setBlitzControlError("");
    // Only inspection. Deep profiling is its own runtime switch and keeps
    // whatever it was set to: clearing it here meant turning inspection off and
    // back on silently dropped a preference the owner had chosen, with nothing
    // on screen saying it had gone.
    void actions
      .saveSettings({ blitzControlEnabled: enabled })
      .catch(alive((cause) => setBlitzControlError(describeError(cause))))
      .finally(
        alive(() => {
          setPendingBlitzControl(null);
          setBlitzControlPending(false);
        }),
      );
  };

  const setBlitzDeepProfiling = (enabled: boolean): void => {
    setPendingDeepProfiling(enabled);
    setBlitzControlPending(true);
    setBlitzControlError("");
    void actions
      .saveSettings({ blitzDeepProfilingEnabled: enabled })
      .catch(alive((cause) => setBlitzControlError(describeError(cause))))
      .finally(
        alive(() => {
          setPendingDeepProfiling(null);
          setBlitzControlPending(false);
        }),
      );
  };

  // These settings persist, but no production consumer reads them yet. Keep
  // their future configuration visible and explicitly inert rather than
  // claiming success when only the database changed.
  const moderatorPending = (): string => "moderator run is not implemented";
  const notificationPending = (): string => "desktop notifications are not implemented";
  const environmentPending = (): string => "agent environment policy is not applied yet";

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

  /** Every selected provider model is eligible to watch a run. */
  const moderatorModels = () =>
    (["claude", "codex", "copilot"] as const).flatMap((agent) =>
      enabledModels(agent).map((model) => ({
        value: `${agent}:${model.id}`,
        label: `${AGENT_LABELS[agent]} · ${model.name}`,
      })),
    );
  const moderatorModelLabel = () =>
    moderatorModels().find((model) => model.value === state.settings?.moderator.model)?.label ??
    state.settings?.moderator.model ??
    "";
  const moveModeratorModel = (offset: number): void => {
    const models = moderatorModels();
    const currentIndex = models.findIndex(
      (model) => model.value === state.settings?.moderator.model,
    );
    const next = models[Math.max(0, Math.min(models.length - 1, currentIndex + offset))];
    if (next && next.value !== state.settings?.moderator.model) {
      void actions.saveSettings({ moderator: { model: next.value } });
    }
  };

  /*
   * Opening Settings puts focus on the page itself, so Page Up and Page Down
   * work immediately.
   *
   * Keyboard scrolling targets the focused node's scroll container, and nothing
   * here was focusable: the page could only be moved by pointing at it first,
   * which is not a keyboard path at all. `tabindex="-1"` makes it focusable
   * programmatically without adding a stop to the tab order.
   */
  let page!: HTMLDivElement;
  onSettled(() => page.focus({ preventScroll: true }));

  const setInterfaceSize = (
    value: "normal" | "large" | "extra-large",
    anchor: HTMLButtonElement,
  ) => {
    const top = anchor.getBoundingClientRect().top;
    setPrefs((draft) => {
      draft.uiSize = value;
    });
    requestAnimationFrame(() => {
      if (!anchor.isConnected) return;
      page.scrollTop += anchor.getBoundingClientRect().top - top;
    });
  };

  return (
    <div
      ref={page}
      tabindex="-1"
      // `items-start` is load-bearing. This is a row flex container that also
      // scrolls, so its single child is a flex *item* and the cross axis is the
      // height: the default `align-items: stretch` sizes that child to the
      // scroller's own box rather than to its content. Measured on a blank
      // pane: the 720px column reported 830px tall while holding 7,764px of
      // sections, so the scroll offset ran against content the layout had never
      // given height to, and a scroll parked an 830px stub thousands of pixels
      // off screen at 80fps with 13/13 layers and every metric healthy.
      class="az-scroll flex min-w-0 flex-1 items-start justify-center rounded-panel border border-az-hairline bg-az-sunken focus:outline-none"
    >
      {/*
        `gap-10` (40px) rather than the 12px this used to be, and the number is
        load-bearing rather than taste.

        These sections are glass. `backdrop-filter` cannot read a scene that
        has not been rasterised, so the renderer cuts the frame into segments,
        and each segment costs a full-frame render, a full-frame copy into
        vello's atlas, a blur and a full-frame draw. Two panels share one
        segment only when neither one's blur can read a pixel the other
        painted, and a gaussian reaches three sigma.

        At sigma 12 that reach is 36px. A 12px gap put every panel in its own
        segment: `blitz-tests --test glass_pass_count` prints seven render
        passes here against two for panels spaced past the reach, and the
        threshold is exact, 36px fails and 37px batches. Measured on the
        running app the renderer stage was 119-181ms of a frame against 1.7ms
        of layout, which is a window repainting twice a second and reading as
        blank.

        40px clears 36 with room for the blur to be retuned a little without
        silently falling back to seven passes.
      */}
      <div class="flex w-full max-w-[720px] flex-col gap-10 px-6 pt-5.5 pb-7">
        <div class="flex items-baseline gap-2.5 pb-0.5">
          <h1 class="font-semibold text-az-title text-ui-heading tracking-[-.01em]">
            {tx("Settings")}
          </h1>
          <span class="text-az-muted text-ui-detail">
            {tx("defaults for every new tab · each project can override")}
          </span>
        </div>

        {/*
          Eleven sections and something over sixty rows, which is past the
          point where reading them all is how you find one.
        */}
        <div class="flex items-center gap-2.5 rounded-[11px] border border-primary/11 bg-az-inset px-3 py-2.5 focus-within:border-primary/40">
          <Icon name="search" class="shrink-0 text-primary/70 text-ui-control" />
          <Input.Field
            id="settings-search"
            type="search"
            value={settingsQuery()}
            onInput={(event) => setSettingsQuery(event.currentTarget.value)}
            placeholder={tx("Search settings…")}
            aria-label={tx("Search settings")}
            class="min-w-0 flex-1 bg-transparent text-base-content text-ui-label-lg placeholder:text-az-muted focus:outline-none"
          />
        </div>

        <div class="flex items-center justify-between gap-4 rounded-[11px] border border-az-hairline bg-base-100 px-3.5 py-3">
          <div class="min-w-0">
            <div class="font-medium text-az-strong text-ui-label-lg">{t("language.label")}</div>
            <div class="mt-0.5 text-az-muted text-ui-caption">{t("language.hint")}</div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <LanguageSwitcher id="settings-language" align="end" />
            <Button
              id="settings-welcome-tutorial"
              type="button"
              data-guide-target="help-setup"
              onClick={() => actions.openOnboarding()}
              class="rounded-lg border border-az-hairline-strong px-2.5 py-1.5 text-az-body text-ui-detail transition-colors hover:border-primary hover:text-primary"
            >
              {tx("Welcome Tutorial")}
            </Button>
          </div>
        </div>

        {/*
          Gate on *whether* there are settings, not on the object itself.

          Every settings write replaces `state.settings` with a fresh object, so
          `when={settings()}` handed `Show` a new truthy value each time and it
          tore the whole pane down and built it again. Measured through the
          renderer: a pick added 28 nodes and 7 more accent swatches that were
          never reclaimed, 266 of them after a session's worth of clicks, all
          but seven invisible.

          The visible consequence is the one reported: picking a colour re-mounts
          the row under the pointer, so the click lands on a node that no longer
          exists, no swatch ever shows as selected, and the swatch you can see
          belongs to a different generation from the token that was written -
          "lime selected, icon is purple".

          `when={hasSettings()}` is a boolean, so it flips once and the pane
          updates in place afterwards like every other reactive read here.
        */}
        <Show when={hasSettings()}>
          {/*
                `flex-none` for the same reason every Section carries it. This
                is a flex item in the settings column, and `overflow-hidden`
                zeroes an item's automatic minimum size, so this was the one
                panel here allowed to shrink — and in an over-constrained
                column it absorbed all of the shrink. Measured in the running
                app: a 2px box (its two borders) around 163px of content, with
                the toggle clipped away. Reachable by search, which does not
                depend on the box, and by nothing else.
              */}
          {/*
                `az-glass` beside `az-panel`, as every other panel in the app
                has. Without it this one kept `az-panel`'s opaque fill and was
                the only container in Settings that was not glass, which read as
                the effect being broken rather than as a deliberate surface.
              */}
          <div class="az-panel az-glass flex-none overflow-hidden rounded-panel border border-az-hairline">
            <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-3.5 pt-3 pb-2.5">
              <Icon name="gauge" class="relative top-0.5 text-primary text-ui-control" />
              <h2 class="font-semibold text-az-title text-ui-body">{tx("Diagnostics")}</h2>
              <span class="text-az-muted text-ui-detail">
                {tx("local inspection and bounded performance traces")}
              </span>
            </div>
            <Row
              label={tx("Inspection and agent control")}
              hint={tx("off by default; off removes the MCP socket and discovery descriptor")}
            >
              <div class="flex flex-col items-end gap-1">
                {/*
                      Not disabled while the write is in flight.

                      `displayedBlitzControl` already shows the requested state
                      optimistically, so the switch has moved before the store
                      answers. Disabling it on top of that made the control
                      inert for the length of the round trip and swallowed a
                      second click rather than queueing it — a toggle that
                      sometimes ignores you, which is exactly how these have
                      always behaved. The deep profiling switch below had the
                      same flag and lost it for the same reason.
                    */}
                <SettingToggle
                  id="settings-inspection-control"
                  label={tx("Enable inspection and agent control")}
                  checked={displayedBlitzControl()}
                  onChange={setBlitzControl}
                />
                <span
                  role={blitzControlError() ? "alert" : "status"}
                  class={`max-w-[260px] text-right text-ui-caption-sm ${
                    blitzControlError()
                      ? "text-error"
                      : displayedBlitzControl()
                        ? "text-success"
                        : "text-az-muted"
                  }`}
                >
                  {blitzControlError() ||
                    (blitzControlPending()
                      ? tx("Applying local control…")
                      : current().blitzControlEnabled
                        ? tx("Listening on local MCP socket")
                        : tx("Inspection and control disabled"))}
                </span>
              </div>
            </Row>
            <Row
              label={tx("Deep intrusive profiling")}
              hint={tx(
                "performance-affecting engine timings and counters; enable only while capturing a trace",
              )}
              isLast
            >
              <div class="flex flex-col items-end gap-1">
                {/*
                      Not gated on inspection. This is a runtime switch of its
                      own: the collectors feed the frame log and phase timings,
                      which need no socket, and gating it here left a control
                      that looked available, did nothing, and then lost its
                      value when inspection was toggled.
                    */}
                {/*
                      Permission, not activation, and the wording has to say so.
                      The switch used to start collection outright, so a profile
                      enabled once sampled from boot for a reader that was not
                      there: the consumers are the inspector and blitz-bench,
                      and both are separate processes. Sampling now runs only
                      while one of them is attached, and "active" would claim
                      something this control no longer does on its own.
                    */}
                <SettingToggle
                  id="settings-deep-profiling"
                  label={tx("Allow deep intrusive profiling")}
                  checked={displayedDeepProfiling()}
                  onChange={setBlitzDeepProfiling}
                />
                <span class="max-w-[260px] text-right text-az-muted text-ui-caption-sm">
                  {displayedDeepProfiling()
                    ? tx("Allowed. Samples only while a profiler is attached")
                    : tx("No deep samples collected")}
                </span>
              </div>
            </Row>
          </div>

          <Section
            id="settings-section-proxy"
            icon="gauge"
            title={tx("AgencyProxy")}
            hint={tx("owns live agent sessions across AgencyZero restarts")}
          >
            <Row
              label={tx("Sidecar status")}
              hint={
                state.agencyProxy?.detail ??
                state.agencyProxy?.socket ??
                tx("checking the local endpoint")
              }
              stack
            >
              <div class="flex flex-wrap items-center justify-end gap-2">
                <span
                  class={`size-2 rounded-full ${state.agencyProxy?.connected ? "bg-success" : "bg-error"}`}
                />
                <span class="text-az-body text-ui-detail">
                  {state.agencyProxy?.connected ? tx("Connected") : tx("Unavailable")}
                </span>
                <span class="text-az-muted text-ui-caption">
                  {state.agencyProxy
                    ? `${state.agencyProxy.activeRuns} ${tx(
                        state.agencyProxy.activeRuns === 1 ? "live run" : "live runs",
                      )}`
                    : tx("loading")}
                </span>
              </div>
            </Row>
            <Row
              label={tx("Executable")}
              hint={tx("a selection takes effect when you restart the idle sidecar")}
              stack
            >
              <div class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 flex-1 truncate font-mono text-az-muted text-ui-detail">
                  {current().agentProxyBinary || tx("Bundled AgencyProxy")}
                </span>
                <Button
                  id="settings-proxy-choose-binary"
                  type="button"
                  disabled={!isLive("chooseAgentProxyBinary")}
                  onClick={() => void actions.chooseAgentProxyBinary()}
                  class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-body text-ui-label transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {tx("Choose…")}
                </Button>
                <Button
                  id="settings-proxy-use-bundled"
                  type="button"
                  aria-label={tx("Use bundled AgencyProxy")}
                  disabled={!current().agentProxyBinary}
                  onClick={() => void actions.saveSettings({ agentProxyBinary: "" })}
                  class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-muted text-ui-label transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {tx("Use bundled")}
                </Button>
              </div>
            </Row>
            <div class="flex flex-wrap items-center justify-end gap-2 px-3.5 py-2.5">
              <span
                role="status"
                aria-label={tx("AgencyProxy refresh generation {count}", {
                  count: proxyRefreshGeneration(),
                })}
                class="sr-only"
              >
                {tx("AgencyProxy refresh generation {count}", {
                  count: proxyRefreshGeneration(),
                })}
              </span>
              <Show when={proxyNote()}>
                <span class="mr-auto text-az-muted text-ui-caption">{proxyNote()}</span>
              </Show>
              <Button
                id="settings-proxy-refresh"
                type="button"
                title={tx("Refresh AgencyProxy status")}
                aria-label={tx("Refresh AgencyProxy status")}
                disabled={proxyAction() !== null || !isLive("getAgentProxyStatus")}
                onClick={refreshProxy}
                class="flex size-8 items-center justify-center rounded-lg border border-az-hairline-strong text-az-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon
                  name="refresh-cw"
                  class={`text-ui-body ${proxyAction() === "refresh" ? "animate-spin" : ""}`}
                />
              </Button>
              <Button
                id="settings-proxy-restart"
                type="button"
                aria-label={
                  state.agencyProxy?.connected === false
                    ? tx("Start AgencyProxy")
                    : (state.agencyProxy?.activeRuns ?? 0) > 0
                      ? tx("Wait and restart AgencyProxy")
                      : tx("Restart AgencyProxy")
                }
                disabled={proxyAction() !== null || !isLive("restartAgentProxy")}
                onClick={() => restartProxy("drain")}
                class="rounded-lg border border-warning/40 px-3 py-[5px] text-ui-label text-warning transition-colors hover:border-warning hover:bg-warning/8 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {/*
                 * The spans on these three captions are load-bearing, not
                 * markup for its own sake.
                 *
                 * A reactive expression placed directly inside a Layout
                 * component updates once and then freezes: the compiler's
                 * `children` is a memo built on first read and owned by
                 * whichever effect reads it first, and that effect disposes
                 * it when it re-runs. These captions each have three
                 * states, so the second change is the one that silently
                 * does not happen and the button then lies about what it
                 * will do. A plain element in between keeps the memo from
                 * tracking the signal at all, so the text updates through
                 * the span's own effect. Section 8 of
                 * SOLID-LAYOUTS-ISSUES.md; remove once the memo is built
                 * under the component's own owner.
                 */}
                <span>
                  {proxyAction() === "drain"
                    ? tx("Waiting…")
                    : state.agencyProxy?.connected === false
                      ? tx("Start")
                      : (state.agencyProxy?.activeRuns ?? 0) > 0
                        ? tx("Wait & restart")
                        : tx("Restart")}
                </span>
              </Button>
              <Show when={state.agencyProxy?.connected && isLive("stopAgentProxy")}>
                <Button
                  id="settings-proxy-stop"
                  type="button"
                  aria-label={tx("Stop AgencyProxy")}
                  disabled={proxyAction() !== null}
                  onClick={stopProxy}
                  class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-muted text-ui-label transition-colors hover:border-error hover:text-error disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span>
                    {proxyAction() === "stop" && (state.agencyProxy?.activeRuns ?? 0) > 0
                      ? tx("Waiting…")
                      : proxyAction() === "stop"
                        ? tx("Stopping…")
                        : tx("Stop")}
                  </span>
                </Button>
              </Show>
              <Show when={(state.agencyProxy?.activeRuns ?? 0) > 0}>
                <Button
                  id="settings-proxy-terminate-restart"
                  type="button"
                  disabled={proxyAction() !== null || !isLive("restartAgentProxy")}
                  onClick={() =>
                    terminateArmed() ? restartProxy("terminate") : setTerminateArmed(true)
                  }
                  class="rounded-lg border border-error/40 px-3 py-[5px] text-error text-ui-label transition-colors hover:border-error hover:bg-error/8 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span>
                    {proxyAction() === "terminate"
                      ? tx("Terminating…")
                      : terminateArmed()
                        ? tx("Confirm terminate & restart")
                        : tx("Terminate & restart")}
                  </span>
                </Button>
              </Show>
            </div>
          </Section>

          <Section
            id="settings-section-agents"
            icon="shield"
            title={tx("Agents")}
            hint={tx("detected from the installed CLIs, not from configuration")}
          >
            <For each={state.agents}>{(agent) => <AgentRow status={agent} />}</For>
            <div class="flex items-center gap-2.5 px-3.5 pt-0 pb-3">
              <span
                role="status"
                aria-label={tx("Agent check generation {count}", {
                  count: agentCheckGeneration(),
                })}
                class="sr-only"
              >
                {tx("Agent check generation {count}", { count: agentCheckGeneration() })}
              </span>
              <Button
                id="settings-agents-recheck"
                type="button"
                onClick={recheckAgents}
                class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-body text-ui-label transition-colors hover:border-primary hover:text-primary"
              >
                {tx("Re-check")}
              </Button>
              <Show when={agentCheckError()}>
                {(message) => <span class="text-error text-ui-caption">{message()}</span>}
              </Show>
              <Show when={state.agents[0]}>
                {(first) => (
                  <span class="text-az-muted text-ui-detail">
                    {tx("last checked")} {relativeTime(first().checkedAt)}
                  </span>
                )}
              </Show>
            </div>
          </Section>

          <Section
            id="settings-section-agent-defaults"
            icon="sparkles"
            title={tx("Agent defaults")}
            hint={tx("what a new tab starts with")}
          >
            <Row label={tx("Agent")}>
              <PillMenu<Agent>
                id="settings-default-agent"
                label={tx("Default agent")}
                icon="sparkles"
                value={current().defaultAgent}
                options={state.agents
                  .filter((agent) => agent.agent === "claude" || agent.agent === "codex")
                  .map((agent) => ({ value: agent.agent, label: AGENT_LABELS[agent.agent] }))}
                onChange={selectDefaultAgent}
              />
              <Show when={modelRefreshError()}>
                {(error) => <span class="text-error text-ui-detail">{error()}</span>}
              </Show>
            </Row>
            <Row label={tx("Model")} hint={tx("chosen from what Models below has enabled")}>
              <PillMenu
                id="settings-default-model"
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
                id="settings-default-effort"
                label={tx("Default effort")}
                value={current().defaultEffort}
                options={effortOptions().map((effort) => ({ value: effort, label: effort }))}
                onChange={(defaultEffort) => void actions.saveSettings({ defaultEffort })}
              />
            </Row>
            <Row label={tx("Completed items")} hint={tx("what manual completion does to the row")}>
              <PillMenu
                id="settings-completed-items"
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
                id="settings-agent-finished-retention"
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
                id="settings-per-turn-injection"
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
              <Textarea
                id="settings-review-prompt"
                aria-label={tx("PR review prompt")}
                rows={3}
                value={current().review?.prompt ?? ""}
                placeholder={tx(
                  "Review this pull request for correctness bugs, security issues, and anything that would block merge. Be concrete: name the file and line, say what is wrong and why, and rank findings most severe first. If it is solid, say so briefly.",
                )}
                onChange={(event) =>
                  void actions.saveSettings({ review: { prompt: event.currentTarget.value } })
                }
                class="az-scroll w-full resize-none rounded-lg border border-az-hairline bg-base-300 px-2.5 py-2 text-az-body text-ui-label leading-[1.5] placeholder:text-az-faint focus:outline-none"
              />
            </Row>
            <Row
              label={tx("Permission posture")}
              hint={tx("read_only is the crate default; widen deliberately")}
              isLast
            >
              <PillMenu<Permission>
                id="settings-default-permission"
                label={tx("Default permission")}
                icon="lock"
                value={current().defaultPermission}
                options={permissionsFor(current().defaultAgent).map((permission) => ({
                  value: permission,
                  label: permissionLabel(permission),
                }))}
                onChange={(defaultPermission) => void actions.saveSettings({ defaultPermission })}
              />
            </Row>
          </Section>

          <Section
            id="settings-section-models"
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
              <Button
                id="settings-models-refresh"
                type="button"
                onClick={refreshModels}
                class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-body text-ui-label transition-colors hover:border-primary hover:text-primary"
              >
                {tx("Re-read from the CLIs")}
              </Button>
              <span
                role="status"
                aria-label={`Model refresh generation ${modelRefreshGeneration()}`}
                class="sr-only"
              />
              <span class="text-az-muted text-ui-detail">
                {tx("only Codex can enumerate; the other two stay on the compiled list")}
              </span>
            </div>
          </Section>

          <Section
            id="settings-section-task-manager"
            icon="list-checks"
            title={tx("Task Manager")}
            hint={tx("the Home conversation that keeps the lists in order")}
          >
            <Row label={tx("Agent")}>
              <PillMenu<Agent>
                id="settings-task-manager-agent"
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
                id="settings-task-manager-model"
                label={tx("Task manager model")}
                value={current().taskManager.model}
                options={enabledModels(current().taskManager.agent).map((model) => ({
                  value: model.id,
                  label: model.name,
                }))}
                isDisabled={enabledModels(current().taskManager.agent).length < 2}
                onChange={selectTaskManagerModel}
              />
            </Row>
            <Row label={tx("Effort")}>
              <PillMenu
                id="settings-task-manager-effort"
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
                id="settings-task-manager-permission"
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

          <Section
            id="settings-section-application"
            icon="settings"
            title={tx("Application")}
            hint={tx("the running instance")}
          >
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
                id="settings-update-checks-at-launch"
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
                id="settings-agent-restart-authority"
                label={tx("Agent restart authority")}
                value={current().agentRestartPolicy}
                options={[
                  { value: "disabled", label: tx("Disabled") },
                  { value: "restart", label: tx("Restart only") },
                  { value: "restart_and_update", label: tx("Restart & update") },
                ]}
                onChange={(agentRestartPolicy) => void actions.saveSettings({ agentRestartPolicy })}
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

          <Section
            id="settings-section-appearance"
            icon="sparkles"
            title={t("appearance.title")}
            hint={t("appearance.hint")}
            searchTerms={[t("appearance.resetButton")]}
          >
            <Row label={t("appearance.mode")} hint={t("appearance.modeHint")}>
              <div class="az-control-solid flex items-center gap-1 rounded-full border border-az-hairline bg-az-inset p-1">
                <For
                  each={[
                    { value: "dark" as const, label: t("appearance.dark") },
                    { value: "light" as const, label: t("appearance.light") },
                  ]}
                >
                  {(option) => (
                    <Button
                      id={`settings-theme-mode-${option.value}`}
                      type="button"
                      aria-pressed={prefs.colorMode === option.value ? "true" : "false"}
                      onClick={() =>
                        setPrefs((d) => {
                          d.colorMode = option.value;
                        })
                      }
                      class={`rounded-full px-3 py-1 font-semibold text-ui-caption transition-colors ${
                        prefs.colorMode === option.value
                          ? "bg-primary text-primary-content"
                          : "text-az-muted hover:bg-az-hover hover:text-az-title"
                      }`}
                    >
                      {option.label}
                    </Button>
                  )}
                </For>
              </div>
            </Row>
            <Row label={t("appearance.size")} hint={t("appearance.sizeHint")}>
              <div class="az-control-solid flex items-center gap-1 rounded-full border border-az-hairline bg-az-inset p-1">
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
                    <Button
                      id={`settings-theme-size-${option.value}`}
                      type="button"
                      aria-label={`${option.name} ${t("appearance.size")}`}
                      aria-pressed={prefs.uiSize === option.value ? "true" : "false"}
                      onClick={(event) => setInterfaceSize(option.value, event.currentTarget)}
                      class={`flex size-7 items-center justify-center rounded-full font-semibold text-ui-caption-sm transition-colors ${
                        prefs.uiSize === option.value
                          ? "bg-primary text-primary-content"
                          : "text-az-muted hover:bg-az-hover hover:text-az-title"
                      }`}
                    >
                      {option.label}
                    </Button>
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
              onAccentTwo={(accentTwo) => void actions.saveSettings({ theme: { accentTwo } })}
              onSoftness={(softness) => void actions.saveSettings({ theme: { softness } })}
              onWash={(wash) => void actions.saveSettings({ theme: { wash } })}
              onBrightness={(textBrightness) =>
                void actions.saveSettings({ theme: { textBrightness } })
              }
              isDefault={
                current().theme.surface === "" &&
                current().theme.accent === "" &&
                (current().theme.accentTwo ?? "") === "" &&
                current().theme.softness === 0 &&
                normalizeWash(current().theme.wash) === DEFAULT_WASH &&
                current().theme.textBrightness === 0 &&
                current().theme.glassEnabled !== false &&
                (current().theme.glassBlur ?? GLASS_DEFAULTS[prefs.colorMode].blur) ===
                  GLASS_DEFAULTS[prefs.colorMode].blur &&
                (current().theme.glassRefraction ?? GLASS_DEFAULTS[prefs.colorMode].refraction) ===
                  GLASS_DEFAULTS[prefs.colorMode].refraction &&
                (current().theme.glassDepth ?? GLASS_DEFAULTS[prefs.colorMode].depth) ===
                  GLASS_DEFAULTS[prefs.colorMode].depth &&
                (current().theme.glassOpacity ?? DEFAULT_GLASS_OPACITY) === DEFAULT_GLASS_OPACITY &&
                (current().theme.glassScrim ?? DEFAULT_GLASS_SCRIM) === DEFAULT_GLASS_SCRIM
              }
              /*
                    Reset means every axis on this pane, glass included.

                    It used to write five fields and leave the six glass ones
                    exactly where they were, so a window made unreadable by a
                    glass setting stayed unreadable however many times the
                    button was pressed. That is the opposite of what a control
                    called "reset to default" promises, and it is worst in the
                    case someone actually reaches for it.

                    `undefined` rather than a literal for each glass axis: the
                    stored value is optional and absent means "use the shipped
                    default", so clearing them restores whatever this build
                    ships rather than pinning today's numbers into the record.
                  */
              onReset={() =>
                void actions.saveSettings({
                  theme: {
                    surface: "",
                    accent: "",
                    accentTwo: "",
                    softness: 0,
                    wash: DEFAULT_WASH,
                    textBrightness: 0,
                    glassEnabled: undefined,
                    glassBlur: undefined,
                    glassRefraction: undefined,
                    glassDepth: undefined,
                    glassOpacity: undefined,
                    glassScrim: undefined,
                  },
                })
              }
            />

            {/*
                  Glass is three numbers, and these are they.

                  `@pathscale/ui` derives twenty-five `--glass-*` tokens from
                  blur, refraction and depth, so they are passed straight
                  through rather than reinterpreted here.

                  There were six. AgencyZero's own opaque `.az-panel` cannot
                  use the library's tokens directly, so it had grown a parallel
                  set of lift/edge/depth sliders, and two of the six were
                  called "depth" while moving different things. The panel is
                  derived from these three now (`panelAxes` in `lib/theme`),
                  which is the same split the library already makes: three
                  physical properties, one place to set them.
                */}
            {/*
                  The switch that turns the whole effect off.

                  Glass is a taste, and on a busy backdrop it is a legibility
                  cost rather than a look. Every axis below is a shade of "how
                  much", and none of them is "none": the opacity slider stops
                  at a film that is still a film, and turning the others down
                  leaves translucent surfaces behind. So there was no way to
                  say no to the effect, only to ask for less of it.

                  One flag rather than a remembered set of slider positions.
                  `writeGlassTuning` reads it to decide whether to write the
                  tokens and to throw the library's root class, so off means
                  every surface in the app and every component in the library
                  goes solid together, and back on restores the numbers that
                  were already stored.
                */}
            <Row
              label={tx("Glass")}
              hint={tx("turn every translucent surface solid, in one switch")}
            >
              <Switch
                id="settings-theme-glass-enabled"
                aria-label={tx("Glass")}
                checked={current().theme.glassEnabled !== false}
                flavor="accent"
                class="shrink-0"
                onChange={(event) =>
                  actions.saveSettings({
                    theme: { glassEnabled: event.currentTarget.checked },
                  })
                }
              />
            </Row>

            {/*
                  Blur only reaches what *this app* painted behind a panel.

                  `backdrop-filter` samples pixels the renderer drew. Behind a
                  transparent window there are none - the compositor owns them
                  - so no radius here can blur the desktop, and the window's own
                  blur comes from `NSGlassEffectView`, which exposes no radius
                  to set. The axis is therefore real but quiet: it separates
                  panels from the transcript behind them and nothing more.

                  Kept rather than removed because that separation is the thing
                  a busy transcript needs, and because 0 is a legitimate setting
                  that costs nothing. The hint no longer promises the desktop.
                */}
            <Row
              label={tx("Glass blur")}
              hint={tx("how far a panel smears the app's own content behind it")}
            >
              <GlassTuningAxis
                id="settings-theme-glass-blur"
                label={tx("Glass blur")}
                axis="blur"
                theme={current().theme}
                step={1}
                value={current().theme.glassBlur}
                format={(value) => `${Math.round(value)}px`}
                onChange={(glassBlur) => actions.saveSettings({ theme: { glassBlur } })}
              />
            </Row>
            <Row
              label={tx("Glass refraction")}
              hint={tx("how much a glass surface asserts its own tint, border and highlight")}
            >
              <GlassTuningAxis
                id="settings-theme-glass-refraction"
                label={tx("Glass refraction")}
                axis="refraction"
                theme={current().theme}
                // The axis runs 0 to 0.4, so a whole-number step would be
                // three usable positions. Shown as a percentage of its own
                // range, which is what the number means.
                step={0.01}
                value={current().theme.glassRefraction}
                format={(value) => `${Math.round((value / GLASS_LIMITS.refraction.max) * 100)}%`}
                onChange={(glassRefraction) => actions.saveSettings({ theme: { glassRefraction } })}
              />
            </Row>
            <Row
              label={tx("Glass depth")}
              hint={tx("how far a glass surface sits off the page: glow, sheen and shadow")}
            >
              <GlassTuningAxis
                id="settings-theme-glass-depth"
                label={tx("Glass depth")}
                axis="depth"
                theme={current().theme}
                step={1}
                value={current().theme.glassDepth}
                format={(value) => `${Math.round((value / GLASS_LIMITS.depth.max) * 100)}%`}
                onChange={(glassDepth) => actions.saveSettings({ theme: { glassDepth } })}
              />
            </Row>

            {/*
                  Opacity and scrim are AgencyZero's, not the library's.

                  The library derives `--glass-background-opacity` from
                  refraction alone, and on a dark surface that curve is
                  `7 * refraction`: at the shipped 0.31 it lands near 5%, a film
                  nobody can see. The only way to get a surface that reads as
                  material was to raise refraction, which also drives the
                  border, the highlight, the rim and the inner glow, so "more
                  solid" arrived as "every edge shouts".

                  They pull in opposite directions, which is why they are two
                  sliders rather than one: the film is the surface's own colour
                  and lightens a dark desk, the scrim is a wash beneath it that
                  holds text contrast when the backdrop is busy.
                */}
            <Row
              label={tx("Glass opacity")}
              hint={tx("how solid the surface's own film is over what it sits on")}
            >
              {/*
                    100, not 95.

                    The ceiling was five points short of solid, so the one
                    setting that means "no glass on the surfaces" could not be
                    reached: the slider bottomed out at a film that was still a
                    film, and turning glass off needed a separate switch. A
                    control named for solidity has to be able to say fully
                    solid.
                  */}
              <GlassPercentAxis
                id="settings-theme-glass-opacity"
                label={tx("Glass opacity")}
                max={100}
                value={current().theme.glassOpacity ?? DEFAULT_GLASS_OPACITY}
                property="--glass-background-opacity"
                /*
                      The same two tokens `writeGlassTuning` derives from this
                      number: the desk alpha that `body` and `.az-desk` take,
                      and the control tint. Without them the drag moved only
                      the panels and the release moved the rest.
                    */
                sideEffects={{
                  "--az-glass-alpha": (value) =>
                    `${Math.round(Math.min(Math.max(value, 0), 100))}%`,
                  "--glass-control-opacity": (value) =>
                    `${Math.round(100 - (100 - Math.min(Math.max(value, 0), 100)) * 0.33)}%`,
                }}
                onChange={(glassOpacity) => actions.saveSettings({ theme: { glassOpacity } })}
              />
            </Row>
            <Row
              label={tx("Glass scrim")}
              hint={tx("how much a glass surface darkens what is behind it, for text contrast")}
              isLast
            >
              <GlassPercentAxis
                id="settings-theme-glass-scrim"
                label={tx("Glass scrim")}
                max={70}
                value={current().theme.glassScrim ?? DEFAULT_GLASS_SCRIM}
                property="--az-glass-scrim-opacity"
                onChange={(glassScrim) => actions.saveSettings({ theme: { glassScrim } })}
              />
            </Row>
          </Section>

          <Section
            id="settings-section-data"
            icon="folder"
            title={tx("Data")}
            hint={tx("where projects, items and messages are stored")}
          >
            <Show when={state.workspaceRoot}>
              {(root) => (
                <Row
                  label={tx("Workspace")}
                  searchTerms={[tx("Create it")]}
                  hint={
                    root().exists
                      ? tx("new projects run here")
                      : tx("recommended, and not created yet")
                  }
                >
                  <Flex align="center" gap="sm">
                    <span class="max-w-[280px] truncate font-mono text-az-body text-ui-detail">
                      {root().path}
                    </span>
                    <Show when={!root().exists}>
                      <Button
                        id="settings-workspace-create"
                        type="button"
                        onClick={() => void actions.createWorkspaceRoot()}
                        class="shrink-0 rounded-lg border border-primary/50 px-2.5 py-[4px] text-primary text-ui-detail transition-colors hover:border-primary"
                      >
                        {tx("Create it")}
                      </Button>
                    </Show>
                  </Flex>
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
                    <span class="max-w-[340px] truncate font-mono text-az-body text-ui-detail">
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
                        <span class="max-w-[340px] truncate font-mono text-primary text-ui-detail">
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
                    <Flex align="center" gap="sm">
                      <Button
                        id="settings-data-choose"
                        type="button"
                        disabled={!location().isEditable || !isLive("chooseDataDirectory")}
                        onClick={() => void actions.chooseDataLocation()}
                        class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-body text-ui-label transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {tx("Choose…")}
                      </Button>
                      <Button
                        id="settings-data-use-default"
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
                        class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-muted text-ui-label transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {tx("Use the default")}
                      </Button>
                    </Flex>
                  </Row>
                  <Row
                    label={tx("Backups")}
                    hint={tx("closed-store copies verified byte for byte")}
                  >
                    <StoreBackupControls />
                  </Row>
                  {/*
                        Manual, and only manual. This ran on every launch, which
                        cost a full copy of the store per boot and left ten of
                        them in one profile — while the corruption that did
                        happen was copied faithfully into the rolling snapshots,
                        so neither could restore past it.
                      */}
                  <Row
                    label={tx("Snapshot")}
                    hint={tx("a copy of the store as it stands, without closing the app")}
                    isLast
                  >
                    <StoreSnapshotControl />
                  </Row>
                </>
              )}
            </Show>
          </Section>

          <ChatImportSettings />

          <StudySettings />

          <Section
            id="settings-section-agent-authority"
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
                id="settings-agent-settings-updates"
                label={tx("Allow agents to update app settings")}
                checked={current().agentSettingsUpdates}
                onChange={(agentSettingsUpdates) =>
                  void actions.saveSettings({ agentSettingsUpdates })
                }
              />
            </Row>
          </Section>

          <Section
            id="settings-section-moderator"
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
                id="settings-moderator-enabled"
                label={tx("Moderator enabled by default")}
                checked={current().moderator.enabled}
                onChange={(enabled) => void actions.saveSettings({ moderator: { enabled } })}
              />
            </Row>
            <Row label={tx("Moderator model")}>
              {/*
               * This stays a real native select. UI's compound Select uses a
               * custom popover; it cannot provide the operating-system option
               * semantics this small single-choice control promises.
               */}
              <select
                id="settings-moderator-model"
                aria-label={`${tx("Moderator model")}: ${moderatorModelLabel()}`}
                value={current().moderator.model}
                onChange={(event) =>
                  void actions.saveSettings({ moderator: { model: event.currentTarget.value } })
                }
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    moveModeratorModel(event.key === "ArrowDown" ? 1 : -1);
                  }
                }}
                class="h-9 min-w-[220px] rounded-lg border border-az-hairline bg-az-inset px-2.5 text-az-body text-ui-label outline-none"
              >
                <For each={moderatorModels()}>
                  {(model) => <option value={model.value}>{model.label}</option>}
                </For>
              </select>
            </Row>
            <Row label={tx("Confine tool calls to the working directories")}>
              <SettingToggle
                id="settings-moderator-confine-dirs"
                label={tx("Confine tool calls to the working directories")}
                checked={current().moderator.confineToDirs}
                onChange={(confineToDirs) =>
                  void actions.saveSettings({ moderator: { confineToDirs } })
                }
              />
            </Row>

            <div class="flex flex-col gap-2.5 px-3.5 py-3">
              <span class="font-semibold text-az-muted text-ui-detail uppercase tracking-[.04em]">
                {tx("On a hold")}
              </span>

              <HoldRow
                id="settings-moderator-check-hold"
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
                id="settings-moderator-critical-hold"
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
            id="settings-section-notifications"
            icon="info"
            title={tx("Notifications")}
            hint={tx("while you are in another window")}
            pending={notificationPending()}
          >
            <Row label={tx("A hold needs your approval")}>
              <SettingToggle
                id="settings-notify-hold"
                label={tx("Notify on a hold")}
                checked={current().notifications.onHold}
                onChange={(onHold) => void actions.saveSettings({ notifications: { onHold } })}
              />
            </Row>
            <Row label={tx("A run finishes")}>
              <SettingToggle
                id="settings-notify-run-finished"
                label={tx("Notify when a run finishes")}
                checked={current().notifications.onRunFinished}
                onChange={(onRunFinished) =>
                  void actions.saveSettings({ notifications: { onRunFinished } })
                }
              />
            </Row>
            <Row label={tx("A task fails")}>
              <SettingToggle
                id="settings-notify-task-failed"
                label={tx("Notify when a task fails")}
                checked={current().notifications.onTaskFailed}
                onChange={(onTaskFailed) =>
                  void actions.saveSettings({ notifications: { onTaskFailed } })
                }
              />
            </Row>
            <Row label={tx("Rate limited by the provider")}>
              <SettingToggle
                id="settings-notify-rate-limited"
                label={tx("Notify when rate limited")}
                checked={current().notifications.onRateLimited}
                onChange={(onRateLimited) =>
                  void actions.saveSettings({ notifications: { onRateLimited } })
                }
              />
            </Row>
            <Row label={tx("Play a sound")} isLast>
              <SettingToggle
                id="settings-notify-sound"
                label={tx("Play a sound")}
                checked={current().notifications.sound}
                onChange={(sound) => void actions.saveSettings({ notifications: { sound } })}
              />
            </Row>
          </Section>

          <Section
            id="settings-section-environment"
            icon="lock"
            title={tx("Environment")}
            pending={environmentPending()}
            hint={tx("what the agent process inherits from this machine")}
          >
            <Row
              label={tx("Environment policy")}
              hint={tx(
                "Minimal passes only PATH, HOME and USER — the verified floor for all three CLIs",
              )}
            >
              <PillMenu<EnvPolicy>
                id="settings-environment-policy"
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
                id="settings-forward-proxy-vars"
                label={tx("Forward proxy and custom-CA variables")}
                checked={current().forwardProxyVars}
                onChange={(forwardProxyVars) => void actions.saveSettings({ forwardProxyVars })}
              />
            </Row>
          </Section>

          <Show when={isLive("claudeUsage")}>
            <ExperimentalSettings />
          </Show>

          <InternalPerformance />

          <p class="flex gap-2 text-az-muted text-ui-detail leading-[1.5]">
            <Icon name="info" class="relative top-0.5 shrink-0 text-ui-body" />
            <span>
              {tx("Sessions are stored per project by agent-abstraction at")}{" "}
              <code class="font-mono">{tx("<dir>/<project-slug>/<name>.json")}</code>.
            </span>
          </p>
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
  const alive = whileMounted();
  const available = () => isLive("discoverChatImports") && isLive("importChatSession");
  const importableSessions = (source: ChatImportSource) =>
    source.sessions.filter((session) => session.importable);

  const refresh = async (): Promise<void> => {
    if (!available()) return;
    const found = await actions.discoverChatImports();
    alive(setSources)(found);
  };

  onSettled(() => {
    void refresh().catch(alive((cause) => setNote(describeError(cause))));
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
      id="settings-section-import-chats"
      icon="messages-square"
      title={tx("Import chats")}
      hint={tx("copy local provider transcripts into new AgencyZero projects")}
      searchTerms={[
        tx("Choose a session from {source}", { source: "Codex CLI / IDE" }),
        tx("Import"),
        tx("Import all"),
      ]}
      pending={available() ? undefined : tx("requires the native import backend")}
    >
      <Show
        when={sources().length > 0}
        fallback={
          <Row label={tx("Local sources")} hint={tx("checking known provider stores")} isLast>
            <span class="text-az-muted text-ui-detail">{tx("No sessions discovered")}</span>
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
                    <span class="text-az-faint text-ui-caption">
                      {source.available ? tx("No importable sessions") : tx("Not installed")}
                    </span>
                  }
                >
                  <div class="flex w-full items-center gap-2">
                    <Select
                      id={`settings-chat-import-${encodeURIComponent(source.source)}`}
                      value={choice(source)}
                      onChange={(value) =>
                        typeof value === "string" &&
                        setSelected((current) => ({ ...current, [source.source]: value }))
                      }
                      fullWidth
                      class="min-w-0 flex-1"
                    >
                      <Select.Trigger
                        aria-label={tx("Choose a session from {source}", { source: source.label })}
                        class="h-9 w-full min-w-0 rounded-lg border border-az-hairline bg-az-inset px-2 text-az-body text-ui-label outline-none"
                      >
                        <Select.Value />
                        <Select.Indicator endIcon={<Icon name="chevron-down" />} />
                      </Select.Trigger>
                      <Select.Popover>
                        <Select.Listbox>
                          <For each={importableSessions(source)}>
                            {(session) => {
                              const label = `${session.title}${
                                session.messages > 0 ? ` · ${session.messages}` : ""
                              }`;
                              return (
                                <Select.Option value={session.id} textValue={label}>
                                  {label}
                                </Select.Option>
                              );
                            }}
                          </For>
                        </Select.Listbox>
                      </Select.Popover>
                    </Select>
                    <Button
                      id={`settings-chat-import-${encodeURIComponent(source.source)}-one`}
                      type="button"
                      disabled={!choice(source) || busy() !== null}
                      onClick={() => void importOne(source.source, choice(source))}
                      class="h-9 shrink-0 rounded-lg border border-az-hairline-strong px-2.5 text-primary text-ui-caption transition-colors hover:border-primary disabled:opacity-40"
                    >
                      {busy() === `${source.source}:${choice(source)}`
                        ? tx("Importing…")
                        : tx("Import")}
                    </Button>
                    <Button
                      id={`settings-chat-import-${encodeURIComponent(source.source)}-all`}
                      type="button"
                      disabled={busy() !== null}
                      onClick={() => void importAll(source)}
                      class="h-9 shrink-0 rounded-lg border border-primary/45 px-2.5 font-medium text-primary text-ui-caption transition-colors hover:border-primary hover:bg-az-chip disabled:opacity-40"
                    >
                      {busy() === `${source.source}:*` ? tx("Importing all…") : tx("Import all")}
                    </Button>
                  </div>
                </Show>
              </div>
            </Row>
          )}
        </For>
      </Show>
      <Show when={note()}>
        {(message) => (
          <p
            role="status"
            aria-live="polite"
            aria-label={message()}
            class="px-3.5 py-2 text-az-muted text-ui-detail"
          >
            {message()}
          </p>
        )}
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

  onSettled(() => {
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
      id="settings-section-research"
      icon="gauge"
      title={tx("Research")}
      hint={tx("local, opt-in PromptSyntax deployment study")}
      pending={available() ? undefined : tx("needs the study event backend")}
    >
      <div class="border-az-hairline-soft border-b px-3.5 py-3 text-az-muted text-ui-detail leading-[1.55]">
        {tx(
          "Records timestamps, prompt character and line counts, attachment counts, whether you used PromptSyntax, operation types, providers, opaque links, timing and explicit outcomes. It does not copy prompt text, agent prose, task titles, paths, URLs, tool calls, tool output or attachment contents. Nothing is uploaded.",
        )}
      </div>
      <Row
        label={tx("PS deployment study")}
        hint={tx("off by default; disabling stops new rows but keeps existing data")}
      >
        <SettingToggle
          id="settings-study-enabled"
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
        <span class="font-mono text-az-strong text-ui-label tabular-nums">
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
        <Flex align="center" gap="sm">
          <Button
            id="settings-study-export"
            type="button"
            disabled={busy()}
            onClick={() => void exportEvents()}
            class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-body text-ui-label transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
          >
            {tx("Export JSONL")}
          </Button>
          <Button
            id="settings-study-delete"
            type="button"
            disabled={busy() || enabled() || (summary()?.eventCount ?? 0) === 0}
            onClick={() => void clearEvents()}
            onBlur={() => setConfirmingDelete(false)}
            class={`rounded-lg border px-3 py-[5px] text-ui-label transition-colors disabled:opacity-40 ${
              confirmingDelete()
                ? "border-error/60 text-error hover:border-error"
                : "border-az-hairline-strong text-az-muted hover:border-error/50 hover:text-error"
            }`}
          >
            {confirmingDelete() ? tx("Confirm delete") : tx("Delete data")}
          </Button>
        </Flex>
      </Row>
    </Section>
  );
}

/** Provider usage controls compiled and advertised only by the experimental profile. */
function ExperimentalSettings(): JSX.Element {
  const { state, actions } = useWorkspace();
  // Every reader below is a countdown or a relative time, none finer than a
  // minute, so the 1s default was a re-render a second for text that does not
  // change that fast.
  const now = useNow(30_000);
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = createSignal(0);

  const refresh = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      // Forced: asking for a reading by hand should outrank the poll's backoff.
      const results = await Promise.allSettled([
        actions.refreshQuota(),
        actions.refreshClaudeUsage({ force: true }),
      ]);
      setRefreshGeneration((generation) => generation + 1);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } catch (cause) {
      setNote(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  onSettled(() => void refresh());

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
      id="settings-section-experimental"
      icon="sparkles"
      title={tx("Experimental")}
      hint={tx("isolated capabilities in AgencyZero Experimental")}
    >
      <Row
        label={tx("Codex 7-day usage")}
        hint={tx("managed by Codex; refreshed through its local app-server")}
      >
        <span class="font-mono text-az-body text-ui-detail">
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
        <span class="font-mono text-az-body text-ui-detail">{tx("Claude Code")}</span>
      </Row>
      <Row label={tx("Claude 5-hour usage")}>
        <span class="font-mono text-az-body text-ui-detail">
          {windowValue(usage()?.fiveHour ?? null)}
        </span>
      </Row>
      <Row label={tx("Claude 7-day usage")}>
        <span class="font-mono text-az-body text-ui-detail">
          {windowValue(usage()?.sevenDay ?? null)}
        </span>
      </Row>
      <Show when={usage()?.sevenDaySonnet}>
        {(value) => (
          <Row label={tx("Claude Sonnet 7-day usage")}>
            <span class="font-mono text-az-body text-ui-detail">{windowValue(value())}</span>
          </Row>
        )}
      </Show>
      <Show when={(usage()?.limits.length ?? 0) > 0}>
        <For each={usage()?.limits ?? []}>
          {(limit) => (
            <Row label={`Claude ${limit.model ?? limit.kind}`}>
              <span class="font-mono text-az-body text-ui-detail">
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
        searchTerms={[tx("Refresh provider usage")]}
        hint={
          usage() ? `checked ${relativeTime(usage()!.checkedAt, now())}` : (note() ?? undefined)
        }
        isLast
      >
        <Flex align="center" gap="sm">
          <span
            role="status"
            aria-label={tx("Usage refresh generation {count}", {
              count: refreshGeneration(),
            })}
            class="sr-only"
          >
            {tx("Usage refresh generation {count}", { count: refreshGeneration() })}
          </span>
          <Show when={note()}>
            {(message) => <span class="max-w-[230px] text-error text-ui-caption">{message()}</span>}
          </Show>
          <Button
            id="settings-provider-usage-refresh"
            type="button"
            aria-label={tx("Refresh provider usage")}
            disabled={busy()}
            onClick={() => void refresh()}
            class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-body text-ui-label transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
          >
            {busy() ? tx("Refreshing…") : tx("Refresh")}
          </Button>
        </Flex>
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
  const alive = whileMounted();

  onSettled(() => {
    void actions
      .listTableSizes()
      .then(alive(setSizes))
      .catch(
        alive((cause) => {
          setFailed(true);
          log.error(`could not measure the tables: ${describeError(cause)}`);
        }),
      );
  });

  const total = () => (sizes() ?? []).reduce((sum, table) => sum + table.bytes, 0);

  return (
    <Show
      when={sizes()}
      fallback={
        <span class="text-az-muted text-ui-detail">
          {failed() ? tx("unavailable") : tx("measuring…")}
        </span>
      }
    >
      {(tables) => (
        <div class="flex max-w-[340px] flex-col gap-1">
          <For each={tables()}>
            {(table) => (
              <div class="flex items-baseline justify-between gap-3">
                <span class="truncate font-mono text-az-body text-ui-caption">{table.name}</span>
                <span class="shrink-0 font-mono text-az-muted text-ui-caption">
                  {formatBytes(table.bytes)}
                </span>
              </div>
            )}
          </For>
          <div class="mt-0.5 flex items-baseline justify-between gap-3 border-az-hairline border-t pt-1">
            <span class="font-semibold text-az-muted text-ui-caption uppercase tracking-[.04em]">
              {tx("total")}
            </span>
            <span class="shrink-0 font-mono text-az-strong text-ui-caption">
              {formatBytes(total())}
            </span>
          </div>
          <Show when={state.backend === "mock"}>
            <span class="text-az-faint text-ui-caption-sm">
              {tx("fixtures — no store to measure")}
            </span>
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
  const alive = whileMounted();

  onSettled(() => {
    void actions
      .getStoreBackupStatus()
      .then(alive(setStatus))
      .catch(
        alive((cause) => {
          const message = describeError(cause);
          setError(message);
          log.error(`could not list store backups: ${message}`);
        }),
      );
  });

  const backup = (): void => {
    setError("");
    void actions.createStoreBackup().catch(alive((cause) => setError(describeError(cause))));
  };

  const selectBackup = (): void => {
    setError("");
    void actions
      .selectStoreBackup()
      .then(
        alive((picked) => {
          if (picked) setSelection(picked);
        }),
      )
      .catch(alive((cause) => setError(describeError(cause))));
  };

  const restore = (): void => {
    setError("");
    void actions.restoreStoreBackup().catch((cause) => {
      setError(describeError(cause));
    });
  };

  return (
    <div class="flex max-w-[390px] flex-col items-end gap-1.5">
      <span class="text-right text-az-muted text-ui-caption">
        {tx("Portable .azbackup package · version and integrity checked")}
      </span>
      <span class="text-right text-az-faint text-ui-caption-sm">
        {tx("The app drains and restarts so the store is never copied while open.")}
      </span>
      <Show when={status()?.lastOperation}>
        {(operation) => (
          <span
            class={`text-right text-ui-caption-sm ${operation().ok ? "text-success" : "text-error"}`}
          >
            {operation().message}
          </span>
        )}
      </Show>
      <Show when={error()}>
        <span role="alert" class="text-right text-error text-ui-caption-sm">
          {error()}
        </span>
      </Show>
      <Flex align="center" gap="sm">
        <Button
          id="settings-store-backup-create"
          type="button"
          disabled={!isLive("createStoreBackup")}
          onClick={backup}
          class="rounded-lg border border-primary/50 px-3 py-[5px] text-primary text-ui-label transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {tx("Back up & close")}
        </Button>
        <Show
          when={selection()}
          fallback={
            <Button
              id="settings-store-backup-select"
              type="button"
              disabled={!isLive("selectStoreBackup")}
              onClick={selectBackup}
              class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-muted text-ui-label transition-colors hover:border-warning hover:text-warning disabled:cursor-not-allowed disabled:opacity-40"
            >
              {tx("Select backup file…")}
            </Button>
          }
        >
          <code class="max-w-[160px] truncate font-mono text-az-body text-ui-caption-sm">
            {selection()?.fileName}
          </code>
          <Button
            id="settings-store-backup-restore"
            type="button"
            onClick={restore}
            class="rounded-lg border border-warning/50 px-2.5 py-[4px] font-semibold text-ui-detail text-warning hover:border-warning"
          >
            {tx("Restore")}
          </Button>
          <Button
            id="settings-store-backup-cancel"
            type="button"
            onClick={() => setSelection(null)}
            class="rounded-lg px-2 py-[4px] text-az-muted text-ui-detail hover:text-base-content"
          >
            {tx("Cancel")}
          </Button>
        </Show>
      </Flex>
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
            <span class="truncate font-mono text-az-body text-ui-caption">{dir}</span>
            <Button
              id={`settings-task-manager-dir-remove-${encodeURIComponent(dir)}`}
              type="button"
              onClick={() => save(props.taskManager.dirs.filter((kept) => kept !== dir))}
              aria-label={`Remove ${dir}`}
              class="shrink-0 text-az-faint transition-colors hover:text-error"
            >
              <Icon name="x" class="text-ui-caption" />
            </Button>
          </span>
        )}
      </For>
      <Input.Field
        id="settings-task-manager-dir-add"
        value={path()}
        placeholder={tx("~/code/…")}
        aria-label={tx("Add a task manager directory")}
        onInput={(event) => setPath(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
        onBlur={add}
        class="w-[200px] rounded-md border border-az-hairline bg-az-inset px-2 py-1 font-mono text-az-body text-ui-caption focus:border-primary/40 focus:outline-none"
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
          <span class="font-mono text-az-faint text-ui-caption">{tx("no conversation yet")}</span>
        }
      >
        {(session) => (
          <span class="max-w-[180px] truncate font-mono text-az-faint text-ui-caption">
            {session()}
          </span>
        )}
      </Show>
      <Button
        id="settings-task-manager-reset"
        type="button"
        onClick={() => void reset()}
        disabled={busy() || !state.taskManagerSession || !isLive("resetTaskManager")}
        class="shrink-0 rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-body text-ui-label transition-colors hover:border-warning hover:text-warning disabled:opacity-40"
      >
        {busy() ? tx("Resetting…") : tx("Reset")}
      </Button>
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
  const alive = whileMounted();

  // Once per visit: the answer cannot change without the process being
  // replaced, and a replaced process remounts this anyway.
  onSettled(() => {
    void actions
      .getBuildInfo()
      .then(alive(setBuild))
      .catch(alive(() => setBuild(null)));
  });

  return (
    <Show when={build()} fallback={<span class="text-az-faint text-ui-label">—</span>}>
      {(info) => (
        <span class="font-mono text-az-body text-ui-detail">
          {info().version} · {info().runtime} · {info().gitSha} {tx("· built")} {info().builtAt}
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
    <Flex align="center" gap="sm">
      <Button
        id="settings-view-source"
        type="button"
        onClick={openRepository}
        class="rounded-lg border border-az-hairline-strong px-2.5 py-1 text-az-muted text-ui-detail transition-colors hover:border-primary hover:text-primary"
      >
        {tx("View source")}
      </Button>
      <Button
        id="settings-star-github"
        type="button"
        onClick={openRepository}
        class="rounded-lg bg-primary px-2.5 py-1 text-primary-content text-ui-detail transition-opacity hover:opacity-90"
      >
        {tx("Star on GitHub")}
      </Button>
    </Flex>
  );
}

/**
 * The whole update story in one row: what the boot check found, a manual
 * re-check, and the install button. "Up to date" is only ever said after an
 * *explicit* check succeeds — the passive boot check's failure and a current
 * install look identical in state, and claiming freshness on a check that
 * never reached the CDN is the lie the backend was built to avoid.
 */
// Survives Settings search/deferred remounts. A check can finish while its row
// is temporarily unmounted; keeping the completion generation inside the row
// discarded that result and made a completed backend call look hung.
const [updateCheckGeneration, setUpdateCheckGeneration] = createSignal(0);

function UpdateControl(): JSX.Element {
  const { state, actions, isLive } = useWorkspace();
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  const alive = whileMounted();

  const check = (): void => {
    setBusy(true);
    setNote(null);
    void actions
      .checkForUpdate()
      .then(alive((found) => setNote(found ? null : tx("up to date"))))
      .catch(alive((cause) => setNote(describeError(cause))))
      .finally(
        alive(() => {
          setUpdateCheckGeneration((value) => value + 1);
          setBusy(false);
        }),
      );
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
    <Flex align="center" gap="sm">
      <span
        role="status"
        aria-label={`Update check generation ${updateCheckGeneration()}`}
        class="sr-only"
      />
      <Show when={note()}>
        {(text) => (
          <span class="max-w-[220px] truncate text-az-muted text-ui-detail">{text()}</span>
        )}
      </Show>
      <Show
        when={state.availableUpdate}
        fallback={
          <Button
            id="settings-update-check"
            type="button"
            onClick={check}
            disabled={busy() || !isLive("checkForUpdate")}
            class="shrink-0 rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-body text-ui-label transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
          >
            {busy() ? tx("Checking…") : tx("Check for update")}
          </Button>
        }
      >
        {(update) => (
          <>
            <span class="shrink-0 font-mono text-primary text-ui-detail">
              {update().version} {tx("available")}
            </span>
            <Button
              id="settings-update-install"
              type="button"
              onClick={install}
              disabled={busy() || !isLive("installUpdate")}
              class="shrink-0 rounded-lg border border-primary/50 px-3 py-[5px] font-semibold text-primary text-ui-label transition-colors hover:border-primary hover:bg-az-chip disabled:opacity-40"
            >
              {busy() ? tx("Installing…") : tx("Install & Restart")}
            </Button>
          </>
        )}
      </Show>
    </Flex>
  );
}

function RelaunchButton(): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [busy, setBusy] = createSignal(false);
  const alive = whileMounted();

  return (
    <Button
      id="settings-restart-app"
      type="button"
      disabled={busy() || !isLive("relaunchApp")}
      onClick={() => {
        setBusy(true);
        void actions.relaunchApp().catch(alive(() => setBusy(false)));
      }}
      class="shrink-0 rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-body text-ui-label transition-colors hover:border-warning hover:text-warning disabled:opacity-40"
    >
      {busy() ? tx("Restarting…") : tx("Restart")}
    </Button>
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
  const alive = whileMounted();
  let warningSaveRevision = 0;

  /*
   * Split, because the slider now says when a value is live and when it has
   * settled. Dragging used to persist on every tick: each of those awaited a
   * serialized store write, so the knob raced its own saves.
   *
   * The preview holds the shown value until the save it belongs to lands, and
   * the revision guard means an older save finishing late cannot pull the
   * display back to a value the user has already moved past.
   */
  const previewWarning = (costWarningUsd: number): void => {
    setWarningPreview(costWarningUsd);
    /*
     * Any save already in flight is now stale, so it must not clear the preview
     * when it lands: doing so would snap the knob back to a value the user has
     * already moved past. The revision has to advance here and not only at
     * commit, because with the write debounced a new value can arrive while an
     * older save is still open.
     */
    warningSaveRevision++;
  };

  /*
   * A drag reports far faster than a store write completes, and every write
   * awaits the one before it. Persisting per tick meant the knob raced its own
   * saves: one session's log held 75 settings writes for a few drags.
   */
  let warningSettle: ReturnType<typeof setTimeout> | undefined;
  const settleWarning = (costWarningUsd: number): void => {
    clearTimeout(warningSettle);
    warningSettle = setTimeout(() => commitWarning(costWarningUsd), SETTLE_MS);
  };
  onCleanup(() => clearTimeout(warningSettle));

  const commitWarning = (costWarningUsd: number): void => {
    setWarningPreview(costWarningUsd);
    const revision = ++warningSaveRevision;
    void actions.saveSettings({ costWarningUsd }).finally(
      alive(() => {
        if (revision === warningSaveRevision) setWarningPreview(null);
      }),
    );
  };

  // Asked once per visit: the ledger only grows when a run finishes, and
  // Settings is not a screen left open while runs happen.
  onSettled(() => {
    void actions
      .getCostSummary()
      .then(alive(setSummary))
      .catch(alive(() => setSummary(null)));
  });

  const dollars = (value: number | undefined): string =>
    typeof value === "number" ? `$${value.toFixed(2)}` : "—";
  const figure = (value: number | undefined): JSX.Element => (
    <span class="font-mono text-az-strong text-ui-label-lg">{dollars(value)}</span>
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
   *
   * 30s rather than the 1s default: these are countdowns to midnight and to
   * the first of the month, so a per-second tick bought a re-render a second
   * for a figure that changes by the minute. Settings is open a lot, and that
   * clock ran whether or not anything on screen was counting.
   */
  const now = useNow(30_000);
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
      id="settings-section-cost"
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
        <div class="min-w-[260px]">
          <Slider
            id="settings-cost-warning-threshold"
            label={tx("Projected turn warning threshold")}
            min={0.25}
            max={20}
            step={0.25}
            value={warningUsd()}
            formatValue={(value) => `$${value.toFixed(2)}`}
            // Live while dragging, persisted when the knob is released.
            // `onChangeEnd` is the event that means exactly that, and it
            // arrived with the 2.x line this app is now on; the local settle
            // timer it replaces dated from the pinned 1.3.1, which had none.
            onChange={(value) => previewWarning(value)}
            onChangeEnd={(value) => settleWarning(value)}
            size="sm"
            class="w-full min-w-0 [&_[data-slot=label]]:sr-only"
          />
        </div>
      </Row>
      <Row
        label={tx("Cost warnings")}
        hint={tx("turn off the large projected-cost warning; estimates and Compact remain visible")}
        isLast
      >
        <SettingToggle
          id="settings-cost-warnings-enabled"
          label={tx("Show projected-cost warnings")}
          checked={!prefs.costWarningsDisabled}
          onChange={(enabled) =>
            setPrefs((d) => {
              d.costWarningsDisabled = !enabled;
            })
          }
        />
      </Row>
    </Section>
  );
}

/*
 * How many sections render in the first commit, and how many follow per tick.
 *
 * Every section is mounted and hidden with a class rather than unmounted, so
 * search can ask each row whether it matches. That is the right call for
 * search and the wrong one for opening the tab: all seventeen sections and
 * around a thousand controls were built in a single synchronous commit, which
 * measured 1388ms the first time Settings was opened and 53ms every time
 * after. The tree is the same either way; the difference is whether it arrives
 * in one commit or several.
 *
 * Staggering it costs nothing in the end state and makes the tab appear at
 * once. Sections still never unmount once mounted, so search keeps working.
 */
const SETTINGS_FIRST_PAINT = 3;

/**
 * How far below the viewport a section is built in advance, in pixels.
 *
 * Enough that a scroll finds it already there, small enough that opening the
 * tab does not build the whole page.
 */
const SETTINGS_PREBUILD_PX = 600;

let settingsMounted = 0;
const [settingsBudget, setSettingsBudget] = createSignal(SETTINGS_FIRST_PAINT);

/**
 * Start a fresh deferred-section sequence for one Settings tree.
 *
 * The coordinator lives at module scope because search and each Section share
 * it without prop plumbing. Its lifetime must not: leaving Settings disposes
 * every section, so carrying the old ordinal and fully expanded budget into
 * the next tree eagerly rebuilt the whole page on every return.
 */
function beginSettingsMount(): void {
  settingsMounted = 0;
  setSettingsBudget(SETTINGS_FIRST_PAINT);
}

/** Reveal every deferred search candidate in small frame-sized batches. */
function revealSearchSections(): void {
  if (searchRevealFrame !== undefined) return;
  searchRevealFrame = requestAnimationFrame(() => {
    searchRevealFrame = undefined;
    if (settingsQuery().trim() === "" || settingsBudget() >= settingsMounted) {
      return;
    }
    // A prior retained Settings tree can report a match before the active tree
    // reaches the same row. Never stop on that global report: admit all
    // candidates quickly enough for an interactive search, without rebuilding
    // the full page in one frame.
    setSettingsBudget((budget) => Math.min(settingsMounted, budget + 4));
    revealSearchSections();
  });
}

/** Admit sections up to and including `ordinal`. Never gives one back. */
function admitSection(ordinal: number): void {
  setSettingsBudget((budget) => (ordinal < budget ? budget : ordinal + 1));
}

/**
 * Application internal performance.
 *
 * Every Tauri command, every project load, every tab switch and the transcript
 * phases underneath them, aggregated by `~/lib/perf`. Written as a table rather
 * than log lines because the interesting questions about a thing that happens
 * hundreds of times are how often, how bad at worst, and what it usually is.
 *
 * The snapshot is taken when this renders and on demand, never on a timer: a
 * panel nobody has open should cost nothing at all, which is also why the
 * collector only ever appends numbers and does no formatting.
 */
function InternalPerformance(): JSX.Element {
  const { state } = useWorkspace();
  const [table, setTable] = createSignal(perfSnapshot());
  const [refreshGeneration, setRefreshGeneration] = createSignal(0);
  const [resetGeneration, setResetGeneration] = createSignal(0);
  const refresh = () => {
    setTable(perfSnapshot());
    setRefreshGeneration((generation) => generation + 1);
  };

  /*
   * Re-read whenever Settings comes to the front.
   *
   * The whole tab is mounted at boot and merely hidden with a class, so this
   * component runs once and its snapshot would otherwise freeze at whatever had
   * been measured by the time boot finished: the table showed the five project
   * loads and nothing that happened afterwards, however much the app was used.
   *
   * Still no timer. Becoming visible is the moment the numbers are wanted, and
   * Refresh covers watching them move while sitting here.
   */
  createEffect(
    // Tracked: which tab is in front.
    () => state.activeKey,
    // Untracked: the refresh writes state, and doing that in the compute
    // re-arms the computation on its own write and never settles.
    (activeKey) => {
      if (activeKey === "settings") refresh();
    },
  );
  const ms = (value: number) =>
    value >= 1 ? `${value.toFixed(1)}ms` : `${(value * 1000).toFixed(0)}\u00b5s`;

  return (
    <Section
      id="settings-section-performance"
      icon="gauge"
      title={tx("Application internal performance")}
      hint={tx("what each part of the app costs, measured in this session")}
    >
      <Row
        label={tx("Measurements")}
        searchTerms={[tx("Refresh performance measurements"), tx("Reset performance measurements")]}
        hint={tx("since this window opened, or since the last reset")}
      >
        <Flex align="center" gap="sm">
          <span
            role="status"
            aria-label={tx("Performance refresh generation {count}", {
              count: refreshGeneration(),
            })}
            class="sr-only"
          >
            {tx("Performance refresh generation {count}", {
              count: refreshGeneration(),
            })}
          </span>
          <span
            role="status"
            aria-label={tx("Performance reset generation {count}", {
              count: resetGeneration(),
            })}
            class="sr-only"
          >
            {tx("Performance reset generation {count}", { count: resetGeneration() })}
          </span>
          <Button
            id="settings-performance-refresh"
            type="button"
            aria-label={tx("Refresh performance measurements")}
            class="az-ui-button-neutral"
            onClick={refresh}
          >
            {tx("Refresh")}
          </Button>
          <Button
            id="settings-performance-reset"
            type="button"
            aria-label={tx("Reset performance measurements")}
            class="az-ui-button-neutral"
            onClick={() => {
              perfReset();
              setResetGeneration((generation) => generation + 1);
              refresh();
            }}
          >
            {tx("Reset")}
          </Button>
        </Flex>
      </Row>
      {/*
        Stacked: a full-width table beside a `flex-1` label squeezes the label to
        min-content, and the hint then wraps one letter per line.
      */}
      <Row label={tx("Timings")} hint={tx("worst total first")} stack isLast>
        <Show
          when={table().entries.length > 0}
          fallback={<span class="text-az-muted text-ui-detail">{tx("Nothing measured yet")}</span>}
        >
          <div class="az-scroll max-h-[320px] w-full min-w-0 overflow-y-auto">
            <table class="w-full text-ui-detail tabular-nums">
              <thead class="text-az-muted">
                <tr>
                  <th class="py-1 text-left font-normal">{"What"}</th>
                  <th class="py-1 text-right font-normal">{"n"}</th>
                  <th class="py-1 text-right font-normal">{"avg"}</th>
                  <th class="py-1 text-right font-normal">{"min"}</th>
                  <th class="py-1 text-right font-normal">{"max"}</th>
                  <th class="py-1 text-right font-normal">{"last"}</th>
                </tr>
              </thead>
              <tbody>
                <For each={table().entries}>
                  {(entry) => (
                    <tr class="border-az-hairline-soft border-t">
                      <td class="max-w-[220px] truncate py-1 pr-2 text-az-body" title={entry.name}>
                        {entry.name}
                      </td>
                      <td class="py-1 pl-2 text-right text-az-muted">{entry.count}</td>
                      <td class="py-1 pl-2 text-right text-az-strong">
                        {ms(entry.total / entry.count)}
                      </td>
                      <td class="py-1 pl-2 text-right text-az-muted">{ms(entry.min)}</td>
                      <td class="py-1 pl-2 text-right text-az-muted">{ms(entry.max)}</td>
                      <td class="py-1 pl-2 text-right text-az-muted">{ms(entry.last)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Row>
    </Section>
  );
}

function Section(props: {
  /** Stable, unique inspection and QA address for this settings surface. */
  id: string;
  icon: IconProps["name"];
  title: string;
  hint: string;
  /** Accessible descendant names that can admit a lazily mounted section. */
  searchTerms?: readonly string[];
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
  // Claim a slot in mount order. Stable for the life of the component, so a
  // section never gives its place back and cannot flicker out once shown.
  const ordinal = settingsMounted++;
  let shell: HTMLDivElement | undefined;
  /*
   * Mounted once it has been reached, and never unmounted after.
   *
   * Seventeen sections and around four thousand nodes were built in the commit
   * that opened the tab, while about three of them fit on screen. Staggering
   * that over several ticks moved the cost around without removing it. This
   * removes it: a section off the bottom of the page is not built until the
   * reader approaches it.
   */
  const titleMatches = createMemo(() =>
    matchesSearch(
      [props.title, props.hint, props.pending ?? "", ...(props.searchTerms ?? [])].join(" "),
    ),
  );
  const [mounted, setMounted] = createSignal(ordinal < settingsBudget());
  createEffect(
    () => ordinal < settingsBudget() || (settingsQuery().trim() !== "" && titleMatches()),
    (admitted) => {
      if (admitted) setMounted(true);
    },
  );
  onSettled(() => {
    if (!shell) return;
    const scroller = shell.closest(".az-scroll");
    if (!scroller) {
      // No scroll container to measure against, so build rather than risk a
      // section that can never appear.
      admitSection(ordinal);
      return;
    }
    const check = (): void => {
      if (mounted() || !shell) return;
      const top = shell.getBoundingClientRect().top;
      const limit = scroller.getBoundingClientRect().bottom + SETTINGS_PREBUILD_PX;
      if (top <= limit) admitSection(ordinal);
    };
    check();
    scroller.addEventListener("scroll", check, { passive: true });
    // Returned, not `onCleanup`: Solid 2 forbids it inside `onSettled`.
    return () => scroller.removeEventListener("scroll", check);
  });
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
    <SearchScope value={{ titleMatches, report }}>
      <Panel
        ref={shell}
        id={props.id}
        class={`flex-none rounded-[13px] ${visible() ? "" : "hidden"}`}
      >
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-3.5 pt-3 pb-2.5">
          <Icon name={props.icon} class="relative top-0.5 text-primary text-ui-control" />
          <h2
            class={`font-semibold text-ui-body ${props.pending ? "text-az-muted" : "text-az-title"}`}
          >
            {props.title}
          </h2>
          <span class="text-az-muted text-ui-detail">{props.hint}</span>
          <Show when={props.pending}>
            {(reason) => (
              <span class="ml-auto shrink-0 rounded border border-az-hairline px-1.5 py-px text-az-muted text-ui-tiny">
                {tx("not wired ·")} {reason()}
              </span>
            )}
          </Show>
        </div>
        <div>
          {/*
            Wired sections mount once admitted and remain mounted. Pending
            sections stop at their explicit header instead of constructing a
            dead control tree that slows every global theme/language update.
          */}
          <Show when={mounted() && !props.pending}>{props.children}</Show>
        </div>
      </Panel>
    </SearchScope>
  );
}

function Row(props: {
  label: string;
  hint?: string;
  /** Accessible child names that should reveal this row through Settings search. */
  searchTerms?: readonly string[];
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
  const hit = createMemo(() =>
    matchesSearch([props.label, props.hint ?? "", ...(props.searchTerms ?? [])].join(" ")),
  );
  // Reported rather than read: only the row knows its own words, and the
  // section needs to know whether any of them answered the search.
  createEffect(
    // Tracked: whether this row's words answer the query.
    () => hit(),
    // Untracked: reporting writes into the section, and a write in the compute
    // re-arms the computation on its own write.
    (matched) => scope?.report(props.label, matched),
  );
  onCleanup(() => scope?.report(props.label, false));
  // A section named by the query shows all of its rows: someone searching
  // "cost" wants the section, not the one row whose label repeats the word.
  const visible = () => settingsQuery().trim() === "" || scope?.titleMatches() === true || hit();

  return (
    <div
      class={`px-3.5 py-2.5 ${visible() ? "" : "hidden"} ${props.isLast ? "" : "border-az-hairline-soft border-b"} ${
        props.stack ? "flex flex-col gap-2" : "flex items-center gap-3"
      }`}
    >
      <span class={`text-az-body text-ui-label-lg ${props.stack ? "" : "min-w-0 flex-1"}`}>
        {props.label}
        <Show when={props.hint}>
          <span class="mt-0.5 block break-words text-az-muted text-ui-detail">{props.hint}</span>
        </Show>
      </span>
      {props.children}
    </div>
  );
}

/** How long the knob must be still before its value is written to the store. */
const SETTLE_MS = 180;

/**
 * One glass axis measured in plain percent, written straight to a custom
 * property.
 *
 * Separate from `GlassTuningAxis` because these two are not the library's.
 * Opacity overrides one token the library derives from refraction, and scrim is
 * AgencyZero's own, so neither wants the twenty-five-token re-derivation that
 * component performs on every frame of a drag.
 *
 * The `live` signal is the same lesson that component records: the persist
 * waits for the drag to settle, so binding the thumb to the stored value alone
 * left it snapping back under the pointer and made arrow keys do nothing. The
 * audit test in this folder refuses to ship a slider that cannot move.
 */
function GlassPercentAxis(props: {
  id: string;
  label: string;
  max: number;
  value: number;
  property: string;
  /**
   * The other custom properties this axis moves, keyed by name.
   *
   * `writeGlassTuning` derives several tokens from one slider, and a drag that
   * paints fewer of them than the persist does changes the window's appearance
   * at the moment of release rather than at the moment of the move.
   */
  sideEffects?: Record<string, (value: number) => string>;
  onChange: (value: number) => void | Promise<void>;
}): JSX.Element {
  const [live, setLive] = createSignal<number | undefined>();
  const shown = (): number => live() ?? props.value;

  // Once the store reports the value the drag ended on, the local hold has
  // nothing left to say and steps aside. Solid 2 splits `createEffect` into a
  // tracked read and an untracked write, so the release happens in the second
  // argument rather than inside the tracking scope.
  createEffect(
    () => [live(), props.value] as const,
    ([held, stored]) => {
      if (held === stored) setLive(undefined);
    },
  );

  return (
    <div class="min-w-[260px]">
      <Slider
        id={props.id}
        label={props.label}
        min={0}
        max={props.max}
        step={1}
        value={shown()}
        formatValue={(value) => `${Math.round(value)}%`}
        // Paint immediately so the surface answers the drag, persist on
        // release. One custom property, so unlike the library's axes there is
        // nothing to re-derive.
        /*
          Paint everything the persist paints, or the release changes the look.

          This wrote one custom property while `writeGlassTuning` writes three
          from the same number: the panel film, the desk alpha that `body` and
          `.az-desk` take, and the control tint. So a drag moved the panels and
          left the desk alone, and letting go jumped the whole window to a
          different appearance at the value that was already on screen.

          Reported four times as "what it shows me and when I release differ",
          and the number was never wrong - only the set of surfaces answering
          it. `sideEffects` names the rest so the two paths cannot drift again.
        */
        onChange={(value) => {
          setLive(value);
          const root = document.documentElement;
          root.style.setProperty(props.property, `${value}%`);
          for (const [name, of] of Object.entries(props.sideEffects ?? {})) {
            root.style.setProperty(name, of(value));
          }
        }}
        // `live` is held, not cleared. The persist is a round trip through the
        // store, so clearing on release showed the *old* number for the ~60ms
        // it takes to land: the thumb visibly snapped back and then forward.
        // Releasing it once the stored value agrees keeps the control steady
        // and still lets an external change move the thumb afterwards.
        onChangeEnd={(value) => {
          setLive(value);
          void props.onChange(value);
        }}
        size="sm"
        class="w-full min-w-0 [&_[data-slot=label]]:sr-only"
      />
    </div>
  );
}

/**
 * Which settings field carries each of the library's three glass numbers.
 *
 * Three of them rather than every axis `GlassTuning` has. The library gained a
 * fourth, `controlTint`, which decides how much of the film its *controls* take
 * as opposed to its surfaces. That is a theme-authoring decision - a switch or
 * a select trigger that goes translucent reads as disabled - and not a thing
 * this pane offers a slider for, so it stays at the library's opaque default.
 *
 * Keyed off this object rather than off `keyof GlassTuning` for that reason: a
 * new axis in the library should not silently become a fourth slider here, nor
 * break this file for being absent.
 */
const GLASS_SETTING_KEYS = {
  blur: "glassBlur",
  refraction: "glassRefraction",
  depth: "glassDepth",
} as const satisfies Partial<Record<keyof GlassTuning, keyof ThemeSettings>>;

/** An axis this pane actually puts a slider on. */
type GlassSliderAxis = keyof typeof GLASS_SETTING_KEYS;

/**
 * One of the three glass numbers.
 *
 * Hands `blur`/`refraction`/`depth` to `@pathscale/ui`, which derives
 * twenty-five `--glass-*` tokens from the three together, and to `panelAxes`,
 * which derives AgencyZero's own opaque panel from the same three. A preview
 * therefore has to re-derive the whole set from the other two axes as they
 * stand rather than writing one property.
 *
 * Range and default both come from the library rather than being restated here.
 * That is the point of the exercise: glass is the library's primitive, so an
 * app that hardcoded `max={0.4}` would be a second place to update when the
 * curves are retuned.
 *
 * Dragging paints immediately and persists once, when the knob is released. It
 * used to call `saveSettings` on every tick, and each of those awaited a
 * serialized store write before it even applied the CSS, then made a native
 * window call: one session's log held 75 `set_settings` and 76
 * `set_window_chrome` round trips at 7 and 6ms, all on the window thread. That
 * is why the knob led and the panel lagged, and why dragging depth could starve
 * paint until the window went blank and only recovered once the drag stopped.
 *
 * A 180ms debounce replaced that and was a large improvement, but not a cure:
 * a debounce fires whenever the pointer pauses, so a slow drag is still a
 * stream of store writes. The live/settled split is the slider's own now
 * (`onChange` paints, `onChangeEnd` persists), so there is no timer here.
 */
function GlassTuningAxis(props: {
  id: string;
  label: string;
  axis: GlassSliderAxis;
  step: number;
  /** Undefined means "whatever the library defaults this axis to". */
  value: number | undefined;
  /** The theme these three axes live on, for re-deriving the whole set. */
  theme: ThemeSettings;
  format: (value: number) => string;
  /**
   * Persist the axis. Returning the write's promise keeps the thumb under the
   * pointer until it lands; returning nothing settles immediately, which is
   * only right for a caller that persists synchronously.
   */
  onChange: (value: number) => void | Promise<void>;
}): JSX.Element {
  const mode = (): GlassMode =>
    document.documentElement.dataset.colorMode === "light" ? "light" : "dark";
  const resolved = (axis: GlassSliderAxis): number => {
    const value = props.theme[GLASS_SETTING_KEYS[axis]];
    return Number.isFinite(value) ? Number(value) : GLASS_DEFAULTS[mode()][axis];
  };
  /*
   * The library's range, narrowed for blur.
   *
   * Its 50px maximum reaches 150px, and two glass panels can share a render
   * pass only when neither blur can read a pixel the other painted. Offering a
   * radius the app then clamps would be a slider that lies, so the track stops
   * where `glassTuning` stops. See `MAX_GLASS_BLUR`.
   */
  const limits = () => {
    const limits = GLASS_LIMITS[props.axis];
    return props.axis === "blur"
      ? { min: limits.min, max: Math.min(limits.max, MAX_GLASS_BLUR) }
      : limits;
  };

  /*
   * The value the track shows while it is being moved.
   *
   * `value` is the persisted setting, and the persist deliberately waits for
   * the drag to settle. Binding the thumb straight to it meant the control
   * could not move until release: every `onChange` painted CSS and then
   * re-rendered the slider at the *old* number, so the thumb snapped back
   * under the pointer and arrow keys did nothing at all. A slider whose value
   * never changes is the bug this file's audit test now refuses to ship.
   *
   * `undefined` means "not being touched", so the persisted value shows
   * through and an external change still moves the thumb.
   */
  const [live, setLive] = createSignal<number | undefined>();
  const shown = (): number => live() ?? props.value ?? GLASS_DEFAULTS[mode()][props.axis];

  return (
    <div class="min-w-[260px]">
      <Slider
        id={props.id}
        label={props.label}
        min={limits().min}
        max={limits().max}
        step={props.step}
        value={shown()}
        formatValue={props.format}
        // Paint now, from the full set: one axis alone does not describe glass,
        // and a partial tuning leaves three tokens the component CSS reads
        // without a fallback undefined, which drops the declaration entirely.
        onChange={(value) => {
          setLive(value);
          const tuning: GlassTuning = {
            blur: resolved("blur"),
            refraction: resolved("refraction"),
            depth: resolved("depth"),
            [props.axis]: value,
          };
          applyGlassTokens(tuning, mode());
          /*
           * Put back the two tokens this app owns, which `applyGlassTokens`
           * has just overwritten.
           *
           * The library derives `--glass-background-opacity` from refraction,
           * and on a dark surface that curve lands near 5%. This app writes its
           * own value there from a separate slider precisely because 5% is a
           * film nobody can see. So every frame of a blur, refraction or depth
           * drag reset the *opacity* to the library's number, and releasing the
           * knob - which persists and re-runs `writeGlassTuning` - put the
           * app's number back. The surface visibly changed twice during a drag
           * of an axis that has nothing to do with it.
           *
           * Reported repeatedly as the slider showing one thing while dragging
           * and another on release, and it survived a first fix because that
           * one addressed the percentage sliders and this is the other family.
           */
          const opacity = props.theme.glassOpacity ?? DEFAULT_GLASS_OPACITY;
          if (Number.isFinite(opacity)) {
            const root = document.documentElement;
            const film = Math.min(Math.max(Number(opacity), 0), 100);
            root.style.setProperty("--glass-background-opacity", `${Number(opacity)}%`);
            root.style.setProperty("--az-glass-alpha", `${Math.round(film)}%`);
            root.style.setProperty(
              "--glass-control-opacity",
              `${Math.round(100 - (100 - film) * 0.33)}%`,
            );
          }
          // The panel is derived from the same three numbers, so it has to be
          // repainted with them or it lags a drag by one settle.
          writePanelAxes(tuning);
        }}
        onChangeEnd={(value) => {
          // Hand the number back to the store, and keep overriding until the
          // write lands. `onChange` persists asynchronously, so clearing the
          // override here dropped `shown()` back onto the *old* persisted
          // value for the length of the round trip: the thumb snapped back to
          // where the drag started and then jumped forward when the save
          // arrived. Same snap-back the drag path fixed above, at the release
          // edge instead.
          setLive(value);
          void Promise.resolve(props.onChange(value)).finally(() => {
            // Only stop overriding if no later drag has taken over, or a
            // settling save would yank the thumb out from under the pointer.
            setLive((current) => (current === value ? undefined : current));
          });
        }}
        size="sm"
        class="w-full min-w-0 [&_[data-slot=label]]:sr-only"
      />
    </div>
  );
}

/** The manual snapshot button, beside Backups. */
function StoreSnapshotControl(): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal("");
  const [failed, setFailed] = createSignal(false);
  const [generation, setGeneration] = createSignal(0);
  const alive = whileMounted();

  const take = (): void => {
    setBusy(true);
    setFailed(false);
    setNote("");
    void actions
      .createStoreSnapshot()
      .then(
        alive((name) => {
          setNote(tx("Written to {name}", { name }));
          setGeneration((value) => value + 1);
        }),
      )
      .catch(
        alive((cause) => {
          setFailed(true);
          setNote(describeError(cause));
        }),
      )
      .finally(
        alive(() => {
          setBusy(false);
        }),
      );
  };

  return (
    <div class="flex max-w-[390px] flex-col items-end gap-1.5">
      <span role="status" aria-label={`Snapshot generation ${generation()}`} class="sr-only" />
      <Show when={note()}>
        <span
          role={failed() ? "alert" : "status"}
          class={`text-right text-ui-caption-sm ${failed() ? "text-error" : "text-success"}`}
        >
          {note()}
        </span>
      </Show>
      <Button
        id="settings-store-snapshot"
        type="button"
        disabled={busy() || !isLive("createStoreSnapshot")}
        onClick={take}
        class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-az-muted text-ui-label transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy() ? tx("Taking snapshot…") : tx("Take snapshot")}
      </Button>
    </div>
  );
}

function SettingToggle(props: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <Switch
      id={props.id}
      aria-label={props.label}
      checked={props.checked}
      disabled={props.disabled}
      flavor="accent"
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
      <span class="w-[88px] shrink-0 font-semibold text-az-strong text-ui-label-lg">
        {AGENT_LABELS[props.status.agent]}
      </span>
      <span class="shrink-0 font-mono text-az-muted text-ui-detail">
        {props.status.version ?? "—"}
      </span>
      <span class={`min-w-0 flex-1 text-ui-detail ${STATE_TONE[props.status.state]}`}>
        {detail()}
      </span>
      <span class="flex shrink-0 gap-[5px]">
        <For each={props.status.caps}>
          {(cap) => (
            <span class="rounded-full border border-primary/25 bg-az-chip px-[7px] py-0.5 font-mono text-primary/85 text-ui-caption-sm">
              {cap}
            </span>
          )}
        </For>
      </span>
    </div>
  );
}

function HoldRow(props: {
  id: string;
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
        class={`shrink-0 rounded-md px-2 py-0.5 font-bold text-ui-caption ${
          props.tone === "warning" ? "bg-warning/20 text-warning" : "bg-error/20 text-error"
        }`}
      >
        {props.severity}
      </span>
      <span class="flex-1 text-az-body text-ui-label leading-[1.5]">{props.description}</span>
      <SettingToggle
        id={props.id}
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
        <span class="font-semibold text-az-title text-ui-body">{AGENT_LABELS[agent()]}</span>
        <span class="text-az-muted text-ui-detail">{tx(AGENT_USE[agent()])}</span>
        <span class="ml-auto text-az-muted text-ui-caption tabular-nums">
          {props.selection.enabled.length} {tx("of")} {props.catalogue.models.length}
        </span>
      </div>
      <p class="px-3.5 pb-2 text-az-muted text-ui-caption">
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
      <Checkbox
        id={`settings-model-${props.agent}-${encodeURIComponent(props.model.id)}-offer`}
        class="shrink-0"
        title={props.isLastEnabled ? tx("The last enabled model cannot be removed") : undefined}
        checked={props.isEnabled}
        state={props.isLastEnabled ? "disabled" : undefined}
        aria-label={tx("Offer {name}", { name: props.model.name })}
        onChange={(event) =>
          void actions.toggleModel(props.agent, props.model.id, event.currentTarget.checked)
        }
      />

      <div class="flex min-w-0 flex-1 flex-col leading-tight">
        <span class="flex items-baseline gap-1.5">
          <span class="truncate text-az-body text-ui-label-lg">{props.model.name}</span>
          <span class="truncate font-mono text-az-muted text-ui-caption-sm">{props.model.id}</span>
          <Show when={props.model.kind === "alias"}>
            <span class="shrink-0 rounded border border-az-hairline px-1 text-az-muted text-ui-micro uppercase tracking-[.04em]">
              {tx("alias")}
            </span>
          </Show>
        </span>
        <Show when={props.model.note}>
          <span class="truncate text-az-muted text-ui-caption">{props.model.note}</span>
        </Show>
      </div>

      <Show
        when={!props.isDefault}
        fallback={
          <span class="shrink-0 rounded border border-primary px-1.5 py-px text-primary text-ui-tiny">
            {tx("default")}
          </span>
        }
      >
        <Button
          id={`settings-model-${props.agent}-${encodeURIComponent(props.model.id)}-default`}
          type="button"
          onClick={() => void actions.setDefaultModel(props.agent, props.model.id)}
          aria-label={tx("Make {name} the default", { name: props.model.name })}
          class="shrink-0 rounded border border-az-hairline-strong px-1.5 py-px text-az-muted text-ui-tiny opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
        >
          {tx("make default")}
        </Button>
      </Show>
    </div>
  );
}
