import { EmptyState } from "@pathscale/ui";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { Icon } from "~/components/Icon";
import { ApprovalCard } from "~/features/project/ApprovalCard";
import { CopyMessageButton, InlineText, MessageBody } from "~/features/project/MessageBody";
import {
  isCybersecurityRefusal,
  isRetryableStop,
  isSuccessfulStop,
  isTransientStop,
  relativeTime,
} from "~/lib/format";
import { AGENT_LABELS } from "~/lib/labels";
import { costLabel, estimateTurnCost } from "~/lib/pricing";
import { compactCount } from "~/lib/stats";
import { agentTurnLabels } from "~/lib/turns";
import { tx } from "~/stores/i18n";
import { type RunStatus, useNow, useWorkspace } from "~/stores/workspace";
import type { Message, MessageReceipt as MessageReceiptState, Project, Question } from "~/types";

const STARTERS = () => [
  tx("Review the GUI crate"),
  tx("Wire the Solid frontend"),
  tx("Audit the proxies"),
];

/**
 * Hold back a directive that is still streaming, so a `<ps @agency:...>` span
 * does not flash on screen and then vanish when the backend strips it from the
 * settled message.
 *
 * Applied to the LIVE stream only. If the tail of the text so far contains a
 * `<ps` that has not yet reached its closing `>`, everything from that `<ps`
 * onward is withheld until the delta that completes the tag arrives (at which
 * point the backend has the whole directive and the settled message will carry
 * whatever it left behind). A `<ps` that never closes just stays hidden, which
 * is the right outcome for a directive: the user never authored it to read.
 */
function holdBackPartialDirective(text: string): string {
  const open = text.lastIndexOf("<ps");
  if (open === -1) return text;
  // A closing `>` after the last `<ps` means the directive is complete; nothing
  // to withhold. Only an unterminated trailing `<ps...` is held.
  const closed = text.indexOf(">", open);
  return closed === -1 ? text.slice(0, open) : text;
}

const TRANSCRIPT_PAGE_SIZE = 12;

export function transcriptTail<T>(
  entries: T[],
  visibleCount: number,
): {
  hidden: number;
  visible: T[];
} {
  const hidden = Math.max(0, entries.length - Math.max(1, visibleCount));
  return { hidden, visible: entries.slice(hidden) };
}

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
  const [visibleEntries, setVisibleEntries] = createSignal(TRANSCRIPT_PAGE_SIZE);
  let lastScrollTop = 0;
  const trackScroll = (): void => {
    const top = scroller.scrollTop;
    const nearTail = scroller.scrollHeight - top - scroller.clientHeight < 48;
    if (nearTail) {
      setPinned(true);
    } else if (top < lastScrollTop - 1) {
      // Only an actual upward movement disengages tail following. Layout and
      // streamed-content growth can increase the distance from the tail
      // without the owner moving at all.
      setPinned(false);
    }
    lastScrollTop = top;
  };

  let followFrame: number | undefined;
  const followTail = (): void => {
    if (!untrack(pinned)) return;
    const moveToTail = (): void => {
      if (!untrack(pinned)) return;
      scroller.scrollTop = scroller.scrollHeight;
      lastScrollTop = scroller.scrollTop;
    };
    queueMicrotask(moveToTail);
    if (typeof requestAnimationFrame !== "undefined") {
      if (followFrame !== undefined) cancelAnimationFrame(followFrame);
      followFrame = requestAnimationFrame(() => {
        followFrame = undefined;
        moveToTail();
      });
    }
  };

  /*
   * Keep a pinned transcript pinned when the project sidebar changes width.
   * Narrowing the transcript reflows long messages, increasing scrollHeight
   * without emitting a content update. The ordinary tail-following effect
   * therefore never ran and the visible conversation appeared to jump upward.
   * ResizeObserver catches that geometry-only change while leaving a reader
   * who deliberately scrolled up exactly where they were.
   */
  let resizeObserver: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;
  onMount(() => {
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        // A width transition can leave an overflow-hidden element with a real,
        // retained horizontal offset. The bar is invisible but the first words
        // are clipped off the left edge until another layout happens.
        scroller.scrollLeft = 0;
        followTail();
      });
      resizeObserver.observe(scroller);
    }
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(followTail);
      mutationObserver.observe(scroller, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    followTail();
  });
  onCleanup(() => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    if (followFrame !== undefined && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(followFrame);
    }
  });

  /*
   * The transcript is one timeline, not "messages, then a pile of questions".
   *
   * Answered questions stay at the point where they were asked, immediately
   * above the owner reply that answered them. An open question is different:
   * it is the action the conversation is waiting on, so it stays at the tail.
   */
  const questionsFor = () => state.questions[props.project.id] ?? [];
  const questionNumber = (id: string): number => {
    const ordered = [...questionsFor()].sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    );
    const index = ordered.findIndex((question) => question.id === id);
    return index >= 0 ? index + 1 : 0;
  };
  const openQuestion = () => nextOpenQuestion(questionsFor());
  const turnLabels = createMemo(() => agentTurnLabels(props.messages));
  const timeline = createMemo(() => {
    const questions = questionsFor()
      .filter((question) => question.answered)
      .map((q) => {
        const reply = props.messages.find((message) => message.replyToQuestionId === q.id);
        return {
          kind: "question" as const,
          at: reply?.createdAt ?? q.createdAt,
          question: q,
        };
      });
    const messages = props.messages.map((message, index) => ({
      kind: "message" as const,
      at: message.createdAt,
      message,
      index,
    }));
    return [...messages, ...questions].sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? -1 : 1;
      // A linked ask shares its reply's timestamp and sits immediately above
      // it, even after reload. Unrelated ties retain insertion order.
      if (
        a.kind === "question" &&
        b.kind === "message" &&
        b.message.replyToQuestionId === a.question.id
      ) {
        return -1;
      }
      if (
        a.kind === "message" &&
        b.kind === "question" &&
        a.message.replyToQuestionId === b.question.id
      ) {
        return 1;
      }
      return 0;
    });
  });
  const visibleTimeline = createMemo(() => transcriptTail(timeline(), visibleEntries()));

  // Follow the tail as content arrives: new messages, streaming deltas, the
  // status line appearing. Reading these is what subscribes the effect;
  // `pinned` is untracked so scrolling around cannot itself re-run it.
  createEffect(() => {
    props.messages.length;
    props.streaming;
    void state.runStatus[props.project.id];
    void (state.questions[props.project.id] ?? []).filter((question) => !question.answered).length;
    followTail();
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
      class="az-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden px-6 pt-14 pb-2 leading-relaxed"
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
        {/* Messages and answered questions, threaded together by time, so an
            answered question sits where it was asked rather than in a pile at
            the bottom. */}
        <Show when={visibleTimeline().hidden > 0}>
          <button
            type="button"
            onClick={() => setVisibleEntries((count) => count + TRANSCRIPT_PAGE_SIZE)}
            class="mx-auto rounded-full border border-az-hairline-strong px-3 py-1 text-[11px] text-az-muted transition-colors hover:border-primary/50 hover:text-az-body"
          >
            {tx("Show {count} earlier messages", {
              count: Math.min(TRANSCRIPT_PAGE_SIZE, visibleTimeline().hidden),
            })}
          </button>
        </Show>
        <For each={visibleTimeline().visible}>
          {(entry) => (
            <Switch>
              <Match when={entry.kind === "question" && entry}>
                {(item) => (
                  <QuestionCard
                    question={item().question}
                    number={questionNumber(item().question.id)}
                  />
                )}
              </Match>
              <Match when={entry.kind === "message" && entry.message.author === "user" && entry}>
                {(item) => (
                  <UserBubble
                    message={item().message}
                    replyQuestion={questionsFor().find(
                      (question) => question.id === item().message.replyToQuestionId,
                    )}
                    replyQuestionNumber={
                      item().message.replyToQuestionId
                        ? questionNumber(item().message.replyToQuestionId!)
                        : undefined
                    }
                    receipt={state.messageReceipts[props.project.id]?.[item().message.id]}
                  />
                )}
              </Match>
              <Match
                when={entry.kind === "message" && entry.message.author === "moderator" && entry}
              >
                {(item) => <ModeratorNote message={item().message} />}
              </Match>
              <Match when={entry.kind === "message" && entry.message.author === "system" && entry}>
                {(item) => <SystemNote message={item().message} />}
              </Match>
              <Match when={entry.kind === "message" && entry.message.author === "review" && entry}>
                {(item) => <ReviewNote message={item().message} />}
              </Match>
              <Match when={entry.kind === "message" && entry.message.author === "agent" && entry}>
                {(item) => (
                  <AgentBubble
                    message={item().message}
                    turn={turnLabels()[item().message.id]}
                    onRetry={(() => {
                      /*
                       * Only the last turn is retryable: a failed turn further
                       * up was already answered or resent, and a button there
                       * would replay a stale prompt onto today's session. The
                       * index is the message's position in the ORIGINAL message
                       * list, preserved through the merge, so threading answered
                       * questions in does not shift what "the last turn" means.
                       *
                       * The prompt the failed turn was answering is the nearest
                       * user message above it. Retry reuses that durable row so
                       * recovery resumes the session without drawing a second
                       * copy of the owner's request in the transcript.
                       */
                      const index = item().index;
                      if (index !== props.messages.length - 1) return undefined;
                      for (let at = index - 1; at >= 0; at--) {
                        const earlier = props.messages[at];
                        if (earlier.author === "user") {
                          return () =>
                            void actions.retry(props.project.id, earlier.id, earlier.body);
                        }
                      }
                      return undefined;
                    })()}
                  />
                )}
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
              <span class="text-[11px] text-az-muted">
                {AGENT_LABELS[streamingAgent()]} {tx("· writing…")}
              </span>
              <MessageBody body={holdBackPartialDirective(text())} class={AGENT_TEXT} />
            </div>
          )}
        </Show>

        {/* The run's vital signs, from send to stop: elapsed, size, what the
         * agent is doing, whether the words so far are safe in the store —
         * and the way out. */}
        <Show when={state.runStatus[props.project.id]}>
          {(status) => (
            <RunStatusLine
              projectId={props.project.id}
              status={status()}
              streamedChars={props.streaming.length}
            />
          )}
        </Show>

        {/* The unresolved ask is the conversation's current action, so it is
         * always the last authored content rather than floating above the
         * reply that introduced it. Once answered, it moves into `timeline`
         * immediately above the owner's response. */}
        <Show when={openQuestion()}>
          {(question) => (
            <QuestionCard question={question()} number={questionNumber(question().id)} />
          )}
        </Show>
      </Show>
    </div>
  );
}

/**
 * Present one durable owner decision at a time. A project may accumulate many
 * questions, but stacking every card makes none of them readable. Stable
 * chronological order means dismissing or answering the visible card reveals
 * the next without reshuffling the queue.
 */
export function nextOpenQuestion(questions: Question[]): Question | undefined {
  return [...questions]
    .filter((question) => !question.answered)
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    )[0];
}

/**
 * A question, inline in the chat thread, not a dialog.
 *
 * It must read as part of the conversation, while carrying enough identity to
 * scan as a question at a glance. Reply stages a durable association in the
 * composer; dismiss remains a separate explicit action.
 */
function QuestionCard(props: { question: Question; number: number }): JSX.Element {
  const { actions } = useWorkspace();
  // The left rule's colour, by urgency. That is the whole visual weight — no
  // fill, no label chip.
  const accent = (): string => {
    switch (props.question.urgency) {
      case "critical":
        return "border-error";
      case "passive":
        return "border-az-hairline-strong";
      default:
        // The tab dot is red for a blocking question; the card uses the same
        // signal so the reason for that dot is visually immediate.
        return "border-error";
    }
  };
  const answered = () => props.question.answered;
  const urgency = () => {
    switch (props.question.urgency) {
      case "critical":
        return tx("Critical");
      case "passive":
        return tx("When free");
      default:
        return tx("Blocking");
    }
  };
  const iconTone = () => (props.question.urgency === "passive" ? "text-az-muted" : "text-error");
  const openSurface = () => (props.question.urgency === "critical" ? "bg-error/8" : "bg-az-inset");

  return (
    <div
      class={`group flex items-start gap-2.5 rounded-r-xl border-l-[3px] py-2.5 pr-2.5 pl-3.5 text-[12.5px] transition-opacity ${
        answered() ? "border-az-hairline bg-az-inset opacity-80" : `${openSurface()} ${accent()}`
      }`}
    >
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <div class="flex items-center gap-1.5">
          <Icon name="message-square-dashed" class={`text-[13px] ${iconTone()}`} />
          <span class="font-semibold text-[11px] text-az-strong">
            {tx("Question #{number}", { number: props.number })}
          </span>
          <span class="text-[10.5px] text-az-muted">· {urgency()}</span>
        </div>
        <Show when={props.question.issueUrl}>
          <span class="min-w-0 truncate text-[10.5px] text-az-muted">
            {props.question.issueUrl}
          </span>
        </Show>
        <span data-selectable class="whitespace-pre-wrap break-words text-az-body leading-[1.5]">
          {props.question.text}
        </span>
      </div>
      <Show when={!answered()}>
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => actions.selectQuestionReply(props.question.projectId, props.question.id)}
            aria-label={tx("Reply to this question")}
            class="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-semibold text-[10.5px] text-primary transition-colors hover:bg-primary/18"
          >
            {tx("Reply")}
          </button>
          <button
            type="button"
            onClick={() => void actions.answerQuestion(props.question.id, true)}
            aria-label={tx("Dismiss this question")}
            title={tx("Dismiss this question")}
            class="rounded p-0.5 text-az-faint transition-colors hover:bg-white/5 hover:text-az-body"
          >
            <Icon name="x" class="text-[13px]" />
          </button>
        </div>
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

  /** Current prompt size, never summed across the model calls in this turn. */
  const contextText = () => {
    const context = props.status.contextTokens;
    return context !== null && context > 0
      ? tx("{count} ctx", { count: compactCount(context) })
      : null;
  };

  /**
   * Cumulative billable traffic across this turn's model calls. A tool-heavy
   * turn can legitimately process many times its current context because the
   * prompt is read again after each tool result.
   */
  const processedText = () => {
    const live = props.status.liveTokens;
    if (live !== null && live > 0) {
      return tx("{count} processed", { count: compactCount(live) });
    }
    const tokens = props.streamedChars / 4;
    if (tokens < 1) return null;
    const count = tokens < 1000 ? String(Math.round(tokens)) : `${(tokens / 1000).toFixed(1)}k`;
    return tx("~{count} output", { count });
  };

  /** What the reported traffic has cost at the current local price table. */
  const liveCostText = () => {
    const cost = props.status.liveCostUsd;
    return cost !== null && cost > 0 ? tx("est. {cost}", { cost: costLabel(cost) }) : null;
  };

  const isSynced = () => props.status.persistedChars >= props.streamedChars;

  return (
    <div class="flex items-center gap-2.5 px-1 py-0.5 text-[12px] text-az-muted">
      {/*
        Controls on the left, fixed: Cancel and the saved-to-store dot sit
        before the text so the text can grow and shrink without sliding them
        around. The old pulsing star lived here as a "thinking" marker; it is
        gone, because the saved-dot (and the live elapsed/usage readout that
        only ticks while a run is live) already says the run is working, and two
        indicators for one fact is one too many.
      */}
      <Show when={isLive("cancelRun")}>
        <button
          type="button"
          onClick={() => void actions.cancelRun(props.projectId)}
          class="shrink-0 rounded-md border border-primary/16 px-2 py-px text-[11.5px] text-az-body transition-colors hover:border-error hover:text-error"
        >
          {tx("Cancel")}
        </button>
      </Show>
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
      <span class="min-w-0 truncate">
        {elapsedText()}
        <Show when={contextText()}>
          {(context) => (
            <>
              {" · "}
              <span
                title={tx(
                  "Current conversation size for the latest model call. This is window occupancy, not cumulative billing traffic.",
                )}
              >
                {context()}
              </span>
            </>
          )}
        </Show>
        <Show when={processedText()}>
          {(usage) => (
            <>
              {" · "}
              <span
                title={
                  props.status.liveTokens === null
                    ? tx("Estimated from the characters streamed so far")
                    : tx(
                        "Cumulative billable token traffic across this turn's model calls: fresh input, repeated cached input, cache writes, and generated output reported so far.",
                      )
                }
              >
                {usage()}
              </span>
            </>
          )}
        </Show>
        <Show when={liveCostText()}>
          {(cost) => (
            <>
              {" · "}
              <span
                class="font-semibold text-accent"
                title={tx(
                  "Live estimate from reported input, output and cache traffic plus unfinished streamed output. The provider's terminal cost remains canonical.",
                )}
              >
                {cost()}
              </span>
            </>
          )}
        </Show>
        {" · "}
        {props.status.activity}
      </span>
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

function AgentBubble(props: {
  message: Message;
  turn?: string;
  onRetry?: () => void;
}): JSX.Element {
  if (props.message.stop === "reconnected" && props.message.body === "Reconnected") {
    return (
      <div class="self-start rounded-full border border-az-hairline px-3 py-1 text-[11px] text-az-muted">
        {tx("Reconnected")}
      </div>
    );
  }

  /*
   * A run that did not complete says so on the bubble. The body may be empty or
   * partial, and an unexplained short reply reads as the agent being unhelpful
   * rather than as the turn having failed.
   */
  const failed = () => !isSuccessfulStop(props.message.stop);
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
  const cybersecurityRefusal = () => isCybersecurityRefusal(props.message.stop);

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
            {transient()
              ? tx("provider outage · temporary")
              : cybersecurityRefusal()
                ? tx("security review required")
                : props.message.stop}
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
      <div class="flex items-center gap-2">
        <Show when={props.turn}>
          {(turn) => (
            <span class="shrink-0 text-[10.5px] text-az-faint">
              {tx("Turn {number}", { number: turn() })} ·
            </span>
          )}
        </Show>
        <MessageTime at={props.message.createdAt} />
        <MessageCost message={props.message} />
      </div>
    </div>
  );
}

/**
 * What this turn cost and processed, beside its timestamp.
 *
 * Claude reports a real `costUsd`, shown plainly. Codex reports tokens but no
 * cost, so its figure is estimated from the price table and labelled "est." —
 * the honesty is in the word, since a guessed cost dressed as a real one would
 * be worse than none. A legacy Codex turn that lacks the exact token split
 * keeps its token count but shows no invented dollar figure.
 */
export function MessageCost(props: { message: Message }): JSX.Element {
  const { state } = useWorkspace();
  const cost = createMemo<{
    usd: number | null;
    estimated: boolean;
    tokens: number;
    calculatedUsd: number | null;
    mismatch: boolean;
  } | null>(() => {
    const usage = props.message.usage;
    if (!usage) return null;
    const tokens =
      typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : 0;
    const table = state.pricing;
    const calculatedUsd = table ? estimateTurnCost(table, props.message.model, usage) : null;
    if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)) {
      const delta = calculatedUsd === null ? 0 : Math.abs(usage.costUsd - calculatedUsd);
      const mismatch = calculatedUsd !== null && delta > 0.01 && delta / usage.costUsd > 0.05;
      return {
        usd: usage.costUsd,
        estimated: false,
        tokens,
        calculatedUsd,
        mismatch,
      };
    }
    return calculatedUsd === null && tokens === 0
      ? null
      : {
          usd: calculatedUsd,
          estimated: calculatedUsd !== null,
          tokens,
          calculatedUsd: null,
          mismatch: false,
        };
  });

  return (
    <Show when={cost()}>
      {(value) => (
        <span
          title={
            value().usd === null
              ? undefined
              : value().estimated
                ? tx("Estimated from token counts — this agent does not report a cost.")
                : value().calculatedUsd === null
                  ? tx("Reported by the agent.")
                  : tx("Reported by the agent: {reported}. Token-derived check: {calculated}.", {
                      reported: costLabel(value().usd!),
                      calculated: costLabel(value().calculatedUsd!),
                    })
          }
          class="inline-flex shrink-0 items-center font-mono text-[10.5px]"
        >
          <Show when={value().usd !== null}>
            <span
              class={
                props.message.agent === "claude" && !value().estimated && value().usd! > 2
                  ? "font-semibold text-error"
                  : "text-az-faint"
              }
            >
              {value().estimated
                ? tx("est. {cost}", { cost: costLabel(value().usd!) })
                : costLabel(value().usd!)}
            </span>
          </Show>
          <Show when={value().mismatch && value().calculatedUsd !== null}>
            <span class="font-semibold text-warning">
              {" · "}
              {tx("calc {cost}", { cost: costLabel(value().calculatedUsd!) })}
            </span>
          </Show>
          <Show when={value().tokens > 0}>
            <Show when={value().usd !== null}>
              <span class="text-az-faint">{" · "}</span>
            </Show>
            <span class="text-az-faint">
              {compactCount(value().tokens)} {tx("tok")}
            </span>
          </Show>
        </span>
      )}
    </Show>
  );
}

/*
 * No avatar chip. The mockup had a 26px square reading "nd" — a designer's
 * initials placeholder that shipped as-is and read as a mystery glyph. The
 * right-aligned bubble already says whose words these are.
 */
function UserBubble(props: {
  message: Message;
  replyQuestion?: Question;
  replyQuestionNumber?: number;
  receipt?: MessageReceiptState;
}): JSX.Element {
  return (
    <div class="flex max-w-[76%] flex-col items-end gap-[7px] self-end">
      <div
        data-selectable
        class="whitespace-pre-wrap rounded-[16px_16px_6px_16px] bg-base-300 px-[15px] py-[11px] text-[13.5px] text-az-title leading-[1.55]"
      >
        <Show when={props.replyQuestion}>
          {(question) => (
            <div
              title={question().text}
              class="mb-2 flex w-fit items-center border-primary/35 border-l-2 pl-2 text-[10.5px] text-primary"
            >
              <span class="shrink-0 font-semibold">
                {tx("Reply to #{number}", { number: props.replyQuestionNumber ?? "?" })}
              </span>
            </div>
          )}
        </Show>
        {props.message.body}
      </div>
      <div class="flex items-center gap-1.5">
        <MessageTime at={props.message.createdAt} />
        <MessageReceipt status={props.receipt} />
      </div>
    </div>
  );
}

/** Compact chat-style acknowledgement beside a user message's timestamp. */
export function MessageReceipt(props: { status?: MessageReceiptState }): JSX.Element {
  const read = () => props.status === "read";
  const label = () => (read() ? tx("Read by agent") : tx("Sent"));

  return (
    <Show when={props.status}>
      <span
        role="img"
        aria-label={label()}
        title={label()}
        class={`inline-flex h-3 w-4 items-center ${read() ? "text-primary" : "text-az-faint"}`}
      >
        <svg aria-hidden="true" viewBox="0 0 18 12" class="h-3 w-[18px] fill-none">
          <path
            d="M1 6.3 4.1 9.4 10.1 2.5"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <Show when={read()}>
            <path
              d="m7.2 8.5 1 1 6-6.9"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </Show>
        </svg>
      </span>
    </Show>
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
        <MessageCost message={props.message} />
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
export function ReviewNote(props: { message: Message }): JSX.Element {
  const failed = () => props.message.exitCode !== null && props.message.exitCode !== 0;
  return (
    <div
      data-selectable
      class={`group ${AGENT_BUBBLE} ${failed() ? "border-error/40" : "border-info/30"}`}
    >
      <div class="flex items-center gap-2">
        <Icon
          name="messages-square"
          class={`shrink-0 text-[14px] ${failed() ? "text-error" : "text-info"}`}
        />
        <span class="font-semibold text-[12px] text-az-strong">
          {tx("Review by {agent}", {
            agent: AGENT_LABELS[props.message.agent] ?? props.message.agent,
          })}
        </span>
        <Show when={failed()}>
          <span class="rounded-[5px] bg-error/18 px-[6px] py-px font-semibold text-[10px] text-error">
            {tx("Review failed")}
          </span>
        </Show>
        <Show when={props.message.stop}>
          <span class="min-w-0 truncate font-mono text-[11px] text-az-muted">
            {props.message.stop}
          </span>
        </Show>
        <Show when={props.message.review?.headSha}>
          <span class="shrink-0 font-mono text-[10px] text-az-muted">
            {tx("head {sha}", { sha: props.message.review!.headSha.slice(0, 8) })}
          </span>
        </Show>
        <span class="ml-auto shrink-0">
          <CopyMessageButton body={props.message.body} />
        </span>
      </div>
      <MessageBody body={props.message.body} class={AGENT_TEXT} />
      <MessageTime at={props.message.createdAt} />
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
