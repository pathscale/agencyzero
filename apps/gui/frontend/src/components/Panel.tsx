import { type JSX, Show, splitProps } from "solid-js";
import { Button } from "~/components/Button";
import { Icon, type IconProps } from "~/components/Icon";
import { tx } from "~/stores/i18n";

export type PanelProps = JSX.HTMLAttributes<HTMLDivElement> & {
  children: JSX.Element;
};

/**
 * A floating panel: the workspace's one surface primitive.
 *
 * Radius 14 on `base-100` with a `base-content/9%` hairline — the design's
 * panel token. Everything that looks like a card on screen is either this or a
 * row inside it.
 */
export function Panel(props: PanelProps): JSX.Element {
  const [own, rest] = splitProps(props, ["children", "class"]);
  return (
    <div
      class={`overflow-hidden rounded-panel border border-az-hairline bg-base-100 ${own.class ?? ""}`}
      {...rest}
    >
      {own.children}
    </div>
  );
}

export type SectionPanelProps = {
  icon?: IconProps["name"];
  title: string;
  /** Small count badge after the title. */
  count?: number;
  countTone?: "neutral" | "primary";
  /** Free text after the title, e.g. "· 2 dirs". */
  note?: string;
  /** Rendered before the chevron — a "Clear" action, a live dot. */
  lead?: JSX.Element;
  trailing?: JSX.Element;
  isOpen: boolean;
  onToggle: () => void;
  children: JSX.Element;
  class?: string;
  /** Layout for the revealed body, used when a section owns remaining height. */
  contentClass?: string;
};

/**
 * One accordion section of the project panel: Settings · Items · Running ·
 * Task log.
 *
 * Open state is owned by the caller and persisted in `UiPrefs.panelSections`,
 * so it survives a restart — hence a controlled `isOpen`/`onToggle` pair
 * rather than an uncontrolled disclosure.
 */
export function SectionPanel(props: SectionPanelProps): JSX.Element {
  return (
    <Panel class={props.class}>
      {/*
        The header is a row, not one big button: `lead` carries its own control
        (the log's "Clear"), and nesting that inside a button would be invalid
        HTML. The toggle is the button that fills the rest of the row.
      */}
      <div class="flex items-center justify-start gap-2.5 px-3.5 py-3 transition-colors hover:bg-white/4">
        <Button
          type="button"
          onClick={props.onToggle}
          aria-expanded={props.isOpen}
          // `justify-start` explicitly, rather than relying on the flex
          // default. Every section header rendered centred, which is what a
          // missing or differently defaulted `justify-content` looks like, and
          // stating it costs nothing where it was already correct.
          class="flex min-w-0 flex-1 items-center justify-start gap-2.5 text-left"
        >
          <Show when={props.trailing}>{props.trailing}</Show>
          <Show when={props.icon}>
            {(name) => <Icon name={name()} class="text-[15px] text-primary" />}
          </Show>
          <span class="font-semibold text-[12.5px] text-base-content">{props.title}</span>
          <Show when={props.count !== undefined}>
            <span
              class={`rounded-full px-2 py-px font-semibold text-[11px] ${
                props.countTone === "primary"
                  ? "bg-primary/15 text-primary"
                  : "bg-base-300 text-az-body"
              }`}
            >
              {props.count}
            </span>
          </Show>
          <Show when={props.note}>
            <span class="text-[11.5px] text-az-muted">{props.note}</span>
          </Show>
        </Button>

        <Show when={props.lead}>{props.lead}</Show>
        <Button
          type="button"
          onClick={props.onToggle}
          aria-label={tx(props.isOpen ? "Collapse {name}" : "Expand {name}", {
            name: props.title,
          })}
          class="shrink-0 text-az-muted"
        >
          <Icon
            name={props.isOpen ? "chevron-up" : "chevron-down"}
            class="text-[15px] text-primary/70"
          />
        </Button>
      </div>

      <Show when={props.isOpen}>
        <div class={`border-az-hairline-soft border-t ${props.contentClass ?? ""}`}>
          {props.children}
        </div>
      </Show>
    </Panel>
  );
}

export default Panel;
