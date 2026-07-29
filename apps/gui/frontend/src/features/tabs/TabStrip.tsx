import { For, type JSX, Show } from "solid-js";
import { Icon, type IconProps } from "~/components/Icon";
import { StatusDot } from "~/components/StatusDot";
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
 * Home is not closable. Each project tab carries a coloured dot for its state
 * — the whole point being that you can see a tab go blocked while you are
 * working in a different one.
 */
export function TabStrip(): JSX.Element {
  const { state, actions } = useWorkspace();

  return (
    <div class="flex flex-none items-center gap-2 px-3.5 pt-3 pb-1.5">
      {/* Room for the macOS traffic lights, which the window keeps. */}
      <div class="w-[62px] shrink-0" />

      <div class="az-scroll flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden">
        <For each={state.tabs}>{(tab) => <TabPill tab={tab} />}</For>

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
function TabPill(props: { tab: Tab }): JSX.Element {
  const { state, actions, tabStatus } = useWorkspace();

  const isActive = () => props.tab.key === state.activeKey;
  const isProject = () => props.tab.kind === "project";
  const isClosable = () => props.tab.kind !== "home";

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
    <div
      class={`${shell()} ${isProject() ? "max-w-[220px]" : ""} ${isClosable() && isActive() ? "pr-1.5 pl-3.5" : "px-3.5"}`}
    >
      <button
        type="button"
        onClick={() => actions.focus(props.tab.key)}
        aria-current={isActive() ? "page" : undefined}
        class="flex min-w-0 items-center gap-2 text-[12.5px]"
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

      <Show when={isClosable() && isActive()}>
        <button
          type="button"
          onClick={() => actions.closeTab(props.tab.key)}
          aria-label={`Close ${props.tab.label}`}
          class="ml-2 flex size-[18px] shrink-0 items-center justify-center rounded-full text-az-faint transition-colors hover:bg-white/10 hover:text-base-content"
        >
          <Icon name="x" class="text-[13px]" />
        </button>
      </Show>
    </div>
  );
}
