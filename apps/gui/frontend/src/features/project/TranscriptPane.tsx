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
import { chromeRevision } from "~/features/project/transcriptChrome";
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
import { prefs, setPrefs } from "~/stores/prefs";
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
export function holdBackPartialDirective(text: string): string {
  /*
   * Only the last line is searched, and that is the whole cost story.
   *
   * This runs on every streaming token. `lastIndexOf("<ps")` over the whole
   * body has to reach the start of the string before it can report a miss, and
   * a miss is the common case — most replies contain no directive at all — so
   * the scan was O(body) per token, which is the same quadratic the parse had.
   *
   * A directive is a line: `isPromptSyntaxDirectiveLine` in MessageBody takes
   * one line and requires the directive to span it exactly. So an unterminated
   * `<ps` can only be on the last line, and searching earlier lines could never
   * find one that mattered. The bound is exact, not a heuristic window.
   *
   * The one body this does not help is a reply with no newline anywhere, where
   * the last line is the whole reply. That is also the body for which the
   * answer genuinely depends on all of it.
   */
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = lineStart === 0 ? text : text.slice(lineStart);

  // The *last* `<ps` on that line, not the first: `<ps a> <ps b` is a complete
  // directive followed by a partial one, and it is the partial one that has to
  // be held back.
  const openInLine = line.lastIndexOf("<ps");
  if (openInLine === -1) return text;

  // A closing `>` after the last `<ps` means the directive is complete; nothing
  // to withhold. Only an unterminated trailing `<ps...` is held.
  const open = lineStart + openInLine;
  const closed = text.indexOf(">", open);
  return closed === -1 ? text.slice(0, open) : text;
}

const TRANSCRIPT_PAGE_SIZE = 12;

/**
 * The ceiling on mounted rows, in pages.
 *
 * Revealing earlier messages used to only ever grow the window, and nothing
 * shrank it: reading up through a two hundred message thread mounted every row
 * it passed and kept them for the rest of the session. Every later layout then
 * paid for a tree that no one was looking at, which made the transcript the
 * largest single lever on tree size in the window.
 *
 * Past this many rows a reveal slides instead of growing: a page appears above
 * and the page furthest below the reader is dropped, so the transcript costs
 * the same whether the thread holds forty messages or four thousand. Four
 * pages is roughly four screenfuls, which is as far as anyone reads in one
 * movement before they start scrolling again.
 */

/**
 * How near the bottom still counts as the bottom, in CSS pixels.
 *
 * Fractional layout means `scrollHeight - clientHeight` and the position
 * actually reached can disagree by up to a pixel, and a transcript that stops a
 * pixel short stops following. One line of body text is the smallest slack that
 * survives that without swallowing a deliberate scroll away from the bottom.
 */
const TAIL_SLACK = 24;

/**
 * How long the transcript takes to slide back onto the tail after something
 * below it changed height, in milliseconds.
 */
const TAIL_GLIDE_MS = 160;

export const TRANSCRIPT_MAX_ENTRIES = TRANSCRIPT_PAGE_SIZE * 4;

/** One row of the transcript: a message, or an answered question above it. */
type TimelineEntry =
  | { kind: "message"; at: string; message: Message; index: number }
  | { kind: "question"; at: string; question: Question };

/**
 * The row's durable identity.
 *
 * Doubles as the wrapper cache key and as the handle the mounted window holds
 * its lower edge by. It has to be the underlying row's id rather than a
 * position, because the timeline grows underneath a reader who is scrolled up.
 */
function entryKey(entry: TimelineEntry): string {
  return entry.kind === "message" ? `m:${entry.message.id}` : `q:${entry.question.id}`;
}

/**
 * Whether a cached row can be reused, meaning `<For>` must not rebuild it.
 *
 * Compares the fields the row is built from rather than the wrapper, because
 * the wrapper is what we are trying to keep stable. The underlying message or
 * question is compared by reference: the store replaces it on change, so a
 * changed row fails this and correctly gets a new identity.
 */
function sameEntry(a: TimelineEntry, b: TimelineEntry): boolean {
  if (a.kind !== b.kind || a.at !== b.at) return false;
  if (a.kind === "message" && b.kind === "message") {
    return a.message === b.message && a.index === b.index;
  }
  if (a.kind === "question" && b.kind === "question") {
    return a.question === b.question;
  }
  return false;
}

/**
 * The mounted slice of the timeline, bounded at both ends.
 *
 * `visibleCount` is how much the reader has asked to see and `trailingHidden`
 * is how many of the newest rows have been dropped to pay for it. Both are
 * clamped here rather than at the call sites, so the window cannot exceed the
 * ceiling however the signals behind them got there. The bound is a property
 * of this function, not a discipline the caller has to keep.
 */
export function transcriptTail<T>(
  entries: T[],
  visibleCount: number,
  trailingHidden = 0,
): {
  hidden: number;
  trailing: number;
  visible: T[];
} {
  const size = Math.min(Math.max(1, visibleCount), TRANSCRIPT_MAX_ENTRIES);
  const trailing = Math.max(0, Math.min(trailingHidden, entries.length - size));
  const end = entries.length - trailing;
  const hidden = Math.max(0, end - size);
  return { hidden, trailing, visible: entries.slice(hidden, end) };
}

export function shouldRevealEarlier(
  scrollTop: number,
  hidden: number,
  ownerIntent: boolean,
): boolean {
  return ownerIntent && hidden > 0 && scrollTop <= 48;
}

/**
 * The mirror of `shouldRevealEarlier` for the bottom edge, which only exists
 * once the window has started sliding and there are newer rows below it.
 * Owner intent is required on both edges for the same reason: reflow and
 * resize clamp scrollTop on their own and must not page the transcript.
 */
export function shouldRevealLater(
  distanceToTail: number,
  trailing: number,
  ownerIntent: boolean,
): boolean {
  return ownerIntent && trailing > 0 && distanceToTail <= 48;
}

export function anchoredScrollTop(
  previousTop: number,
  previousHeight: number,
  nextHeight: number,
): number {
  return previousTop + Math.max(0, nextHeight - previousHeight);
}

/**
 * Scroll offset that leaves the anchor row under the same pixel it occupied.
 *
 * `gap` is the row's top edge measured from the scroller's top edge. A slide
 * adds rows above and drops rows below in one commit, so the change in total
 * height says nothing about how far the row the reader is looking at actually
 * moved; the row's own displacement does, in both directions.
 */
export function anchoredToRow(currentTop: number, previousGap: number, nextGap: number): number {
  return Math.max(0, currentTop + nextGap - previousGap);
}

/** How far the row's top edge sits below the scroller's top edge, right now. */
function rowGap(scroller: HTMLElement, row: Element): number {
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

/**
 * The topmost row still inside the viewport, which is the one the reader is
 * looking at and therefore the one to keep still. Undefined when there is
 * nothing laid out to measure, which is every headless test.
 *
 * The reveal affordances are skipped deliberately. They bracket the rows, so
 * at the top of the scroller the "show earlier" button is the first thing the
 * viewport touches, and anchoring on it would hold the button still and push a
 * whole page of prose down past the reader: the exact yank this is here to
 * prevent, at the one moment the reveal always fires.
 */
export function viewportAnchor(scroller: HTMLElement): { row: Element; gap: number } | undefined {
  const box = scroller.getBoundingClientRect();
  for (const row of Array.from(scroller.children)) {
    if (row.hasAttribute("data-transcript-edge")) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom > box.top) return { row, gap: rect.top - box.top };
  }
  return undefined;
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
  let scroller!: HTMLElement;
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
  /*
   * Following the tail is a property of the conversation, not of this
   * component, so it lives in prefs keyed by project.
   *
   * It used to be a local signal, and switching tabs unmounts the project
   * screen: coming back re-armed the follow for a reader who had deliberately
   * scrolled up, and dropped it for one who had not.
   */
  const pinned = (): boolean => prefs.transcriptAtBottom[props.project.id] ?? true;
  const setPinned = (value: boolean): void => {
    if (pinned() === value) return;
    setPrefs("transcriptAtBottom", props.project.id, value);
  };
  const [visibleEntries, setVisibleEntries] = createSignal(TRANSCRIPT_PAGE_SIZE);
  /*
   * The newest row the window is allowed to mount, by key, once the window has
   * reached its ceiling and begun sliding. Undefined means the window ends at
   * the tail, which is the normal state and the only one that follows new
   * messages.
   *
   * A key rather than a count from the end: while the reader is up in the
   * history the agent keeps appending, and a count would walk the window one
   * row towards the tail per streamed message, pulling the text out from under
   * them. A key holds still. A key whose row no longer exists (a compaction can
   * replace a stretch of thread) resolves to no trailing rows, so the window
   * quietly falls back to the tail rather than showing a gap it cannot place.
   */
  const [windowEdge, setWindowEdge] = createSignal<string | undefined>();
  let lastScrollTop = 0;
  let userScrollIntent = false;
  let slidingWindow = false;
  let revealFrame: number | undefined;
  const markScrollIntent = (): void => {
    userScrollIntent = true;
  };
  /*
   * Move the mounted window, then put the reader back where they were.
   *
   * Anchoring on a row rather than on `scrollHeight` is what makes sliding
   * possible at all: a slide adds a page above and drops a page below in one
   * commit, so the height delta is the difference between two unrelated pages
   * of prose and says nothing about the displacement the reader would feel.
   * The height fallback covers the case where no row is laid out to measure.
   */
  const slideWindow = (move: () => void): void => {
    if (slidingWindow) return;
    slidingWindow = true;
    const previousHeight = scroller.scrollHeight;
    const previousTop = scroller.scrollTop;
    const anchor = viewportAnchor(scroller);
    move();
    const restoreAnchor = (): void => {
      revealFrame = undefined;
      scroller.scrollTop = anchor?.row.isConnected
        ? anchoredToRow(scroller.scrollTop, anchor.gap, rowGap(scroller, anchor.row))
        : anchoredScrollTop(previousTop, previousHeight, scroller.scrollHeight);
      lastScrollTop = scroller.scrollTop;
      slidingWindow = false;
    };
    if (typeof requestAnimationFrame === "undefined") queueMicrotask(restoreAnchor);
    else revealFrame = requestAnimationFrame(restoreAnchor);
  };
  const revealEarlier = (): void => {
    const view = visibleTimeline();
    if (slidingWindow || view.hidden === 0) return;
    setPinned(false);
    slideWindow(() => {
      const size = untrack(visibleEntries);
      if (size < TRANSCRIPT_MAX_ENTRIES) {
        setVisibleEntries(Math.min(TRANSCRIPT_MAX_ENTRIES, size + TRANSCRIPT_PAGE_SIZE));
        return;
      }
      // At the ceiling the page revealed above is paid for by dropping the
      // page furthest below the reader. This is the eviction: without it the
      // window only grew and a long read mounted the whole thread.
      const entries = untrack(timeline);
      const edge = entries.length - view.trailing - 1 - TRANSCRIPT_PAGE_SIZE;
      setWindowEdge(entryKey(entries[Math.max(0, edge)]));
    });
  };
  const revealLater = (): void => {
    const view = visibleTimeline();
    if (slidingWindow || view.trailing === 0) return;
    slideWindow(() => {
      const entries = untrack(timeline);
      const edge =
        entries.length - view.trailing - 1 + Math.min(TRANSCRIPT_PAGE_SIZE, view.trailing);
      // Reaching the newest row hands the window back to the tail, so arriving
      // messages mount again and the follow can re-engage on the next scroll.
      setWindowEdge(edge >= entries.length - 1 ? undefined : entryKey(entries[edge]));
    });
  };
  const trackScroll = (): void => {
    const top = scroller.scrollTop;
    const ownerIntent = userScrollIntent;
    const view = visibleTimeline();
    const toTail = scroller.scrollHeight - top - scroller.clientHeight;
    // Reaching the bottom of a slid window is not reaching the conversation:
    // pinning there would follow a tail that is not mounted, leaving the
    // transcript apparently frozen on old messages while it claims to be live.
    if (toTail <= TAIL_SLACK && view.trailing === 0) {
      setPinned(true);
    } else if (top < lastScrollTop - 1 && ownerIntent) {
      // Only owner input disengages tail following. Window resizing and text
      // reflow can clamp scrollTop upward and dispatch a scroll event of their
      // own; treating that as reading intent is the intermittent jump that
      // leaves an otherwise pinned transcript just above the bottom.
      setPinned(false);
    }
    userScrollIntent = false;
    lastScrollTop = top;
    if (shouldRevealEarlier(top, view.hidden, ownerIntent)) revealEarlier();
    else if (shouldRevealLater(toTail, view.trailing, ownerIntent)) revealLater();
  };

  let followFrame: number | undefined;
  let glideFrame: number | undefined;
  const cancelGlide = (): void => {
    if (glideFrame === undefined) return;
    cancelAnimationFrame(glideFrame);
    glideFrame = undefined;
  };
  /*
   * Slide to the tail instead of jumping, when the tail moved because something
   * else did.
   *
   * A panel opening below shortens the scroller, and snapping the text up by
   * that much reads as the conversation flinching: the eye has nothing to
   * follow between the two positions. Over a few frames the cause is legible.
   *
   * Chrome only. Streamed text stays instant: a token lands every few frames,
   * each would start a new glide, and the tail would trail the text it is
   * pinned to.
   */
  const glideTo = (target: number): void => {
    if (
      typeof requestAnimationFrame === "undefined" ||
      typeof cancelAnimationFrame === "undefined"
    ) {
      scroller.scrollTop = target;
      lastScrollTop = scroller.scrollTop;
      return;
    }
    cancelGlide();
    const from = scroller.scrollTop;
    const distance = target - from;
    if (Math.abs(distance) < 2) {
      scroller.scrollTop = target;
      lastScrollTop = scroller.scrollTop;
      return;
    }
    const started = Date.now();
    const step = (): void => {
      // A reader who scrolled away mid-glide has taken over: stop where they
      // put it rather than finishing a move they no longer want.
      if (!pinned()) {
        glideFrame = undefined;
        return;
      }
      const t = Math.min(1, (Date.now() - started) / TAIL_GLIDE_MS);
      scroller.scrollTop = from + distance * (1 - (1 - t) ** 3);
      lastScrollTop = scroller.scrollTop;
      glideFrame = t < 1 ? requestAnimationFrame(step) : undefined;
    };
    glideFrame = requestAnimationFrame(step);
  };

  const followTail = (options?: { animate?: boolean }): void => {
    if (!pinned()) return;
    const animate = options?.animate ?? false;
    const moveToTail = (): void => {
      if (!pinned()) return;
      // The bottom, not the height. Assigning the full height overshoots by a
      // viewport and leans on the engine clamping it back; the slack on top is
      // the deliberate part, absorbing fractional layout so the last line
      // cannot end up under the fold. Nothing to scroll means nothing to do.
      const bottom = scroller.scrollHeight - scroller.clientHeight;
      const target = bottom > 0 ? bottom + TAIL_SLACK : 0;
      if (animate) {
        glideTo(target);
        return;
      }
      cancelGlide();
      scroller.scrollTop = target;
      lastScrollTop = scroller.scrollTop;
    };
    queueMicrotask(moveToTail);
    if (typeof requestAnimationFrame !== "undefined") {
      if (followFrame !== undefined) cancelAnimationFrame(followFrame);
      const afterLayout = (remaining: number): void => {
        followFrame = requestAnimationFrame(() => {
          followFrame = undefined;
          moveToTail();
          // Blitz can commit the initial DOM in one frame and finish its first
          // layout in the next. A single callback then reads the old height and
          // leaves a newly opened transcript at the top. Retry once after that
          // layout without turning this into an open-ended animation loop.
          if (remaining > 1 && pinned()) afterLayout(remaining - 1);
        });
      };
      afterLayout(2);
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
      mutationObserver = new MutationObserver(() => followTail());
      mutationObserver.observe(scroller, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    followTail();
  });
  // The footer changed height, so the tail moved. `untrack` inside `followTail`
  // keeps this from subscribing to `pinned`: a reader who scrolled up must not
  // be yanked back by a PR chip arriving.
  createEffect(() => {
    chromeRevision();
    followTail({ animate: true });
  });
  onCleanup(() => {
    cancelGlide();
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    if (followFrame !== undefined && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(followFrame);
    }
    if (revealFrame !== undefined && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(revealFrame);
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
  /*
   * Stable identities, deliberately.
   *
   * `<For>` reconciles by object reference. This memo used to build a fresh
   * wrapper for every row on every recompute, and `props.messages` changes on
   * every streaming token, so each token tore down and rebuilt the entire
   * visible transcript rather than updating one row. That is why the header
   * chip jumped, why panels lost their expanded state, and why scrolling was
   * never smooth: the rows under the cursor were being destroyed and recreated
   * continuously.
   *
   * Reusing a wrapper whenever its underlying row is unchanged means only the
   * row that actually changed gets a new identity, so only that row rebuilds.
   */
  const entryCache = new Map<string, TimelineEntry>();
  const stableEntry = (key: string, next: TimelineEntry): TimelineEntry => {
    const previous = entryCache.get(key);
    if (previous && sameEntry(previous, next)) return previous;
    entryCache.set(key, next);
    return next;
  };

  const timeline = createMemo(() => {
    const questions = questionsFor()
      .filter((question) => question.answered)
      .map((q) => {
        const reply = props.messages.find((message) => message.replyToQuestionId === q.id);
        return stableEntry(`q:${q.id}`, {
          kind: "question" as const,
          at: reply?.createdAt ?? q.createdAt,
          question: q,
        });
      });
    const messages = props.messages.map((message, index) =>
      stableEntry(`m:${message.id}`, {
        kind: "message" as const,
        at: message.createdAt,
        message,
        index,
      }),
    );
    // Rows that no longer exist must not pin their wrapper alive: a long
    // session would otherwise accumulate one entry per message ever seen.
    if (entryCache.size > messages.length + questions.length) {
      const live = new Set([
        ...props.messages.map((message) => `m:${message.id}`),
        ...questionsFor().map((question) => `q:${question.id}`),
      ]);
      for (const key of [...entryCache.keys()]) {
        if (!live.has(key)) entryCache.delete(key);
      }
    }
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
  const visibleTimeline = createMemo(() => {
    const entries = timeline();
    const edge = windowEdge();
    // The scan only runs while the reader is holding a position up in the
    // history, which is rare and short-lived; the ordinary tail case never
    // touches the list.
    const at = edge === undefined ? -1 : entries.findIndex((entry) => entryKey(entry) === edge);
    return transcriptTail(entries, visibleEntries(), at === -1 ? 0 : entries.length - 1 - at);
  });

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
    <section
      ref={scroller}
      aria-label={tx("Conversation")}
      tabindex="0"
      onScroll={trackScroll}
      onWheel={markScrollIntent}
      onPointerDown={markScrollIntent}
      onPointerMove={(event) => event.buttons !== 0 && markScrollIntent()}
      onTouchMove={markScrollIntent}
      onKeyDown={(event) => {
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) markScrollIntent();
      }}
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
            onClick={revealEarlier}
            data-transcript-edge
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
        {/* The counterpart to "show earlier", and the only visible sign that
            the window slid: below it the transcript jumps forward to whatever
            is live, so the seam has to be named rather than left as a silent
            discontinuity. Scrolling into it reveals the next page anyway. */}
        <Show when={visibleTimeline().trailing > 0}>
          <button
            type="button"
            onClick={revealLater}
            data-transcript-edge
            class="mx-auto rounded-full border border-az-hairline-strong px-3 py-1 text-[11px] text-az-muted transition-colors hover:border-primary/50 hover:text-az-body"
          >
            {tx("Show {count} newer messages", {
              count: Math.min(TRANSCRIPT_PAGE_SIZE, visibleTimeline().trailing),
            })}
          </button>
        </Show>
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
    </section>
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
/*
 * `min-w-0` and `overflow-hidden` alongside the cap.
 *
 * `max-w-[88%]` bounds the bubble, but a child sizing to its max-content
 * ignores that and draws past the painted background: the text ran on while
 * the bubble ended, which reads as text escaping its own message. The first
 * forces the child to take the bubble's width rather than its content's, the
 * second makes any remaining overflow visible as clipping rather than as text
 * floating over the page.
 */
/* No `min-w-0` or `overflow-hidden` here. Both were added to stop long words
 * escaping the bubble, and under Blitz they let a `self-start` child collapse
 * to zero width instead: the agent's messages rendered, measured nothing and
 * were clipped away entirely, so the transcript looked empty. Wrapping belongs
 * to the text, and `MessageBody` already carries `break-words` and
 * `[overflow-wrap:anywhere]` for it. */
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
    <div class="group flex min-w-0 items-center gap-3 py-0.5">
      <span class="h-px flex-1 bg-az-hairline" />
      <span
        data-selectable
        class={`flex min-w-0 items-center gap-1.5 text-center text-[11.5px] ${
          failed() ? "text-error" : "text-az-muted"
        }`}
      >
        <Icon name={failed() ? "info" : "sparkles"} class="relative top-px shrink-0 text-[12px]" />
        {/*
          `min-w-0` and a truncating span, because the cost beside it is
          `shrink-0`. A flex child will not shrink below its content width
          without `min-w-0`, so a long note (a compaction naming how many
          rules it kept) grew past the row and ran underneath the cost
          readout instead of ending in an ellipsis.
        */}
        <span class="min-w-0 truncate" title={props.message.body}>
          {props.message.body}
        </span>
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
