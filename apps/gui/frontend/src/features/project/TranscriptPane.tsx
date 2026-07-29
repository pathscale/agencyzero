import { EmptyState } from "@pathscale/ui";
import { createEffect, For, type JSX, Match, Show, Switch } from "solid-js";
import { Icon } from "~/components/Icon";
import { InlineText, MessageBody } from "~/features/project/MessageBody";
import { useWorkspace } from "~/stores/workspace";
import type { Message, Project } from "~/types";

const STARTERS = ["Review the GUI crate", "Wire the Solid frontend", "Audit the proxies"];

/**
 * The conversation. Three voices, three shapes:
 * you (a right-aligned bubble), the agent (plain prose), and the moderator
 * (an amber-ruled note that can be holding the run).
 */
export function TranscriptPane(props: { project: Project; messages: Message[] }): JSX.Element {
  const { actions } = useWorkspace();
  let scroller!: HTMLDivElement;

  // Follow the tail as messages arrive. Reading `.length` is what subscribes
  // this effect — the array identity alone would not change on an append.
  createEffect(() => {
    props.messages.length;
    queueMicrotask(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  });

  return (
    <div
      ref={scroller}
      class="az-scroll flex min-h-0 flex-1 flex-col gap-4 px-6 pt-5 pb-2 leading-relaxed"
    >
      <Show
        when={props.messages.length > 0}
        fallback={
          <EmptyTranscript
            projectId={props.project.id}
            onStart={(body) => void actions.send(props.project.id, body)}
          />
        }
      >
        <For each={props.messages}>
          {(message) => (
            <Switch>
              <Match when={message.author === "user"}>
                <UserBubble message={message} />
              </Match>
              <Match when={message.author === "moderator"}>
                <ModeratorNote message={message} />
              </Match>
              <Match when={message.author === "agent"}>
                <MessageBody
                  body={message.body}
                  class="text-[13.5px] text-az-body leading-[1.65]"
                />
              </Match>
            </Switch>
          )}
        </For>
      </Show>
    </div>
  );
}

function UserBubble(props: { message: Message }): JSX.Element {
  return (
    <div class="flex max-w-[76%] flex-col items-end gap-[7px] self-end">
      <div class="flex size-[26px] items-center justify-center rounded-lg border border-az-hairline-soft bg-base-300 text-[10.5px] text-az-muted">
        nd
      </div>
      <div
        data-selectable
        class="rounded-[16px_16px_6px_16px] bg-base-300 px-[15px] py-[11px] text-[13.5px] text-az-title leading-[1.55]"
      >
        {props.message.body}
      </div>
    </div>
  );
}

/**
 * A moderator note. When it needs approval the run is holding, so the note
 * carries the decision rather than sending you somewhere else to make it.
 */
function ModeratorNote(props: { message: Message }): JSX.Element {
  const { actions } = useWorkspace();
  const moderation = () => props.message.moderation;
  const isCritical = () => moderation()?.severity === "critical";

  return (
    <div
      class={`flex gap-[11px] rounded-xl border border-l-2 p-[11px_13px] ${
        isCritical()
          ? "border-error/26 border-l-error bg-error/8"
          : "border-warning/26 border-l-warning bg-warning/9"
      }`}
    >
      <Icon
        name="shield"
        class={`relative top-0.5 shrink-0 text-[15px] ${isCritical() ? "text-error" : "text-warning"}`}
      />
      <div class="flex min-w-0 flex-1 flex-col gap-[7px]">
        <div class="flex items-baseline gap-2">
          <span class={`font-semibold text-[12px] ${isCritical() ? "text-error" : "text-warning"}`}>
            Moderator
          </span>
          <span class="text-[11.5px] text-az-muted">supervising · {props.message.model}</span>
        </div>

        <p data-selectable class="text-[12.5px] text-az-body leading-[1.55]">
          <Show when={moderation()?.severity}>
            {(severity) => (
              <span
                class={`mr-1.5 rounded-[5px] px-[7px] py-px font-bold text-[10.5px] ${
                  severity() === "critical"
                    ? "bg-error/20 text-error"
                    : "bg-warning/20 text-warning"
                }`}
              >
                {severity() === "critical" ? "CRITICAL" : "CHECK"}
              </span>
            )}
          </Show>
          <InlineText text={moderation()?.reason ?? ""} />
        </p>

        <Show when={moderation()?.needsApproval}>
          <div class="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => void actions.resolveModeration(props.message.id, true)}
              class="rounded-lg bg-primary px-[13px] py-[5px] font-semibold text-[12px] text-primary-content transition-colors hover:bg-[#fff176]"
            >
              Approve once
            </button>
            <button
              type="button"
              onClick={() => void actions.resolveModeration(props.message.id, false)}
              class="rounded-lg border border-white/18 px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-error hover:text-error"
            >
              Deny
            </button>
            <span class="text-[11.5px] text-az-muted">· agent is paused</span>
          </div>
        </Show>
      </div>
    </div>
  );
}

/**
 * The empty state keys off the conversation being empty, not off item focus —
 * items are a list with statuses, and none of them is "the current one".
 */
function EmptyTranscript(props: {
  projectId: string;
  onStart: (body: string) => void;
}): JSX.Element {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-3.5 pb-8">
      <EmptyState class="flex flex-col items-center gap-3.5">
        <EmptyState.Icon>
          <div class="flex size-[54px] items-center justify-center rounded-2xl border border-az-hairline bg-base-300">
            <Icon name="message-square-dashed" class="text-[24px] text-az-faint" />
          </div>
        </EmptyState.Icon>
        <EmptyState.Title class="font-semibold text-[15px] text-base-content">
          Nothing open
        </EmptyState.Title>
        <EmptyState.Description class="max-w-[360px] text-center text-[12.5px] text-az-muted leading-[1.55]">
          This project is connected and idle. Start the conversation, or pick an item from the panel
          on the right.
        </EmptyState.Description>
        <EmptyState.Actions class="flex max-w-[430px] flex-wrap justify-center gap-2">
          <For each={STARTERS}>
            {(starter) => (
              <button
                type="button"
                onClick={() => props.onStart(starter)}
                class="rounded-full border border-az-hairline-strong px-3.5 py-1.5 text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary"
              >
                {starter}
              </button>
            )}
          </For>
        </EmptyState.Actions>
      </EmptyState>
    </div>
  );
}
