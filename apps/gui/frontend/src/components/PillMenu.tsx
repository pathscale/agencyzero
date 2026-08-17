import { Dropdown } from "@pathscale/ui";
import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, type IconProps } from "~/components/Icon";

export type PillOption<T extends string> = {
  value: T;
  label: string;
  /** Shown on the trigger when selected, if the full label is too long for the
   * pill. The menu still shows `label`. */
  triggerLabel?: string;
  /** Secondary line in the menu — what the option actually does. */
  hint?: string;
};

export type PillMenuProps<T extends string> = {
  /** Bold prefix that never changes, e.g. the agent name next to the model. */
  prefix?: string;
  value: T;
  options: PillOption<T>[];
  onChange: (value: T) => void;
  icon?: IconProps["name"];
  iconClass?: string;
  /** `filled` sits on a card; `outline` is the composer's secondary pill. */
  variant?: "filled" | "outline";
  label: string;
  isDisabled?: boolean;
};

/**
 * The rounded selector the design uses everywhere a value is swapped — model,
 * permission, environment policy.
 *
 * Built on `Dropdown` rather than a native select element: the trigger has to show
 * an icon plus a two-tone label, and the menu carries a hint line per option.
 * Dropdown supplies the overlay positioning, outside-click and keyboard
 * handling that would otherwise be hand-rolled here.
 */
export function PillMenu<T extends string>(props: PillMenuProps<T>): JSX.Element {
  const current = () => props.options.find((option) => option.value === props.value);

  // Opens upward: every pill in this app sits in a composer at the window's bottom edge.
  return (
    <Dropdown placement="top">
      <Dropdown.Trigger
        aria-label={props.label}
        disabled={props.isDisabled}
        class={`flex h-[24px] min-h-[24px] shrink-0 items-center gap-[7px] rounded-full px-2.5 py-0 font-medium text-[11px] leading-none transition-colors ${
          props.variant === "outline"
            ? "border border-primary/35 text-az-body hover:border-primary/60 hover:text-az-title"
            : "border border-primary/35 bg-base-300 hover:border-primary/60"
        } disabled:pointer-events-none disabled:opacity-50`}
      >
        <Show when={props.icon}>
          {(name) => (
            <Icon name={name()} class={`text-[13px] ${props.iconClass ?? "text-az-muted"}`} />
          )}
        </Show>
        <Show when={props.prefix}>
          <span class="font-semibold text-base-content">{props.prefix}</span>
        </Show>
        <span class={props.prefix ? "text-az-muted" : "text-az-strong"}>
          {current()?.triggerLabel ?? current()?.label ?? props.value}
        </span>
        <Icon name="chevron-down" class="text-[12px] text-az-faint" />
      </Dropdown.Trigger>

      <Dropdown.Menu
        align="start"
        class="min-w-[190px] rounded-xl border border-az-hairline bg-base-100 p-1 shadow-[0_18px_40px_rgba(0,0,0,.5)]"
      >
        <For each={props.options}>
          {(option) => (
            <Dropdown.Item
              onClick={() => props.onChange(option.value)}
              class={`flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5 ${
                option.value === props.value ? "text-primary" : "text-az-body"
              }`}
            >
              <span class="text-[12.5px]">{option.label}</span>
              <Show when={option.hint}>
                <span class="text-[11px] text-az-muted">{option.hint}</span>
              </Show>
            </Dropdown.Item>
          )}
        </For>
      </Dropdown.Menu>
    </Dropdown>
  );
}

export default PillMenu;
