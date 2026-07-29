import { Toggle } from "@pathscale/ui";
import { For, type JSX, Show } from "solid-js";
import { Icon, type IconProps } from "~/components/Icon";
import { Panel } from "~/components/Panel";
import { PillMenu } from "~/components/PillMenu";
import { AgentStateDot } from "~/components/StatusDot";
import { relativeTime } from "~/lib/format";
import {
  AGENT_LABELS,
  AGENT_STATE_LABELS,
  ENV_POLICY_LABELS,
  PERMISSION_LABELS,
  PERMISSION_ORDER,
} from "~/lib/labels";
import { useWorkspace } from "~/stores/workspace";
import type {
  Agent,
  AgentModels,
  AgentState,
  AgentStatus,
  EnvPolicy,
  Model,
  ModelSelection,
  ModelSource,
  Permission,
} from "~/types";

const STATE_TONE: Record<AgentState, string> = {
  connected: "text-success",
  outdated: "text-warning",
  logged_out: "text-error",
  missing: "text-az-muted",
};

/** Weakest evidence behind a catalogue, phrased for someone deciding whether to trust it. */
const SOURCE_LABELS: Record<ModelSource, string> = {
  cli: "reported by the CLI",
  picker: "read from the interactive picker",
  docs: "from vendor documentation",
};

/**
 * What each agent's selection is currently wired to.
 *
 * Only Claude reaches the prompt today. Codex and Copilot are collected now so
 * the code review UI has a selection to open with rather than a blank one.
 */
const AGENT_USE: Record<Agent, string> = {
  claude: "used by the prompt",
  codex: "for the code review UI",
  copilot: "for the code review UI",
};

/**
 * Global settings, opened by the gear as a real tab you can leave open.
 *
 * Real controls only — detected agent status, the defaults a new tab starts
 * from, the moderator, notifications, and what the agent process inherits from
 * this machine. Changes save as you make them; there is no Save button because
 * there is nothing to batch.
 */
export function SettingsTab(): JSX.Element {
  const { state, actions, isLive } = useWorkspace();
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
  const enabledModels = (agent: Agent): Model[] => {
    const catalogue = state.models.find((entry) => entry.agent === agent);
    const selection = state.settings?.models[agent];
    if (!catalogue || !selection) return [];
    return catalogue.models.filter((model) => selection.enabled.includes(model.id));
  };

  return (
    <div class="az-scroll flex min-w-0 flex-1 justify-center rounded-panel border border-az-hairline bg-[oklch(13%_0.004_240)]">
      <div class="flex w-full max-w-[720px] flex-col gap-3 px-6 pt-5.5 pb-7">
        <div class="flex items-baseline gap-2.5 pb-0.5">
          <h1 class="font-semibold text-[18px] text-az-title tracking-[-.01em]">Settings</h1>
          <span class="text-[11.5px] text-az-muted">
            defaults for every new tab · each project can override
          </span>
        </div>

        <Show when={settings()}>
          {(current) => (
            <>
              <Section
                icon="shield"
                title="Agents"
                hint="detected from the installed CLIs, not from configuration"
              >
                <For each={state.agents}>{(agent) => <AgentRow status={agent} />}</For>
                <div class="flex items-center gap-2.5 px-3.5 pt-0 pb-3">
                  <button
                    type="button"
                    onClick={() => void actions.recheckAgents()}
                    class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary"
                  >
                    Re-check
                  </button>
                  <Show when={state.agents[0]}>
                    {(first) => (
                      <span class="text-[11.5px] text-az-muted">
                        last checked {relativeTime(first().checkedAt)}
                      </span>
                    )}
                  </Show>
                </div>
              </Section>

              <Section icon="sparkles" title="Agent defaults" hint="what a new tab starts with">
                <Row label="Agent">
                  <PillMenu<Agent>
                    label="Default agent"
                    icon="sparkles"
                    value={current().defaultAgent}
                    // Only agents that report connected can be picked.
                    options={state.agents
                      .filter((agent) => agent.state === "connected")
                      .map((agent) => ({ value: agent.agent, label: AGENT_LABELS[agent.agent] }))}
                    onChange={(defaultAgent) => void actions.saveSettings({ defaultAgent })}
                  />
                </Row>
                <Row label="Model" hint="chosen from what Models below has enabled">
                  <PillMenu
                    label="Default model"
                    value={current().models[current().defaultAgent].default}
                    options={enabledModels(current().defaultAgent).map((model) => ({
                      value: model.id,
                      label: model.name,
                    }))}
                    onChange={(id) => void actions.setDefaultModel(current().defaultAgent, id)}
                  />
                </Row>
                <Row
                  label="Permission posture"
                  hint="read_only is the crate default; widen deliberately"
                  isLast
                >
                  <PillMenu<Permission>
                    label="Default permission"
                    icon="lock"
                    value={current().defaultPermission}
                    options={PERMISSION_ORDER.map((permission) => ({
                      value: permission,
                      label: PERMISSION_LABELS[permission],
                    }))}
                    onChange={(defaultPermission) =>
                      void actions.saveSettings({ defaultPermission })
                    }
                  />
                </Row>
              </Section>

              <Section icon="sliders-horizontal" title="Models" hint="what each picker offers">
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
                    Re-read from the CLIs
                  </button>
                  <span class="text-[11.5px] text-az-muted">
                    only Codex can enumerate; the other two stay on the compiled list
                  </span>
                </div>
              </Section>

              <Section
                icon="folder"
                title="Data"
                hint="where projects, items and messages are stored"
              >
                <Show when={state.dataLocation}>
                  {(location) => (
                    <>
                      <Row
                        label="Location"
                        hint={
                          location().source === "env"
                            ? "set by AZ_DATA_DIR, which a saved path cannot override"
                            : "a change takes effect on the next launch; nothing is moved"
                        }
                      >
                        <span class="max-w-[340px] truncate font-mono text-[11.5px] text-az-body">
                          {location().path}
                        </span>
                      </Row>
                      <Row label="Change it" isLast>
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={!location().isEditable}
                            onClick={() => {
                              const next = window.prompt(
                                "Data directory for the next launch",
                                location().path,
                              );
                              if (next?.trim()) void actions.setDataLocation(next.trim());
                            }}
                            class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Choose…
                          </button>
                          <button
                            type="button"
                            disabled={!location().isEditable || location().source === "default"}
                            onClick={() => void actions.setDataLocation(null)}
                            class="rounded-lg border border-az-hairline-strong px-3 py-[5px] text-[12px] text-az-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Use the default
                          </button>
                        </div>
                      </Row>
                    </>
                  )}
                </Show>
              </Section>

              <Section
                icon="shield"
                title="Moderator"
                hint="a second agent watching the stream — costs tokens"
                pending={moderatorPending()}
              >
                <Row
                  label="Enabled by default"
                  hint="each session can turn it off in its Settings section"
                >
                  <SettingToggle
                    label="Moderator enabled by default"
                    checked={current().moderator.enabled}
                    onChange={(enabled) => void actions.saveSettings({ moderator: { enabled } })}
                  />
                </Row>
                <Row label="Moderator model">
                  <PillMenu
                    label="Moderator model"
                    value={current().moderator.model}
                    options={enabledModels("claude").map((model) => ({
                      value: model.id,
                      label: model.name,
                    }))}
                    onChange={(model) => void actions.saveSettings({ moderator: { model } })}
                  />
                </Row>
                <Row label="Confine tool calls to the working directories">
                  <SettingToggle
                    label="Confine tool calls to the working directories"
                    checked={current().moderator.confineToDirs}
                    onChange={(confineToDirs) =>
                      void actions.saveSettings({ moderator: { confineToDirs } })
                    }
                  />
                </Row>

                <div class="flex flex-col gap-2.5 px-3.5 py-3">
                  <span class="font-semibold text-[11.5px] text-az-muted uppercase tracking-[.04em]">
                    On a hold
                  </span>

                  <HoldRow
                    severity="CHECK"
                    tone="warning"
                    description="The step waits on you; everything else keeps running. Tab dot goes amber."
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
                    description="Cancel the run and its whole process group, then wait. Tab dot goes red."
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
                title="Notifications"
                hint="while you are in another window"
                pending={runPathPending()}
              >
                <Row label="A hold needs your approval">
                  <SettingToggle
                    label="Notify on a hold"
                    checked={current().notifications.onHold}
                    onChange={(onHold) => void actions.saveSettings({ notifications: { onHold } })}
                  />
                </Row>
                <Row label="A run finishes">
                  <SettingToggle
                    label="Notify when a run finishes"
                    checked={current().notifications.onRunFinished}
                    onChange={(onRunFinished) =>
                      void actions.saveSettings({ notifications: { onRunFinished } })
                    }
                  />
                </Row>
                <Row label="A task fails">
                  <SettingToggle
                    label="Notify when a task fails"
                    checked={current().notifications.onTaskFailed}
                    onChange={(onTaskFailed) =>
                      void actions.saveSettings({ notifications: { onTaskFailed } })
                    }
                  />
                </Row>
                <Row label="Rate limited by the provider">
                  <SettingToggle
                    label="Notify when rate limited"
                    checked={current().notifications.onRateLimited}
                    onChange={(onRateLimited) =>
                      void actions.saveSettings({ notifications: { onRateLimited } })
                    }
                  />
                </Row>
                <Row label="Play a sound" isLast>
                  <SettingToggle
                    label="Play a sound"
                    checked={current().notifications.sound}
                    onChange={(sound) => void actions.saveSettings({ notifications: { sound } })}
                  />
                </Row>
              </Section>

              <Section
                icon="lock"
                title="Environment"
                pending={runPathPending()}
                hint="what the agent process inherits from this machine"
              >
                <Row
                  label="Environment policy"
                  hint="Minimal passes only PATH, HOME and USER — the verified floor for all three CLIs"
                >
                  <PillMenu<EnvPolicy>
                    label="Environment policy"
                    value={current().envPolicy}
                    options={(["minimal", "inherit"] as const).map((policy) => ({
                      value: policy,
                      label: ENV_POLICY_LABELS[policy],
                    }))}
                    onChange={(envPolicy) => void actions.saveSettings({ envPolicy })}
                  />
                </Row>
                <Row
                  label="Forward proxy and custom-CA variables"
                  hint="off by default: HTTPS_PROXY often embeds credentials"
                  isLast
                >
                  <SettingToggle
                    label="Forward proxy and custom-CA variables"
                    checked={current().forwardProxyVars}
                    onChange={(forwardProxyVars) => void actions.saveSettings({ forwardProxyVars })}
                  />
                </Row>
              </Section>

              <p class="flex gap-2 text-[11.5px] text-az-muted leading-[1.5]">
                <Icon name="info" class="relative top-0.5 shrink-0 text-[13px]" />
                <span>
                  Sessions are stored per project by agent-abstraction at{" "}
                  <code class="font-mono">&lt;dir&gt;/&lt;project-slug&gt;/&lt;name&gt;.json</code>.
                </span>
              </p>
            </>
          )}
        </Show>
      </div>
    </div>
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
  return (
    <Panel class="flex-none rounded-[13px]">
      <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-3.5 pt-3 pb-2.5">
        <Icon name={props.icon} class="relative top-0.5 text-[14px] text-az-muted" />
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
              not wired · {reason()}
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
  );
}

function Row(props: {
  label: string;
  hint?: string;
  isLast?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      class={`flex items-center gap-3 px-3.5 py-2.5 ${props.isLast ? "" : "border-az-hairline-soft border-b"}`}
    >
      <span class="min-w-0 flex-1 text-[12.5px] text-az-body">
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
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <Toggle
      aria-label={props.label}
      checked={props.checked}
      color="accent"
      class="shrink-0"
      onChange={(event) => props.onChange(event.currentTarget.checked)}
    />
  );
}

function AgentRow(props: { status: AgentStatus }): JSX.Element {
  const detail = () => {
    if (props.status.state === "outdated") {
      return `${AGENT_STATE_LABELS.outdated} · needs ${props.status.minVersion}+`;
    }
    return AGENT_STATE_LABELS[props.status.state];
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
            <span class="rounded-full border border-white/10 bg-base-300 px-[7px] py-0.5 font-mono text-[10.5px] text-az-muted">
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
        <span class="text-[11.5px] text-az-muted">{AGENT_USE[agent()]}</span>
        <span class="ml-auto text-[11px] text-az-muted tabular-nums">
          {props.selection.enabled.length} of {props.catalogue.models.length}
        </span>
      </div>
      <p class="px-3.5 pb-2 text-[11px] text-az-muted">
        {props.catalogue.discovered ? "asked just now" : SOURCE_LABELS[props.catalogue.source]} ·
        checked {props.catalogue.checked} against {props.catalogue.against}
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
    <div class="group flex items-center gap-2.5 px-3.5 py-[3px] transition-colors hover:bg-[oklch(17%_0.006_240)]">
      {/*
        A real checkbox rather than a styled button: this is a set of choices,
        and screen readers should hear it as one. The input carries the state and
        the keyboard behaviour; the span beside it is the visible box.
      */}
      <label
        class="shrink-0 cursor-pointer"
        title={props.isLastEnabled ? "The last enabled model cannot be removed" : undefined}
      >
        <input
          type="checkbox"
          class="peer sr-only"
          checked={props.isEnabled}
          disabled={props.isLastEnabled}
          aria-label={`Offer ${props.model.name}`}
          onChange={(event) =>
            void actions.toggleModel(props.agent, props.model.id, event.currentTarget.checked)
          }
        />
        <span
          aria-hidden="true"
          class="flex size-[15px] items-center justify-center rounded border transition-colors peer-focus-visible:ring-1 peer-focus-visible:ring-primary peer-disabled:opacity-40"
          classList={{
            "border-primary bg-primary text-[oklch(13%_0.004_240)]": props.isEnabled,
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
              alias
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
            default
          </span>
        }
      >
        <button
          type="button"
          onClick={() => void actions.setDefaultModel(props.agent, props.model.id)}
          aria-label={`Make ${props.model.name} the default`}
          class="shrink-0 rounded border border-az-hairline-strong px-1.5 py-px text-[10px] text-az-muted opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
        >
          make default
        </button>
      </Show>
    </div>
  );
}
