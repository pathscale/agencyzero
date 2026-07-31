import { EmptyState } from "@pathscale/ui";
import { createEffect, createSignal, For, type JSX, Match, Show, Switch, untrack } from "solid-js";
import { Icon } from "~/components/Icon";
import { ApprovalCard } from "~/features/project/ApprovalCard";
import { InlineText, MessageBody } from "~/features/project/MessageBody";
import { isTransientStop } from "~/lib/format";
import { AGENT_LABELS } from "~/lib/labels";
import { compactCount, usageTotals } from "~/lib/stats";
import { type RunStatus, useNow, useWorkspace } from "~/stores/workspace";
import type { Message, Project } from "~/types";

const STARTERS = ["Review the GUI crate", "Wire the Solid frontend", "Audit the proxies"];

/**
 * The conversation. Three voices, three shapes:
 * you (a right-aligned bubble), the agent (plain prose), and the moderator
 * (an amber-ruled note that can be holding the run).
 */
export function TranscriptPane(props: {
  project: Project;
  messages: Message[];
  /** The reply being written right now, empty when nothing is streaming. */
  streaming: string;
}): JSX.Element {
  const { state, actions } = useWorkspace();
  let scroller!: HTMLDivElement;

  /*
   * Whether the view is at (or near) the tail. Reading up through a long
   * transcript while the agent streams used to be impossible: every delta
   * yanked the view back to the bottom. Now the tail is only followed while
   * you are already there; scroll up and new text appends below without
   * moving what you are reading. Coming back within a bubble's height of the
   * bottom re-engages the follow.
   */
  const [pinned, setPinned] = createSignal(true);
  const trackScroll = (): void => {
    setPinned(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48);
  };

  // Follow the tail as content arrives: new messages, streaming deltas, the
  // status line appearing. Reading these is what subscribes the effect;
  // `pinned` is untracked so scrolling around cannot itself re-run it.
  createEffect(() => {
    props.messages.length;
    props.streaming;
    void state.runStatus[props.project.id];
    if (!untrack(pinned)) return;
    queueMicrotask(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  });

  return (
    <div
      ref={scroller}
      onScroll={trackScroll}
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
          {(message, index) => (
            <Switch>
              <Match when={message.author === "user"}>
                <UserBubble message={message} />
              </Match>
              <Match when={message.author === "moderator"}>
                <ModeratorNote message={message} />
              </Match>
              <Match when={message.author === "agent"}>
                <AgentBubble
                  message={message}
                  onRetry={(() => {
                    /*
                     * Only the last turn is retryable: a failed turn further up
                     * was already answered or resent, and a button there would
                     * replay a stale prompt onto today's session.
                     *
                     * The prompt the failed turn was answering is the nearest
                     * user message above it. Resent through the ordinary send
                     * path so the retry is a real turn — persisted, moderated,
                     * and resumed on the same session — not a special case.
                     */
                    if (index() !== props.messages.length - 1) return undefined;
                    for (let at = index() - 1; at >= 0; at--) {
                      const earlier = props.messages[at];
                      if (earlier.author === "user") {
                        const body = earlier.body;
                        return () => void actions.send(props.project.id, body);
                      }
                    }
                    return undefined;
                  })()}
                />
              </Match>
            </Switch>
          )}
        </For>
        {/* The run is blocked on this question; it renders where you read. */}
        <Show when={state.pendingApprovals[props.project.id]}>
          {(approval) => <ApprovalCard projectId={props.project.id} approval={approval()} />}
        </Show>

        {/*
          The reply as it arrives. No id and never persisted: it is replaced by
          the real row the moment the run finishes.
        */}
        <Show when={props.streaming}>
          {(text) => (
            // The same container as a finished reply, so the bubble does not
            // appear, disappear and reappear as the run lands.
            <div class={`${AGENT_BUBBLE}`}>
              <span class="text-[11px] text-az-muted">Claude · writing…</span>
              <p class={`whitespace-pre-wrap ${AGENT_TEXT}`}>{text()}</p>
            </div>
          )}
        </Show>

        {/* The run's vital signs, from send to stop: elapsed, size, what the
            agent is doing, whether the words so far are safe in the store —
            and the way out. */}
        <Show when={state.runStatus[props.project.id]}>
          {(status) => (
            <RunStatusLine
              projectId={props.project.id}
              status={status()}
              streamedChars={props.streaming.length}
              sessionWindow={usageTotals(props.messages).contextWindow}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

/**
 * One quiet line while a run is in flight.
 *
 * Answers, at a glance, the questions a running turn raises: how long it has
 * been going, roughly how much it has said, what it is doing right now, and —
 * via the dot — whether the words on screen would survive the app dying this
 * instant. Cancel lives here because this line *is* the run: the window
 * between sending and the first reply used to have no way out at all.
 */
function RunStatusLine(props: {
  projectId: string;
  status: RunStatus;
  streamedChars: number;
  /**
   * The window as the finished turns reported it, which is the only place it
   * can come from mid-run — see `contextShare`.
   */
  sessionWindow: number | null;
}): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const now = useNow();

  const elapsedText = () => {
    const seconds = Math.max(0, Math.floor((now() - props.status.startedAt) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  /*
   * Context, not new work — the only figure that is both exact and knowable
   * mid-turn. 0.3.8's `Event::Usage` withholds `output_tokens` on purpose
   * (the mid-turn count understates badly) and Claude's `input_tokens` is
   * just the uncached delta, so a "tokens so far" counter built from them
   * reads in the dozens for a run that has done real work. The context
   * figures are exact, and they move through tool phases too — the phases
   * where the character estimate sits frozen because nothing is streaming.
   *
   * This is also the number worth watching: a run eating its window is one
   * you may want to cancel, and a bare count cannot say that. The share does.
   */
  /*
   * The window does not arrive mid-turn. The crate reads it from `modelUsage`
   * on the terminal record, so `Event::Usage` carries none and `run:usage`
   * relays that null faithfully — the finished turns are the only source, and
   * `usageTotals` already keeps it latest-wins for the header's own readout.
   *
   * The consequence is that a conversation's first turn shows a bare count
   * and every turn after it shows a share. Better than the alternatives: the
   * catalogue has no window to look up, and inferring one from the model name
   * would be a guess that trap 10 exists to punish (`claude-opus-5` is 200k,
   * every other 5-series model is 1M). A share is only shown when it is known.
   */
  const contextShare = () => {
    const used = props.status.contextTokens;
    const window = props.status.contextWindow ?? props.sessionWindow;
    if (used === null || window === null || window <= 0) return null;
    return used / window;
  };

  /* The `~` marks the estimate and only the estimate. */
  const usageText = () => {
    const used = props.status.contextTokens;
    if (used !== null && used > 0) {
      const share = contextShare();
      const count = compactCount(used);
      return share === null ? `${count} ctx` : `${count} ctx · ${Math.round(share * 100)}%`;
    }
    const tokens = props.streamedChars / 4;
    if (tokens < 1) return null;
    return tokens < 1000
      ? `~${Math.round(tokens)} tokens`
      : `~${(tokens / 1000).toFixed(1)}k tokens`;
  };

  /*
   * Muted until the window is genuinely filling up. The point of the figure is
   * that it can prompt a cancel, and it cannot do that reading as the same
   * grey as the elapsed timer next to it.
   */
  const usageClass = () => {
    const share = contextShare();
    if (share === null) return "";
    if (share >= 0.9) return "text-error";
    if (share >= 0.75) return "text-warning";
    return "";
  };

  const isSynced = () => props.status.persistedChars >= props.streamedChars;

  return (
    <div class="flex items-center gap-2.5 px-1 py-0.5 text-[12px] text-az-muted">
      <span class="animate-pulse text-[13px] text-primary" aria-hidden="true">
        ✳
      </span>
      <span>
        {elapsedText()}
        <Show when={usageText()}>
          {(usage) => (
            <>
              {" · "}
              <span
                class={usageClass()}
                title={
                  props.status.contextTokens === null
                    ? "Estimated from the characters streamed so far"
                    : "Context this conversation is carrying. The turn's token count lands in the header when the run finishes."
                }
              >
                {usage()}
              </span>
            </>
          )}
        </Show>
        {" · "}
        {props.status.activity}
      </span>
      {/* Saved-to-store dot: green means killing the app now loses nothing
          that has streamed; amber means the newest instant exists only
          on screen. Only meaningful once something has streamed. */}
      <Show when={props.streamedChars > 0}>
        <span
          role="img"
          aria-label={isSynced() ? "streamed text saved" : "recent text not yet saved"}
          title={
            isSynced()
              ? "Everything streamed so far is saved to the store"
              : "The store checkpoint runs every 200ms — the newest text is not saved yet"
          }
          class={`size-[7px] shrink-0 rounded-full ${isSynced() ? "bg-success" : "bg-warning"}`}
        />
      </Show>
      <Show when={isLive("cancelRun")}>
        <button
          type="button"
          onClick={() => void actions.cancelRun(props.projectId)}
          class="rounded-md border border-primary/16 px-2 py-px text-[11.5px] text-az-body transition-colors hover:border-error hover:text-error"
        >
          Cancel
        </button>
      </Show>
    </div>
  );
}

/*
 * The agent's reply is the thing you actually read, and it was the hardest text
 * in the window to read: no container at all, sitting straight on the panel, in
 * `az-body` (75%) while the user's own message beside it used `az-title` (86%).
 * Dimmer than your own words, with no edge to tell one turn from the next.
 *
 * So: a recessed surface (`az-inset`, 12.5%) under the top text rung (86%),
 * which is the highest contrast this palette offers without breaking its own
 * rule against pure white. Darker than the panel rather than lighter, so it
 * cannot be mistaken for the user bubble, which is `base-300` and right-aligned.
 * The corner tail mirrors the user's, pointing the other way.
 */
const AGENT_BUBBLE =
  "flex max-w-[88%] flex-col gap-2 self-start rounded-[16px_16px_16px_6px] border border-az-bubble-edge bg-az-bubble px-4 py-3";

/* 14px rather than 13.5, and 1.75 rather than 1.7: this is the longest-running
 * prose in the window and it was set smaller and tighter than the user's own
 * one-line messages. */
const AGENT_TEXT = "text-[14px] text-az-bubble-text leading-[1.75]";

function AgentBubble(props: { message: Message; onRetry?: () => void }): JSX.Element {
  /*
   * A run that did not complete says so on the bubble. The body may be empty or
   * partial, and an unexplained short reply reads as the agent being unhelpful
   * rather than as the turn having failed.
   */
  const failed = () => props.message.stop !== "completed";

  /*
   * A provider outage is weather, not failure: amber rather than red, a short
   * label rather than the vendor's whole sentence (the full text stays on
   * hover), and the fix — resend the same prompt — offered right there.
   */
  const transient = () => isTransientStop(props.message.stop);

  return (
    <div class={AGENT_BUBBLE}>
      <div class="flex items-baseline gap-2">
        <span class="font-semibold text-[11px] text-az-muted">
          {AGENT_LABELS[props.message.agent]}
        </span>
        <Show when={props.message.model}>
          {(model) => <span class="text-[11px] text-az-faint">{model()}</span>}
        </Show>
        <Show when={failed()}>
          <span
            title={props.message.stop}
            class={`rounded-[5px] px-[6px] py-px font-semibold text-[10px] ${
              transient() ? "bg-warning/18 text-warning" : "bg-error/18 text-error"
            }`}
          >
            {transient() ? "provider outage · temporary" : props.message.stop}
          </span>
        </Show>
      </div>
      <MessageBody body={props.message.body} class={AGENT_TEXT} />
      <Show when={failed() && props.onRetry}>
        {(retry) => (
          <div class="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => retry()()}
              class="rounded-lg border border-primary/18 px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary"
            >
              Retry
            </button>
            <Show when={transient()}>
              <span class="text-[11.5px] text-az-muted">
                the server was overloaded — your prompt is safe to resend
              </span>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}

/*
 * No avatar chip. The mockup had a 26px square reading "nd" — a designer's
 * initials placeholder that shipped as-is and read as a mystery glyph. The
 * right-aligned bubble already says whose words these are.
 */
function UserBubble(props: { message: Message }): JSX.Element {
  return (
    <div class="flex max-w-[76%] flex-col items-end gap-[7px] self-end">
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
              class="rounded-lg bg-primary px-[13px] py-[5px] font-semibold text-[12px] text-primary-content transition-colors hover:bg-az-primary-hover"
            >
              Approve once
            </button>
            <button
              type="button"
              onClick={() => void actions.resolveModeration(props.message.id, false)}
              class="rounded-lg border border-primary/18 px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-error hover:text-error"
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
