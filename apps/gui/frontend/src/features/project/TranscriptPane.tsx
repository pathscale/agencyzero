import { EmptyState } from "@pathscale/ui";
import { createEffect, createSignal, For, type JSX, Match, Show, Switch, untrack } from "solid-js";
import { Icon } from "~/components/Icon";
import { ApprovalCard } from "~/features/project/ApprovalCard";
import { CopyMessageButton, InlineText, MessageBody } from "~/features/project/MessageBody";
import { isRetryableStop, isTransientStop, relativeTime } from "~/lib/format";
import { AGENT_LABELS } from "~/lib/labels";
import { compactCount } from "~/lib/stats";
import { tx } from "~/stores/i18n";
import { type RunStatus, useNow, useWorkspace } from "~/stores/workspace";
import type { Message, Project, Question } from "~/types";

const STARTERS = () => [
  tx("Review the GUI crate"),
  tx("Wire the Solid frontend"),
  tx("Audit the proxies"),
];

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
  const streamingAgent = () =>
    state.runStatus[props.project.id]?.agent ??
    [...props.messages]
      .reverse()
      .find((message) => message.author === "user" || message.author === "agent")?.agent ??
    "claude";

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
    void (state.questions[props.project.id] ?? []).filter((question) => !question.answered).length;
    if (!untrack(pinned)) return;
    queueMicrotask(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  });

  return (
    /*
     * The whole scroller is selectable, not each bubble.
     *
     * A conversation is read and quoted across messages, so the selection has
     * to survive crossing the gaps between them. Marking only the bubbles left
     * every gap unselectable, and a drag over one collapsed the selection.
     */
    <div
      ref={scroller}
      onScroll={trackScroll}
      data-selectable
      class="az-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden px-6 pt-5 pb-2 leading-relaxed"
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
              <Match when={message.author === "system"}>
                <SystemNote message={message} />
              </Match>
              <Match when={message.author === "review"}>
                <ReviewNote message={message} />
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
        {/* Agent questions belong in the conversation, where they remain
            visible until answered. They used to float over the composer and
            looked like transient input chrome rather than part of the turn. */}
        <For
          each={(state.questions[props.project.id] ?? []).filter((question) => !question.answered)}
        >
          {(question) => <QuestionCard question={question} />}
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
              <span class="text-[11px] text-az-muted">
                {AGENT_LABELS[streamingAgent()]} {tx("· writing…")}
              </span>
              <MessageBody body={text()} class={AGENT_TEXT} />
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
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

/** A persistent, urgency-coloured question inside the transcript flow. */
function QuestionCard(props: { question: Question }): JSX.Element {
  const { actions } = useWorkspace();
  const tones: Record<Question["urgency"], { border: string; icon: string; label: string }> = {
    critical: {
      border: "border-error/45 bg-error/10",
      icon: "text-error",
      label: tx("Critical"),
    },
    blocking: {
      border: "border-warning/40 bg-warning/9",
      icon: "text-warning",
      label: tx("Blocking"),
    },
    passive: {
      border: "border-az-hairline bg-az-inset",
      icon: "text-az-muted",
      label: tx("When free"),
    },
  };
  const tone = () => tones[props.question.urgency] ?? tones.blocking;

  return (
    <div
      class={`flex items-start gap-3 rounded-[13px] border px-4 py-3 text-[12px] ${tone().border}`}
    >
      <Icon name="messages-square" class={`relative top-0.5 shrink-0 text-[15px] ${tone().icon}`} />
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <div class="flex items-baseline gap-2">
          <span class={`shrink-0 font-semibold text-[11px] ${tone().icon}`}>{tone().label}</span>
          <Show when={props.question.issueUrl}>
            <span class="min-w-0 truncate text-[11px] text-az-muted">
              {props.question.issueUrl}
            </span>
          </Show>
        </div>
        <span data-selectable class="whitespace-pre-wrap break-words text-az-strong">
          {props.question.text}
        </span>
      </div>
      <button
        type="button"
        onClick={() => void actions.answerQuestion(props.question.id, true)}
        class="shrink-0 rounded-lg bg-primary px-3 py-1.5 font-semibold text-[11.5px] text-primary-content transition-colors hover:bg-az-primary-hover"
      >
        {tx("Answer")}
      </button>
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
 *
 * Exported for its own test. Nothing below the real backend emits `run:usage`
 * — the mock fakes no agent output on purpose — so this component is the only
 * place the token figure can be exercised, and it went a whole release
 * reporting "60 tokens" for want of one.
 */
export function RunStatusLine(props: {
  projectId: string;
  status: RunStatus;
  streamedChars: number;
}): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const now = useNow();

  const elapsedText = () => {
    const seconds = Math.max(0, Math.floor((now() - props.status.startedAt) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  /*
   * The turn's tokens as the agent reports them, on the same definition as the
   * header total: everything processed, cache included. So the two read in the
   * same unit and the running figure lands inside the total it will join.
   *
   * Real once the first API request completes, estimated from streamed
   * characters until then and for agents that report no mid-turn usage at all.
   * The `~` marks the estimate and only the estimate.
   */
  const usageText = () => {
    const live = props.status.liveTokens;
    if (live !== null && live > 0) return `${compactCount(live)} tok`;
    const tokens = props.streamedChars / 4;
    if (tokens < 1) return null;
    return tokens < 1000
      ? `~${Math.round(tokens)} tokens`
      : `~${(tokens / 1000).toFixed(1)}k tokens`;
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
                title={
                  props.status.liveTokens === null
                    ? tx("Estimated from the characters streamed so far")
                    : tx(
                        "Tokens this turn has processed, cache included. The reply's own output joins it in the header when the run finishes.",
                      )
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
          aria-label={isSynced() ? tx("streamed text saved") : tx("recent text not yet saved")}
          title={
            isSynced()
              ? tx("Everything streamed so far is saved to the store")
              : tx("The store checkpoint runs every 200ms — the newest text is not saved yet")
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
          {tx("Cancel")}
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
  // A cancellation is already an owner decision or an app restart. Offering
  // Retry there replays a prompt the owner may have intentionally stopped and
  // makes a normally completed pre-update reply look unfinished after restart.
  const retryable = () => isRetryableStop(props.message.stop);

  /*
   * A provider outage is weather, not failure: amber rather than red, a short
   * label rather than the vendor's whole sentence (the full text stays on
   * hover), and the fix — resend the same prompt — offered right there.
   */
  const transient = () => isTransientStop(props.message.stop);

  return (
    /*
     * `data-selectable` on the bubble, not only on the text inside it.
     *
     * The window sets `user-select: none` on the body and opts back in per
     * element, so a drag that begins on the bubble's padding — a pixel outside
     * the prose, which is most of the target — started no selection at all and
     * ⌘C then copied nothing. The failure is silent, which is what made it read
     * as the chat area eating the copy.
     */
    <div class={`group ${AGENT_BUBBLE}`} data-selectable>
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
            {transient() ? tx("provider outage · temporary") : props.message.stop}
          </span>
        </Show>
        <div class="flex-1" />
        <CopyMessageButton body={props.message.body} />
      </div>
      <MessageBody body={props.message.body} class={AGENT_TEXT} />
      <Show when={retryable() && props.onRetry}>
        {(retry) => (
          <div class="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => retry()()}
              class="rounded-lg border border-primary/18 px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary"
            >
              {tx("Retry")}
            </button>
            <Show when={transient()}>
              <span class="text-[11.5px] text-az-muted">
                {tx("the server was overloaded — your prompt is safe to resend")}
              </span>
            </Show>
          </div>
        )}
      </Show>
      {/*
       * Under the reply, where the user's own timestamp sits.
       *
       * It used to ride in the header between the model name and the failure
       * chip, so the two sides of the same conversation dated themselves in
       * different places and the eye had to go looking. A timestamp is what
       * the message turned out to be, not an announcement before it.
       */}
      <MessageTime at={props.message.createdAt} />
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
        class="whitespace-pre-wrap rounded-[16px_16px_6px_16px] bg-base-300 px-[15px] py-[11px] text-[13.5px] text-az-title leading-[1.55]"
      >
        {props.message.body}
      </div>
      <MessageTime at={props.message.createdAt} />
    </div>
  );
}

/**
 * When a message landed, in words rather than a clock face.
 *
 * A transcript read hours later is a sequence of "and then what" — the gap
 * between two turns is the useful fact, and "31 min ago" answers it without
 * arithmetic. The exact stamp is on hover for when it is the timeline that
 * matters.
 *
 * Recomputed on a minute's tick rather than once at render: a bubble that says
 * "just now" three hours later is worse than no timestamp, and the transcript
 * is a screen people leave open.
 */
function MessageTime(props: { at: string }): JSX.Element {
  const now = useNow(30_000);
  return (
    <span title={props.at} class="shrink-0 text-[10.5px] text-az-faint">
      {relativeTime(props.at, now())}
    </span>
  );
}

/**
 * The app's own voice: something that happened *to* the conversation.
 *
 * A compaction is the case it exists for — the transcript above it now
 * summarises a conversation the agent no longer remembers word for word, and
 * that is a fact about the thread rather than a turn in it. So: centred, quiet,
 * and ruled off, reading as a seam rather than as someone speaking.
 *
 * Not a moderator note, which is what this used to be. That card is built out
 * of a `moderation` verdict — severity, reason, the approve/deny pair — and a
 * compaction has none of it, so the note rendered as an empty amber box saying
 * "Moderator supervising ·" and nothing else. The result of the compaction was
 * invisible, and the moderator appeared to have opinions about a conversation
 * nobody had asked it to supervise.
 */
function SystemNote(props: { message: Message }): JSX.Element {
  // A failed compaction is still a fact about the thread, not an agent turn —
  // same seam, but it says so rather than reading as something that worked.
  const failed = () => props.message.stop !== "completed";

  return (
    <div class="group flex items-center gap-3 py-0.5">
      <span class="h-px flex-1 bg-az-hairline" />
      <span
        data-selectable
        class={`flex items-center gap-1.5 text-center text-[11.5px] ${
          failed() ? "text-error" : "text-az-muted"
        }`}
      >
        <Icon name={failed() ? "info" : "sparkles"} class="relative top-px shrink-0 text-[12px]" />
        {props.message.body}
      </span>
      {/* These notes carry the one thing most worth copying out of a
          transcript: the path a checkpoint was just written to. */}
      <CopyMessageButton body={props.message.body} />
      <span class="h-px flex-1 bg-az-hairline" />
    </div>
  );
}

/**
 * A PR review, run on the side and dropped inline.
 *
 * Distinct from an agent turn on purpose: it is not part of the conversation
 * sent to the Home agent, it is a result the owner reads and copies. The whole
 * body renders as markdown (so a review's tables and code show), with a copy
 * button and the PR it reviewed named in the header.
 */
function ReviewNote(props: { message: Message }): JSX.Element {
  return (
    <div class="group flex flex-col gap-2 rounded-xl border border-az-hairline border-l-2 border-l-info bg-az-inset p-[13px_15px]">
      <div class="flex items-center gap-2">
        <Icon name="messages-square" class="shrink-0 text-[14px] text-info" />
        <span class="font-semibold text-[12px] text-az-strong">
          {tx("Review by {agent}", {
            agent: AGENT_LABELS[props.message.agent] ?? props.message.agent,
          })}
        </span>
        <Show when={props.message.stop}>
          <span class="min-w-0 truncate font-mono text-[11px] text-az-muted">
            {props.message.stop}
          </span>
        </Show>
        <span class="ml-auto shrink-0">
          <CopyMessageButton body={props.message.body} />
        </span>
      </div>
      <MessageBody body={props.message.body} />
      <span class="text-[11px] text-az-faint">
        {tx("Not sent to the agent. Copy it and paste it on if you want.")}
      </span>
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
            {tx("Moderator")}
          </span>
          <span class="text-[11.5px] text-az-muted">
            {tx("supervising")} · {props.message.model}
          </span>
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
                {severity() === "critical" ? tx("CRITICAL") : tx("CHECK")}
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
              {tx("Approve once")}
            </button>
            <button
              type="button"
              onClick={() => void actions.resolveModeration(props.message.id, false)}
              class="rounded-lg border border-primary/18 px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-error hover:text-error"
            >
              {tx("Deny")}
            </button>
            <span class="text-[11.5px] text-az-muted">{tx("· agent is paused")}</span>
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
          {tx("Nothing open")}
        </EmptyState.Title>
        <EmptyState.Description class="max-w-[360px] text-center text-[12.5px] text-az-muted leading-[1.55]">
          {tx(
            "This project is connected and idle. Start the conversation, or pick an item from the panel on the right.",
          )}
        </EmptyState.Description>
        <EmptyState.Actions class="flex max-w-[430px] flex-wrap justify-center gap-2">
          <For each={STARTERS()}>
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
