import { For, type JSX, Show } from "solid-js";
import { Icon, type IconProps } from "~/components/Icon";
import { StatusDot } from "~/components/StatusDot";
import { createTabReorder } from "~/features/tabs/reorder";
import { useTabShortcuts } from "~/features/tabs/shortcuts";
import { useWorkspace } from "~/stores/workspace";
import type { Tab } from "~/types";

const PILL = "flex h-8 shrink-0 items-center rounded-full transition-colors";
const ACTIVE = "bg-az-tab shadow-[0_2px_10px_rgba(0,0,0,.35)]";
const IDLE = "border border-transparent text-az-muted hover:bg-white/5 hover:text-base-content";

const TAB_ICON: Record<Tab["kind"], IconProps["name"] | null> = {
  home: "layout-grid",
  draft: "file-plus-2",
  settings: "settings",
  project: null,
};

/**
 * The tab strip: Home · any Untitled draft · one tab per project · Settings.
 *
 * Home is not closable and stays first; everything else can be dragged into
 * any other position. Each project tab carries a coloured dot for its state —
 * the whole point being that you can see a tab go blocked while you are
 * working in a different one.
 */
export function TabStrip(): JSX.Element {
  const { state, actions } = useWorkspace();
  useTabShortcuts();

  let strip!: HTMLDivElement;

  const reorder = createTabReorder({
    onMove: actions.moveTab,
    onCommit: () => void actions.commitTabOrder(),
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

      <div
        ref={strip}
        class="az-scroll flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden"
      >
        <For each={state.tabs}>
          {(tab) => <TabPill tab={tab} reorder={reorder} strip={() => strip} />}
        </For>

        <button
          type="button"
          onClick={() => actions.openDraft()}
          title="New project"
          aria-label="New project"
          class="flex h-8 shrink-0 items-center justify-center rounded-full border border-white/22 border-dashed px-3 text-az-muted transition-colors hover:border-primary hover:bg-primary/8 hover:text-primary"
        >
          <Icon name="plus" class="text-[15px]" />
        </button>
      </div>

      <div class="flex flex-none items-center gap-0.5">
        <button
          type="button"
          onClick={() => actions.openSettings()}
          title="Settings"
          aria-label="Settings"
          class={`flex size-[30px] items-center justify-center rounded-full transition-colors hover:bg-white/6 ${
            state.activeKey === "settings"
              ? "text-primary"
              : "text-az-muted hover:text-base-content"
          }`}
        >
          <Icon name="settings" class="text-[15px]" />
        </button>
        <div class="ml-1 flex size-[26px] items-center justify-center rounded-full bg-[oklch(24%_0.01_240)] font-semibold text-[11px] text-base-content">
          N
        </div>
      </div>
    </div>
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
  const showClose = () => isClosable() && isActive();
  // Home anchors the strip; there is nowhere for it to go.
  const isMovable = () => props.tab.kind !== "home";

  const shell = () => {
    if (props.tab.kind === "draft") {
      return isActive()
        ? `${PILL} border border-white/30 border-dashed bg-az-tab text-base-content italic`
        : `${PILL} border border-white/16 border-dashed text-az-muted italic hover:border-white/30 hover:text-base-content`;
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
     */
    <div
      class={`${shell()} ${isProject() ? "max-w-[220px]" : ""} ${
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
      <button
        type="button"
        onClick={() => actions.focus(props.tab.key)}
        aria-current={isActive() ? "page" : undefined}
        class={`flex h-full min-w-0 items-center gap-2 pl-3.5 text-[12.5px] ${showClose() ? "pr-2" : "pr-3.5"}`}
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
        <span class="truncate">{props.tab.label}</span>
      </button>

      <Show when={showClose()}>
        <button
          type="button"
          data-no-drag
          onClick={() => actions.closeTab(props.tab.key)}
          aria-label={`Close ${props.tab.label}`}
          class="mr-1.5 flex size-[18px] shrink-0 items-center justify-center rounded-full text-az-faint transition-colors hover:bg-white/10 hover:text-base-content"
        >
          <Icon name="x" class="text-[13px]" />
        </button>
      </Show>
    </div>
  );
}
