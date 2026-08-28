import { Empty, Flex } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  flush,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { ApprovalCard } from "~/features/project/ApprovalCard";
import { CopyMessageButton, InlineText, MessageBody } from "~/features/project/MessageBody";
import {
  anchoredScrollTop,
  anchoredToRow,
  holdBackPartialDirective,
  shouldRevealEarlier,
  shouldRevealLater,
  TRANSCRIPT_MAX_ENTRIES,
  TRANSCRIPT_PAGE_SIZE,
  transcriptTail,
} from "~/features/project/transcriptLogic";
import {
  isCybersecurityRefusal,
  isRetryableStop,
  isSuccessfulStop,
  isTransientStop,
  relativeTime,
} from "~/lib/format";
import { AGENT_LABELS } from "~/lib/labels";
import { log } from "~/lib/log";
import { record as recordPerf } from "~/lib/perf";
import { costLabel, estimateTurnCost } from "~/lib/pricing";
import { compactCount } from "~/lib/stats";
import { agentTurnLabels, streamingTurnNumber } from "~/lib/turns";
import { tx } from "~/stores/i18n";
import { type RunStatus, useNow, useWorkspace } from "~/stores/workspace";
import type { Message, MessageReceipt as MessageReceiptState, Project, Question } from "~/types";

const STARTERS = () => [
  tx("Review the GUI crate"),
  tx("Wire the Solid frontend"),
  tx("Audit the proxies"),
];

/**
 * Hold back a directive while it is the live tail, so a `<ps @agency:...>` span
 * never flashes on screen before the settled-message parser removes it.
 *
 * Applied to the LIVE stream only. If the tail of the text so far contains a
 * `<ps` that has not yet reached its closing `>`, everything from that `<ps`
 * onward is withheld. Once it closes, a valid standalone AgencyZero directive
 * remains withheld until another line arrives; then `MessageBody` removes it.
 * This two-stage rule matters because provider adapters split text differently:
 * Codex can deliver the closing `>` as its own delta, while Claude commonly
 * delivers the whole line. Releasing the completed tail made only the first
 * shape flash the control syntax to the owner.
 */
/** Fractional layout may leave the reachable tail within a pixel of max. */
const TAIL_SLACK = 24;

/** Arrow-key movement in CSS pixels. Page keys use the viewport height. */
const KEYBOARD_LINE_STEP = 48;

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
/*
 * Anything below the transcript that changes height, announced.
 *
 * The transcript is a flex child above a footer that grows and shrinks: PR
 * chips, a queued compaction, held prompts, the cost warning. When the footer
 * grows the scroller gets shorter, and a pinned transcript has to be put back
 * on the tail or the newest message is left half-cut under the chrome, which is
 * exactly what the owner sees as "dialogs are not pushing the chat up".
 *
 * A `ResizeObserver` would be the natural way to notice, and this file already
 * asks for one. **Blitz implements neither `ResizeObserver` nor
 * `MutationObserver`**, and both are behind `typeof … !== "undefined"` guards,
 * so both paths have been dead the whole time and failed silently. Until the
 * engine grows them, the chrome says so explicitly.
 */
const [chromeRevision, bumpChromeRevision] = createSignal(0);

export function noteTranscriptChromeChanged(): void {
  bumpChromeRevision((value) => value + 1);
}

/** What the first frame mounts, before the window fills to a full page. */
const INITIAL_VISIBLE_ENTRIES = 4;

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
/**
 * The mirror of `shouldRevealEarlier` for the bottom edge, which only exists
 * once the window has started sliding and there are newer rows below it.
 * Owner intent is required on both edges for the same reason: reflow and
 * resize clamp scrollTop on their own and must not page the transcript.
 */
/**
 * Scroll offset that leaves the anchor row under the same pixel it occupied.
 *
 * `gap` is the row's top edge measured from the scroller's top edge. A slide
 * adds rows above and drops rows below in one commit, so the change in total
 * height says nothing about how far the row the reader is looking at actually
 * moved; the row's own displacement does, in both directions.
 */
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

/** Zero is reserved for following the true tail; every reader offset is +1. */
export function encodeTranscriptPosition(scrollTop: number): number {
  if (!Number.isFinite(scrollTop)) return 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(scrollTop)) + 1);
}

/** Return the top-relative viewport offset represented by a non-tail position. */
export function decodeTranscriptPosition(position: number): number | undefined {
  return Number.isSafeInteger(position) && position > 0 ? position - 1 : undefined;
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
  /** What the reply being written will be numbered once it persists. */
  const streamingTurn = createMemo(() => streamingTurnNumber(props.messages));

  /*
   * Whether the view is at (or near) the tail. Reading up through a long
   * transcript while the agent streams used to be impossible: every delta
   * yanked the view back to the bottom. Now the tail is only followed while
   * you are already there; scroll up and new text appends below without
   * moving what you are reading. Coming back within a bubble's height of the
   * bottom re-engages the follow.
   */
  const transcriptPosition = (): number => state.transcriptPositions[props.project.id] ?? 0;
  const pinned = (): boolean => transcriptPosition() === 0;
  const rememberReaderPosition = (top = scroller.scrollTop): void => {
    actions.setProjectTranscriptPosition(props.project.id, encodeTranscriptPosition(top));
  };
  const setPinned = (value: boolean): void => {
    if (pinned() === value) return;
    actions.setProjectTranscriptPosition(
      props.project.id,
      value ? 0 : encodeTranscriptPosition(scroller.scrollTop),
    );
  };
  /*
   * The first frame carries only what a reader can actually see; the rest of the
   * page arrives over the frames after it.
   *
   * A row costs 8 to 14ms to build in this engine, almost all of it message body
   * rendering, so a full page of twelve is 94 to 168ms of the pane's first
   * reveal no matter how few of them fit on screen. Four covers the visible tail
   * at any panel width, and the window fills to a full page immediately after,
   * re-pinning as it goes so the newest row stays put while older ones mount
   * above it.
   *
   * The panel being open or closed changes the pane's width and therefore how
   * tall each row is, so this cannot be a count that assumes a shape. It is
   * deliberately below what the shortest rows would fill and corrected by
   * `followTail`, rather than computed from a height that is not settled yet.
   */
  const [visibleEntries, setVisibleEntries] = createSignal(INITIAL_VISIBLE_ENTRIES);
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
  const slideWindow = (move: () => void, afterRestore?: () => void): void => {
    if (slidingWindow) return;
    slidingWindow = true;
    const previousHeight = scroller.scrollHeight;
    const previousTop = scroller.scrollTop;
    const anchor = viewportAnchor(scroller);
    move();
    const restoreAnchor = (): void => {
      revealFrame = undefined;
      /*
       * Clamped, because neither helper knows the viewport.
       *
       * Both compute a position from heights alone, and a position past
       * `scrollHeight - clientHeight` strands the view beyond the last pixel
       * of content: Blitz keeps the overshoot (its own scroll height measures
       * larger than the real maximum) and the pane paints nothing. See
       * `tailScroll.test.ts`.
       */
      const furthest = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const restored = anchor?.row.isConnected
        ? anchoredToRow(scroller.scrollTop, anchor.gap, rowGap(scroller, anchor.row))
        : anchoredScrollTop(previousTop, previousHeight, scroller.scrollHeight);
      scroller.scrollTop = Math.max(0, Math.min(furthest, restored));
      lastScrollTop = scroller.scrollTop;
      if (!untrack(pinned)) rememberReaderPosition();
      slidingWindow = false;
      afterRestore?.();
      // Outside the reactive system: Solid 2 queues these writes and nothing
      // here drains that queue. See the flush in `fill`.
      flush();
    };
    if (typeof requestAnimationFrame === "undefined") queueMicrotask(restoreAnchor);
    else revealFrame = requestAnimationFrame(restoreAnchor);
  };
  /*
   * Fill the window to a full page over the frames after the first.
   *
   * Each step re-pins, because the rows arriving mount *above* the newest one:
   * without that the tail would walk down the screen as the page filled. A
   * reader who has scrolled away is left alone, since `followTail` is a no-op
   * once unpinned.
   *
   * Driven by frames rather than a timer so it yields between steps and cannot
   * turn into one long block, which is the thing it exists to avoid.
   */
  onSettled(() => {
    if (typeof requestAnimationFrame === "undefined") {
      setVisibleEntries(TRANSCRIPT_PAGE_SIZE);
      return;
    }
    let fillFrame: number | undefined;
    /*
     * The step count lives here, not in the signal it writes.
     *
     * This used to read `untrack(visibleEntries)` at the top of every frame.
     * Solid 2 defers a signal write, so that read returned the value from
     * before the previous frame's write every time: `size` stayed at
     * `INITIAL_VISIBLE_ENTRIES`, each frame rewrote the same number, and the
     * window never grew past its first step however many frames ran. Solid 1
     * applied the write eagerly, which is the only reason reading it back
     * worked.
     *
     * A local counter is also simply the honest shape: this loop owns the
     * progression and does not need to ask the store where it got to.
     */
    let filled = untrack(visibleEntries);
    const fill = (): void => {
      if (filled >= TRANSCRIPT_PAGE_SIZE) return;
      filled = Math.min(TRANSCRIPT_PAGE_SIZE, filled + INITIAL_VISIBLE_ENTRIES);
      setVisibleEntries(filled);
      /*
       * A frame callback is outside the reactive system, and Solid 2 queues a
       * write rather than applying it. Nothing drains that queue from here, so
       * without this the write sits unapplied: the window stayed at its first
       * step however many frames ran, and the transcript mounted four rows
       * instead of a page. Solid 1 applied writes eagerly and needed no flush.
       */
      flush();
      followTail();
      fillFrame = requestAnimationFrame(fill);
    };
    fillFrame = requestAnimationFrame(fill);
    // Returned, not `onCleanup`: Solid 2 forbids it inside `onSettled`.
    return () => {
      if (fillFrame !== undefined) cancelAnimationFrame(fillFrame);
    };
  });

  const revealEarlier = (afterRestore?: () => void): void => {
    const view = visibleTimeline();
    /*
     * The store holds a page, not the whole transcript. Reaching the top of it
     * is the moment the rest is actually wanted, so it is fetched here rather
     * than on every tab open. `loadOlderMessages` is idempotent per project.
     */
    if (view.hidden === 0 && (state.messageTotals[props.project.id] ?? 0) > props.messages.length) {
      void actions
        .loadOlderMessages(props.project.id)
        .catch((cause) => log.warn(`could not load older messages: ${cause}`));
      return;
    }
    if (slidingWindow || view.hidden === 0) return;
    setPinned(false);
    slideWindow(() => {
      const size = untrack(visibleEntries);
      if (size < TRANSCRIPT_MAX_ENTRIES) {
        setVisibleEntries(Math.min(TRANSCRIPT_MAX_ENTRIES, size + TRANSCRIPT_PAGE_SIZE));
        /*
         * Land it before the next reveal reads it back.
         *
         * Solid 2 queues the write, and `size` above is exactly that read: two
         * reveals in a row both saw the pre-reveal count, so the second asked
         * for a window it had already opened and the transcript stopped
         * growing after one page.
         */
        flush();
        return;
      }
      // At the ceiling the page revealed above is paid for by dropping the
      // page furthest below the reader. This is the eviction: without it the
      // window only grew and a long read mounted the whole thread.
      const entries = untrack(timeline);
      const edge = entries.length - view.trailing - 1 - TRANSCRIPT_PAGE_SIZE;
      setWindowEdge(entryKey(entries[Math.max(0, edge)]));
    }, afterRestore);
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
    if (ownerIntent && toTail > TAIL_SLACK) rememberReaderPosition(top);
    if (shouldRevealEarlier(top, view.hidden, ownerIntent)) revealEarlier();
    else if (shouldRevealLater(toTail, view.trailing, ownerIntent)) revealLater();
  };

  /**
   * Blitz has no browser default to rely on for a focusable overflow region.
   * Drive the same scroll offset a native chat would, then feed the resulting
   * position through the ordinary intent tracker so Page Up disengages follow
   * and Page Down or End re-engages it only at the true tail.
   */
  const navigateByKeyboard = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    let target: number | undefined;
    switch (event.key) {
      case "ArrowUp":
        target = scroller.scrollTop - KEYBOARD_LINE_STEP;
        break;
      case "ArrowDown":
        target = scroller.scrollTop + KEYBOARD_LINE_STEP;
        break;
      case "PageUp":
        if (visibleTimeline().hidden > 0 && scroller.scrollTop <= scroller.clientHeight + 48) {
          event.preventDefault();
          setPinned(false);
          const page = scroller.clientHeight;
          const previousTop = scroller.scrollTop;
          const previousHeight = scroller.scrollHeight;
          revealEarlier(() => {
            // Use the height delta rather than the transient anchor position.
            // Blitz may expose the newly mounted edge control before its rows
            // finish their final line layout; subtracting from that provisional
            // scrollTop leaves "Show earlier messages" as the whole viewport.
            scroller.scrollTop = Math.max(
              0,
              anchoredScrollTop(previousTop, previousHeight, scroller.scrollHeight) - page,
            );
            lastScrollTop = scroller.scrollTop;
            rememberReaderPosition();
          });
          return;
        }
        target = scroller.scrollTop - scroller.clientHeight;
        break;
      case "PageDown":
        target = scroller.scrollTop + scroller.clientHeight;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    const previous = scroller.scrollTop;
    userScrollIntent = true;
    scroller.scrollTop = Math.max(0, Math.min(max, target));
    // A keyboard navigation command is owner intent by definition. Do not make
    // it depend on a later scroll event or on `lastScrollTop` having observed
    // the renderer's most recent presentation adjustment first.
    if (scroller.scrollTop < previous) setPinned(false);
    trackScroll();
  };

  let followFrame: number | undefined;
  let restoreReaderFrame: number | undefined;
  const followTail = (): void => {
    if (!untrack(pinned)) return;
    const moveToTail = (): void => {
      if (!untrack(pinned)) return;
      /*
       * The ref may not be bound yet.
       *
       * `scroller` is declared with `!`, which was true under Solid 1: refs
       * were assigned before any effect ran, so a microtask or frame callback
       * could assume one. Solid 2 runs effects earlier, so both deferred paths
       * below can fire on a pane whose element does not exist yet, and the
       * assertion hides that from the type checker rather than preventing it.
       * There is nothing to scroll until it is bound, and the next follow does
       * the work.
       */
      if (!scroller) return;
      /*
       * The tail, and never past it.
       *
       * This used to write `bottom + TAIL_SLACK` and rely on the platform
       * taking the overshoot back, which is what a browser does. Blitz clamps
       * an assigned `scrollTop` against its own `scroll_height`, and that
       * number runs larger than `scrollHeight - clientHeight` on real panes:
       * measured on a fresh launch, this scroller sat at 2583 with a true
       * maximum of 2226.8, so the viewport was parked 356px past the end of
       * the transcript and the pane painted nothing at all. It reads as the
       * app going blank, and it comes back on any scroll because a scroll
       * re-runs the clamp.
       *
       * The slack exists so a near-miss still counts as the tail; it belongs
       * in the comparison that decides whether we are pinned, not in the
       * offset we write. Asking for exactly the bottom is unambiguous.
       */
      const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = bottom;
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
          if (remaining > 1 && untrack(pinned)) afterLayout(remaining - 1);
        });
      };
      afterLayout(2);
    }
  };

  const restoreReaderPosition = (): void => {
    const remembered = decodeTranscriptPosition(untrack(transcriptPosition));
    if (remembered === undefined || untrack(pinned)) return;
    const restore = (): void => {
      if (state.activeKey !== props.project.id || untrack(pinned)) return;
      scroller.scrollTop = Math.max(
        0,
        Math.min(scroller.scrollHeight - scroller.clientHeight, remembered),
      );
      lastScrollTop = scroller.scrollTop;
    };
    queueMicrotask(restore);
    if (typeof requestAnimationFrame !== "undefined") {
      if (restoreReaderFrame !== undefined) cancelAnimationFrame(restoreReaderFrame);
      restoreReaderFrame = requestAnimationFrame(() => {
        restoreReaderFrame = undefined;
        restore();
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
  onSettled(() => {
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
  // The footer changed height, so the tail moved. `untrack` inside `followTail`
  // keeps this from subscribing to `pinned`: a reader who scrolled up must not
  // be yanked back by a PR chip arriving.
  createEffect(
    () => {
      chromeRevision();
      followTail();
    },
    () => {},
  );
  onCleanup(() => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    if (followFrame !== undefined && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(followFrame);
    }
    if (restoreReaderFrame !== undefined && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(restoreReaderFrame);
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
  let timelineReported = false;
  let turnLabelsReported = false;
  const turnLabels = createMemo(() => {
    const from = performance.now();
    const labels = agentTurnLabels(props.messages);
    recordPerf("transcript: turn labels", performance.now() - from);
    if (!turnLabelsReported) {
      turnLabelsReported = true;
      log.info(
        `turnLabels first build ${(performance.now() - from).toFixed(0)}ms over ${props.messages.length} messages`,
      );
    }
    return labels;
  });
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

  /*
   * The return type is annotated rather than inferred.
   *
   * Solid 2's `createMemo` infers from the body, and this body reads
   * `entryCache` and calls `stableEntry`, both of which are typed in terms of
   * `TimelineEntry`. That is a cycle the checker resolves to `never`, and a
   * `never` here collapses every read inside the memo: `props.messages`,
   * `questionsFor()`, even `entryCache.keys()`. Naming the type breaks the
   * cycle and takes nineteen errors with it.
   */
  const timeline = createMemo<TimelineEntry[]>(() => {
    const phaseStart = performance.now();
    /*
     * One pass to index the replies, then a lookup per question.
     *
     * This was `props.messages.find(...)` inside the map, which scans every
     * message once per answered question. Measured on a real project with 79
     * answered questions over 2,422 messages: 930ms of a 976ms timeline build,
     * which was itself the bulk of a 1,499ms first tab reveal. 191,338
     * iterations of a closure is not free in this engine.
     *
     * Only the timestamp is wanted, so the index holds that rather than the row.
     */
    const replyAt = new Map<string, string>();
    for (const message of props.messages) {
      const target = message.replyToQuestionId;
      if (target !== undefined && target !== null && !replyAt.has(target)) {
        replyAt.set(target, message.createdAt);
      }
    }
    const questions = questionsFor()
      .filter((question) => question.answered)
      .map((q) =>
        stableEntry(`q:${q.id}`, {
          kind: "question" as const,
          at: replyAt.get(q.id) ?? q.createdAt,
          question: q,
        }),
      );
    const questionsAt = performance.now();
    const messages = props.messages.map((message, index) =>
      stableEntry(`m:${message.id}`, {
        kind: "message" as const,
        at: message.createdAt,
        message,
        index,
      }),
    );
    const messagesAt = performance.now();
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
    const sweptAt = performance.now();
    const sorted = [...messages, ...questions].sort((a, b) => {
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
    recordPerf("transcript: timeline", performance.now() - phaseStart);
    if (!timelineReported) {
      timelineReported = true;
      const done = performance.now();
      log.info(
        `timeline first build ${(done - phaseStart).toFixed(0)}ms: ` +
          `questions ${(questionsAt - phaseStart).toFixed(0)}ms (${questions.length} over ${props.messages.length} messages), ` +
          `messages ${(messagesAt - questionsAt).toFixed(0)}ms, ` +
          `sweep ${(sweptAt - messagesAt).toFixed(0)}ms, ` +
          `sort ${(done - sweptAt).toFixed(0)}ms`,
      );
    }
    return sorted;
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
  createEffect(
    () => {
      props.messages.length;
      props.streaming;
      void state.runStatus[props.project.id];
      void (state.questions[props.project.id] ?? []).filter((question) => !question.answered)
        .length;
      followTail();
    },
    () => {},
  );

  // Retained project panes are `display:none` while another tab is active.
  // Layout work performed while hidden cannot provide a useful tail position,
  // and no message signal necessarily changes when the pane becomes visible
  // again. Visibility is therefore an explicit reason to realign, but only for
  // a project whose durable owner choice still says it follows the tail.
  /*
   * `on()` is gone in Solid 2, so the dependency is declared by reading it
   * first and the body runs untracked. That keeps the previous meaning
   * exactly: this effect re-runs when the active tab changes and for no
   * other reason, which matters because the body reads several signals it
   * must not subscribe to.
   */
  createEffect(
    () => {
      const activeKey = state.activeKey;
      untrack(() => {
        if (activeKey !== props.project.id) return;
        if (pinned()) followTail();
        else restoreReaderPosition();
      });
    },
    () => {},
  );

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
      aria-keyshortcuts="PageUp PageDown Home End ArrowUp ArrowDown"
      onScroll={trackScroll}
      onWheel={markScrollIntent}
      onPointerDown={(event) => {
        markScrollIntent();
        if (event.target === scroller) scroller.focus();
      }}
      onPointerMove={(event) => event.buttons !== 0 && markScrollIntent()}
      onTouchMove={markScrollIntent}
      onKeyDown={navigateByKeyboard}
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
          <Button
            type="button"
            onClick={() => revealEarlier()}
            data-transcript-edge
            class="mx-auto rounded-full border border-az-hairline-strong px-3 py-1 text-[11px] text-az-muted transition-colors hover:border-primary/50 hover:text-az-body"
          >
            {tx("Show {count} earlier messages", {
              count: Math.min(TRANSCRIPT_PAGE_SIZE, visibleTimeline().hidden),
            })}
          </Button>
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
          <Button
            type="button"
            onClick={revealLater}
            data-transcript-edge
            class="mx-auto rounded-full border border-az-hairline-strong px-3 py-1 text-[11px] text-az-muted transition-colors hover:border-primary/50 hover:text-az-body"
          >
            {tx("Show {count} newer messages", {
              count: Math.min(TRANSCRIPT_PAGE_SIZE, visibleTimeline().trailing),
            })}
          </Button>
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
                {/*
                  Numbered while it is still being written.

                  `agentTurnLabels` keys off message ids and a streaming reply
                  has none, so this bubble used to read `claude · writing…`
                  under a column of replies each carrying `Turn 26 · …`. The
                  number is already determined by the owner message that opened
                  the run, so holding it back until the run lands hides
                  something known — and made a live window look like it had lost
                  its turn bar next to a finished one.
                */}
                {tx("Turn {number}", { number: streamingTurn() })} ·{" "}
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
          <Button
            type="button"
            onClick={() => actions.selectQuestionReply(props.question.projectId, props.question.id)}
            aria-label={tx("Reply to this question")}
            class="rounded-full border border-primary/30 bg-az-chip px-2 py-0.5 font-semibold text-[10.5px] text-primary transition-colors hover:bg-az-chip"
          >
            {tx("Reply")}
          </Button>
          <Button
            type="button"
            onClick={() => void actions.answerQuestion(props.question.id, true)}
            aria-label={tx("Dismiss this question")}
            title={tx("Dismiss this question")}
            class="rounded p-0.5 text-az-faint transition-colors hover:bg-white/5 hover:text-az-body"
          >
            <Icon name="x" class="text-[13px]" />
          </Button>
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
        <Button
          type="button"
          onClick={() => void actions.cancelRun(props.projectId)}
          class="shrink-0 rounded-md border border-primary/16 px-2 py-px text-[11.5px] text-az-body transition-colors hover:border-error hover:text-error"
        >
          {tx("Cancel")}
        </Button>
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
            <Button
              type="button"
              onClick={() => retry()()}
              class="rounded-lg border border-primary/18 px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary"
            >
              {tx("Retry")}
            </Button>
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
      <Flex align="center" gap="sm">
        <Show when={props.turn}>
          {(turn) => (
            <span class="shrink-0 text-[10.5px] text-az-faint">
              {tx("Turn {number}", { number: turn() })} ·
            </span>
          )}
        </Show>
        <MessageTime at={props.message.createdAt} />
        <MessageCost message={props.message} />
      </Flex>
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
      <Flex align="center" gap="sm">
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
      </Flex>
      <MessageBody body={props.message.body} class={AGENT_TEXT} />
      <MessageTime at={props.message.createdAt} />
    </div>
  );
}

/** A stored moderator note; decisions stay disabled until the Phase 4 runner exists. */
function ModeratorNote(props: { message: Message }): JSX.Element {
  const { state, actions } = useWorkspace();
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
            <Button
              type="button"
              disabled={state.backend !== "mock"}
              onClick={() => void actions.resolveModeration(props.message.id, true)}
              class="rounded-lg bg-primary px-[13px] py-[5px] font-semibold text-[12px] text-primary-content transition-colors hover:bg-az-primary-hover"
            >
              {tx("Approve once")}
            </Button>
            <Button
              type="button"
              disabled={state.backend !== "mock"}
              onClick={() => void actions.resolveModeration(props.message.id, false)}
              class="rounded-lg border border-primary/18 px-3 py-[5px] text-[12px] text-az-body transition-colors hover:border-error hover:text-error"
            >
              {tx("Deny")}
            </Button>
            <Show
              when={state.backend === "mock"}
              fallback={
                <span class="text-[11.5px] text-az-muted">
                  {"· moderator decisions are not wired"}
                </span>
              }
            >
              <span class="text-[11.5px] text-az-muted">{tx("· agent is paused")}</span>
            </Show>
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
      <Empty class="flex flex-col items-center gap-3.5">
        <Empty.Icon>
          <div class="flex size-[54px] items-center justify-center rounded-2xl border border-az-hairline bg-base-300">
            <Icon name="message-square-dashed" class="text-[24px] text-az-faint" />
          </div>
        </Empty.Icon>
        <Empty.Title class="font-semibold text-[15px] text-base-content">
          {tx("Nothing open")}
        </Empty.Title>
        <Empty.Description class="max-w-[360px] text-center text-[12.5px] text-az-muted leading-[1.55]">
          {tx(
            "This project is connected and idle. Start the conversation, or pick an item from the panel on the right.",
          )}
        </Empty.Description>
        <Empty.Actions class="flex max-w-[430px] flex-wrap justify-center gap-2">
          <For each={STARTERS()}>
            {(starter) => (
              <Button
                type="button"
                onClick={() => props.onStart(starter)}
                class="rounded-full border border-az-hairline-strong px-3.5 py-1.5 text-[12px] text-az-body transition-colors hover:border-primary hover:text-primary"
              >
                {starter}
              </Button>
            )}
          </For>
        </Empty.Actions>
      </Empty>
    </div>
  );
}
