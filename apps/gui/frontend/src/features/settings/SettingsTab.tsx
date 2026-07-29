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
  MODELS,
  PERMISSION_LABELS,
  PERMISSION_ORDER,
} from "~/lib/labels";
import { useWorkspace } from "~/stores/workspace";
import type { Agent, AgentState, AgentStatus, EnvPolicy, Permission } from "~/types";

const STATE_TONE: Record<AgentState, string> = {
  connected: "text-success",
  outdated: "text-warning",
  logged_out: "text-error",
  missing: "text-az-muted",
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
  const { state, actions } = useWorkspace();
  const settings = () => state.settings;

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
                <Row label="Model">
                  <PillMenu
                    label="Default model"
                    value={current().defaultModel}
                    options={MODELS.map((model) => ({ value: model, label: model }))}
                    onChange={(defaultModel) => void actions.saveSettings({ defaultModel })}
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

              <Section
                icon="shield"
                title="Moderator"
                hint="a second agent watching the stream — costs tokens"
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
                    options={MODELS.map((model) => ({ value: model, label: model }))}
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

              <Section icon="info" title="Notifications" hint="while you are in another window">
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
  children: JSX.Element;
}): JSX.Element {
  return (
    <Panel class="flex-none rounded-[13px]">
      <div class="flex items-baseline gap-2.5 px-3.5 pt-3 pb-2.5">
        <Icon name={props.icon} class="relative top-0.5 text-[14px] text-az-muted" />
        <h2 class="font-semibold text-[13px] text-az-title">{props.title}</h2>
        <span class="text-[11.5px] text-az-muted">{props.hint}</span>
      </div>
      {props.children}
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
