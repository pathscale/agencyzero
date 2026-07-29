import { createMemo, type JSX, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { Panel } from "~/components/Panel";
import { Composer } from "~/features/project/Composer";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { TranscriptPane } from "~/features/project/TranscriptPane";
import { clockTime, usageLabel } from "~/lib/format";
import { AGENT_LABELS } from "~/lib/labels";
import { useWorkspace } from "~/stores/workspace";
import type { Project, Tab } from "~/types";

/**
 * A project tab: the conversation on the left, the accordion on the right.
 *
 * The header carries whatever is true of the whole tab right now — a rate
 * limit, in the provider's own wording — so it is visible without reading back
 * through the transcript.
 */
export function ProjectTab(props: { tab: Tab; project: Project }): JSX.Element {
  const { state, actions, promptModels, effortsFor } = useWorkspace();

  const messages = () => state.messages[props.project.id] ?? [];

  /*
   * The agent that actually ran, not a hardcoded name: the last message that
   * recorded one, falling back to the configured default. Settings can select
   * Codex or Copilot, and a header that always said "Claude" would be lying.
   */
  const agent = () =>
    [...messages()].reverse().find((message) => message.author === "agent")?.agent ??
    state.settings?.defaultAgent ??
    "claude";
  const running = () => state.running[props.project.id] ?? [];
  const rateLimit = () => state.rateLimits[props.project.id];

  /** The composer reports the most recent usage the agent actually gave us. */
  const usage = createMemo(() => {
    const withUsage = [...messages()].reverse().find((message) => message.usage);
    return usageLabel(withUsage?.usage ?? null);
  });

  return (
    <div class="flex min-h-0 min-w-0 flex-1 gap-3">
      <Panel class="relative flex min-w-0 flex-1 flex-col">
        <header class="flex flex-none items-center gap-3 border-az-hairline-soft border-b px-4 py-3">
          <Icon name="messages-square" class="text-[16px] text-az-muted" />
          <span class="truncate font-semibold text-[14.5px] text-az-title">
            {props.project.name}
          </span>
          <span class="shrink-0 rounded-full border border-az-hairline bg-base-300 px-2.5 py-0.5 font-mono text-[11px] text-az-muted">
            conversation · {AGENT_LABELS[agent()]}
          </span>

          <div class="flex-1" />

          <Show when={rateLimit()}>
            {(limit) => (
              <div class="mr-1.5 flex items-center gap-[7px] rounded-full border border-warning/34 bg-warning/15 px-2.5 py-1 text-[11.5px]">
                <Icon name="pause" class="text-[12px] text-warning" />
                <span class="font-semibold text-warning">{limit().message}</span>
                <Show when={clockTime(limit().resetsAt)}>
                  {(at) => <span class="text-az-body">· resets {at()}</span>}
                </Show>
              </div>
            )}
          </Show>

          <button
            type="button"
            aria-label="Project actions"
            class="flex size-7 items-center justify-center rounded-lg text-az-muted transition-colors hover:bg-white/6 hover:text-base-content"
          >
            <Icon name="ellipsis-vertical" class="text-[16px]" />
          </button>
        </header>

        <TranscriptPane project={props.project} messages={messages()} />

        <div class="flex flex-none flex-col gap-2.5 px-4 pt-2 pb-4">
          <Composer
            autofocus
            placeholder="Ask, or type / for commands…"
            model={props.tab.model}
            modelOptions={promptModels()}
            efforts={effortsFor(props.tab.model)}
            effort={props.tab.effort}
            permission={props.tab.permission}
            usage={usage()}
            isRunning={running().length > 0}
            onStop={() => void actions.cancelRun(props.project.id)}
            onModelChange={(model) =>
              actions.setTabModel(props.tab.key, model, props.tab.permission)
            }
            onPermissionChange={(permission) =>
              actions.setTabModel(props.tab.key, props.tab.model, permission)
            }
            onSend={(body) => actions.send(props.project.id, body)}
          />
        </div>
      </Panel>

      <ProjectPanel project={props.project} />
    </div>
  );
}
