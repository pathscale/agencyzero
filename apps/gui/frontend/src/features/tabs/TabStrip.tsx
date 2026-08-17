import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "~/components/Button";
import { Icon, type IconProps } from "~/components/Icon";
import { StatusDot } from "~/components/StatusDot";
import { createTabReorder } from "~/features/tabs/reorder";
import { useTabShortcuts } from "~/features/tabs/shortcuts";
import { tx } from "~/stores/i18n";
import { useWorkspace } from "~/stores/workspace";
import type { Tab } from "~/types";

const PILL = "flex h-8 shrink-0 items-center rounded-full transition-colors";
const ACTIVE = "bg-az-tab shadow-[inset_0_1px_0_rgb(var(--az-sheen)/14%)]";
/*
 * `bg-az-hover`, not `bg-white/5`. Every surface here is hue-tinted
 * (`--az-hue`), so a flat white wash over one reads as grey laid on blue
 * rather than as the surface lifting. `--color-az-hover` is the same ladder one
 * step above `--color-az-tab`, which is what the row hover was named for.
 */
const IDLE = "border border-transparent text-az-muted hover:bg-az-hover hover:text-base-content";

const TAB_ICON: Record<Tab["kind"], IconProps["name"] | null> = {
  home: "layout-grid",
  draft: "file-plus-2",
  settings: "settings",
  analytics: "gauge",
  project: null,
};

const TAB_REVEAL_PADDING = 8;

export function horizontalRevealTarget(
  strip: Pick<HTMLElement, "clientWidth" | "scrollLeft" | "scrollWidth">,
  stripRect: Pick<DOMRect, "left" | "right">,
  itemRect: Pick<DOMRect, "left" | "right">,
): number | null {
  const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);

  if (itemRect.left < stripRect.left + TAB_REVEAL_PADDING) {
    return Math.max(0, strip.scrollLeft + itemRect.left - stripRect.left - TAB_REVEAL_PADDING);
  }
  if (itemRect.right > stripRect.right - TAB_REVEAL_PADDING) {
    return Math.min(
      maxScroll,
      strip.scrollLeft + itemRect.right - stripRect.right + TAB_REVEAL_PADDING,
    );
  }
  return null;
}

/**
 * The tab strip: Home · any Untitled draft · one tab per project · Settings.
 *
 * Home is not closable and stays first; everything else can be dragged into
 * any other position. Each project tab carries a coloured dot for its state —
 * the whole point being that you can see a tab go blocked while you are
 * working in a different one.
 */
export function TabStrip(): JSX.Element {
  const { state, actions, isLive } = useWorkspace();
  useTabShortcuts();

  let strip!: HTMLDivElement;
  const [overflow, setOverflow] = createSignal({ left: false, right: false });
  /** Arrows on screen at all, which is what changes the strip's usable width. */
  const arrowsShown = createMemo(() => overflow().left || overflow().right);

  const reorder = createTabReorder({
    onMove: actions.moveTab,
    onCommit: () => void actions.commitTabOrder(),
  });

  /** Which arrows are usable: whether there is anything left to scroll to. */
  function measure(): void {
    if (!strip) return;
    const slack = strip.scrollWidth - strip.clientWidth;
    // A pixel of tolerance: fractional layout widths make an exact comparison
    // report scrollable-by-0.4px and leave an arrow enabled forever.
    const next = { left: strip.scrollLeft > 1, right: strip.scrollLeft < slack - 1 };
    setOverflow((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }

  /** Roughly a screenful, so repeated presses walk the strip without overshooting. */
  function nudge(direction: -1 | 1): void {
    if (!strip) return;
    const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
    strip.scrollLeft = Math.min(
      maxScroll,
      Math.max(0, strip.scrollLeft + direction * Math.max(180, strip.clientWidth * 0.7)),
    );
    measure();
  }

  function reveal(key: string): void {
    const pill = [...(strip?.children ?? [])].find(
      (child) => (child as HTMLElement).dataset?.tabKey === key,
    ) as HTMLElement | undefined;
    if (!pill) return;
    const target = horizontalRevealTarget(
      strip,
      strip.getBoundingClientRect(),
      pill.getBoundingClientRect(),
    );
    if (target !== null) strip.scrollLeft = target;
    measure();
  }

  onSettled(() => {
    measure();
    // Width changes with the window and with how many tabs are open; neither
    // fires `scroll`. Guarded because jsdom has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    onCleanup(() => observer.disconnect());
  });

  onSettled(() => {
    const refresh = () => {
      void actions.refreshQuota();
      if (isLive("claudeUsage")) void actions.refreshClaudeUsage().catch(() => undefined);
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    onCleanup(() => window.clearInterval(interval));
  });

  /**
   * Keeps the active tab visible.
   *
   * This is what makes ⌘1/⌘2 usable once the strip overflows — cycling onto a
   * tab that is scrolled out of sight would otherwise look like nothing
   * happened. Reading `tabs.length` as well means a new tab is revealed too.
   */
  createEffect(() => {
    const key = state.activeKey;
    state.tabs.length;
    // Whether the arrows are on screen at all, rather than each end's flag.
    // The arrows take horizontal room, so the strip narrows when they appear
    // and the active tab has to be revealed again — but that is this
    // disjunction changing, not `left` or `right` moving on their own.
    //
    // Depending on them separately meant every trip to an end re-revealed:
    // leaving 0 turns `left` on and reaching the maximum turns `right` off,
    // neither of which changes the width. Driving the live strip, that cycled
    // "Scroll tabs right" between 0, 11 and 586 instead of walking to the end,
    // and looked intermittent because the middle of the travel flips nothing.
    //
    // It has to be the memo and not `overflow().left || overflow().right`:
    // reading the signal subscribes to the object, so either flag flipping
    // re-runs this no matter what is done with the values afterwards.
    arrowsShown();
    queueMicrotask(() => {
      reveal(key);
    });
  });

  return (
    /*
     * The strip is the title bar. `titleBarStyle: "Overlay"` leaves the window
     * with no native bar to grab, so this row has to be the drag handle.
     *
     * "deep" makes the whole subtree draggable, but Tauri's handler walks up
     * from the click target and stops at the first clickable element — so tabs,
     * "+" and the gear still take their clicks, and only the gaps between them
     * move the window. Needs `core:window:allow-start-dragging`, which is not
     * in `core:window:default`; see capabilities/default.json.
     */
    <div data-tauri-drag-region="deep" class="flex flex-none items-center gap-2 px-3.5 pt-3 pb-1.5">
      {/* Room for the macOS traffic lights, which the window keeps. */}
      <div class="w-[62px] shrink-0" />

      <Show when={overflow().left || overflow().right}>
        <ScrollArrow direction={-1} isDisabled={!overflow().left} onScroll={() => nudge(-1)} />
      </Show>

      <div
        ref={strip}
        onScroll={measure}
        class="az-scroll-x relative flex min-w-0 flex-1 items-center gap-2"
      >
        <For each={state.tabs}>
          {(tab) => <TabPill tab={tab} reorder={reorder} strip={() => strip} />}
        </For>

        <Button
          type="button"
          onClick={() => actions.openDraft()}
          title={tx("New project")}
          aria-label={tx("New project")}
          class="flex h-8 shrink-0 items-center justify-center rounded-full border border-primary/22 border-dashed px-3 text-az-muted transition-colors hover:border-primary hover:bg-primary/8 hover:text-primary"
        >
          <Icon name="plus" class="text-[15px]" />
        </Button>
      </div>

      <Show when={overflow().left || overflow().right}>
        <ScrollArrow direction={1} isDisabled={!overflow().right} onScroll={() => nudge(1)} />
      </Show>

      {/*
        The mask that tabs scroll under.
        `az-desk`, not `base-100`: it has to match what is actually behind the
        strip, and the panel colour is a different rung of the ladder — so it
        read as a foreign block with hard edges sitting on the desk. The fade
        carries the tab into it instead of cutting it off at a straight seam.
      */}
      <div class="az-strip-cap relative z-20 flex flex-none items-center gap-1.5 rounded-full pr-1 pl-5">
        <Button
          type="button"
          onClick={() => actions.openAnalytics()}
          title={tx("Analytics")}
          aria-label={tx("Analytics")}
          class={`relative flex size-[30px] items-center justify-center rounded-full transition-colors hover:bg-az-hover ${
            state.activeKey === "analytics"
              ? "text-primary"
              : "text-az-muted hover:text-base-content"
          }`}
        >
          <Icon name="gauge" class="text-[15px]" />
        </Button>
        <Button
          type="button"
          onClick={() => actions.openSettings()}
          title={
            state.availableUpdate
              ? tx("Update available: {version} — install from Settings", {
                  version: state.availableUpdate.version,
                })
              : tx("Settings")
          }
          aria-label={tx("Settings")}
          class={`relative flex size-[30px] items-center justify-center rounded-full transition-colors hover:bg-az-hover ${
            state.activeKey === "settings"
              ? "text-primary"
              : "text-az-muted hover:text-base-content"
          }`}
        >
          <Icon name="settings" class="text-[15px]" />
          {/* The update nudge: a dot, not a dialog. The gear is where the
              install button lives, so the dot points at its own remedy. */}
          <Show when={state.availableUpdate}>
            <span class="az-halo-primary absolute top-[3px] right-[3px] size-[7px] rounded-full bg-primary" />
          </Show>
        </Button>
        <div class="ml-1 flex size-[26px] items-center justify-center rounded-full bg-az-badge font-semibold text-[11px] text-base-content">
          N
        </div>
      </div>
    </div>
  );
}

/**
 * One end of the tab strip.
 *
 * Shown only while the strip overflows, and disabled rather than hidden at each
 * end so the row does not shift as you reach the edges. There is no visible
 * scrollbar to grab: a horizontal one under the tabs sits inside the window's
 * drag region and is a few pixels tall, which makes it unclickable in practice.
 */
function ScrollArrow(props: {
  direction: -1 | 1;
  isDisabled: boolean;
  onScroll: () => void;
}): JSX.Element {
  return (
    <Button
      type="button"
      onClick={props.onScroll}
      disabled={props.isDisabled}
      aria-label={props.direction === -1 ? tx("Scroll tabs left") : tx("Scroll tabs right")}
      class="flex size-6 shrink-0 items-center justify-center rounded-full text-az-muted transition-colors hover:bg-az-hover hover:text-base-content disabled:pointer-events-none disabled:opacity-25"
    >
      <Icon
        name="chevron-right"
        class={`text-[15px] ${props.direction === -1 ? "rotate-180" : ""}`}
      />
    </Button>
  );
}

/**
 * A tab label that keeps one width in every state.
 *
 * An active tab is semibold and an inactive one is not, so the label alone
 * would change width as you cycle and shove every tab to its right sideways.
 * The ghost copy is always semibold and always invisible; both copies share a
 * single grid cell, so the cell is sized for the widest and the visible copy
 * changes weight inside it without moving anything.
 */
function TabLabel(props: { label: string }): JSX.Element {
  return (
    <span class="grid min-w-0">
      <span aria-hidden="true" class="invisible col-start-1 row-start-1 truncate font-semibold">
        {props.label}
      </span>
      <span class="col-start-1 row-start-1 truncate">{props.label}</span>
    </span>
  );
}

/**
 * One pill.
 *
 * A `<div>` wrapping two real buttons rather than a button with a
 * pseudo-button inside it: nesting interactive controls is invalid HTML that
 * browsers resolve by quietly breaking the outer one.
 */
function TabPill(props: {
  tab: Tab;
  reorder: ReturnType<typeof createTabReorder>;
  strip: () => HTMLElement;
}): JSX.Element {
  const { state, actions, tabStatus } = useWorkspace();

  const isActive = () => props.tab.key === state.activeKey;
  const isProject = () => props.tab.kind === "project";
  const isClosable = () => props.tab.kind !== "home";
  // Home anchors the strip; there is nowhere for it to go.
  const isMovable = () => props.tab.kind !== "home";

  const shell = () => {
    if (props.tab.kind === "draft") {
      return isActive()
        ? `${PILL} border border-primary/30 border-dashed bg-az-tab text-base-content italic`
        : `${PILL} border border-primary/16 border-dashed text-az-muted italic hover:border-primary/30 hover:text-base-content`;
    }
    if (!isActive()) return `${PILL} ${IDLE} ${props.tab.kind === "home" ? "font-semibold" : ""}`;
    return props.tab.kind === "home"
      ? `${PILL} ${ACTIVE} border border-primary/34 font-semibold text-primary`
      : `${PILL} ${ACTIVE} border border-az-hairline-strong font-semibold text-base-content`;
  };

  return (
    /*
     * Padding sits on the buttons, not on this wrapper. The strip is a drag
     * region, so any bare padding here would be a dead strip inside the tab
     * that moves the window instead of switching to it.
     *
     * `group` drives the close button's reveal on hover.
     */
    <div
      data-tab-key={props.tab.key}
      class={`group ${shell()} ${isProject() ? "max-w-[220px]" : ""} ${
        props.reorder.isDragging(props.tab.key)
          ? "z-10 scale-[1.02] cursor-grabbing opacity-90 shadow-[0_6px_18px_rgba(0,0,0,.5)]"
          : ""
      }`}
      onPointerDown={(event) =>
        isMovable() && props.reorder.onPointerDown(event, props.tab.key, props.strip())
      }
      onPointerMove={props.reorder.onPointerMove}
      onPointerUp={props.reorder.onPointerUp}
      onPointerCancel={props.reorder.onPointerUp}
    >
      <Button
        type="button"
        onClick={() => actions.focus(props.tab.key)}
        aria-current={isActive() ? "page" : undefined}
        /*
         * The pill's shape belongs to the wrapper, not to this button: it fills
         * a `rounded-full` div and has no radius of its own, so the accent
         * outline would draw a rectangle inside the pill. Squared-off inactive
         * tabs are exactly what that looked like.
         */
        data-no-outline
        class={`flex h-full min-w-0 items-center gap-2 pl-3.5 text-[12.5px] ${isClosable() ? "pr-2" : "pr-3.5"}`}
      >
        <Show when={TAB_ICON[props.tab.kind]}>
          {(name) => (
            <Icon
              name={name()}
              class={`text-[14px] ${props.tab.kind !== "home" && isActive() ? "text-primary" : ""}`}
            />
          )}
        </Show>
        <Show when={isProject()}>
          <StatusDot status={tabStatus(props.tab.projectId ?? "")} live={isActive()} />
        </Show>
        <TabLabel label={props.tab.label} />
      </Button>

      {/*
        Always rendered for a closable tab, only *shown* when the tab is active,
        hovered or focused. Mounting it on demand would change the pill's width
        and shove the rest of the strip sideways every time you cycle.
      */}
      <Show when={isClosable()}>
        <Button
          type="button"
          data-no-drag
          onClick={() => actions.closeTab(props.tab.key)}
          aria-label={tx("Close {name}", { name: props.tab.label })}
          class={`mr-1.5 flex size-[18px] shrink-0 items-center justify-center rounded-full text-az-faint transition-[color,background-color,opacity] hover:bg-az-hover hover:text-base-content focus-visible:opacity-100 ${
            isActive() ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <Icon name="x" class="text-[13px]" />
        </Button>
      </Show>
    </div>
  );
}
