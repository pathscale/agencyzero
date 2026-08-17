import { Show, splitProps } from "solid-js";
import type { JSX } from "@solidjs/web";
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
 *
 * `az-glass` is what makes that surface material rather than a flat fill: it
 * takes the twenty-five `--glass-*` tokens `@pathscale/ui` derives from three
 * numbers, so the Appearance sliders reach every panel at once. It is listed
 * after `az-panel` because it replaces that opaque background — a backdrop
 * filter behind an opaque fill blurs nothing anyone can see.
 */
export function Panel(props: PanelProps): JSX.Element {
  const [own, rest] = splitProps(props, ["children", "class"]);
  return (
    <div
      class={`az-panel az-glass isolate overflow-hidden rounded-panel border border-az-hairline ${own.class ?? ""}`}
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
      {/*
        Two hue-tinted levels on hover, the row then the title, rather than one
        flat white wash. Every surface here is tinted by `--az-hue`, so
        `bg-white/4` read as grey laid over blue instead of the surface
        lifting; `az-sunken` and `az-hover` are the same ladder, two steps
        apart, which is what keeps the title legible against its own row.

        The pill on the title is deliberate now. It used to come from
        PathScale/UI's `.button` fill defeating the compatibility reset, which
        also sized it to a 40px control and turned the chevron beside it into a
        blob around a 15px icon.
      */}
      <div class="group/header flex items-center justify-start gap-2.5 px-3.5 py-3 transition-colors hover:bg-az-sunken">
        <Button
          type="button"
          onClick={props.onToggle}
          aria-expanded={props.isOpen}
          // `justify-start` explicitly, rather than relying on the flex
          // default. Every section header rendered centred, which is what a
          // missing or differently defaulted `justify-content` looks like, and
          // stating it costs nothing where it was already correct.
          class="-mx-2 flex min-w-0 flex-1 items-center justify-start gap-2.5 rounded-full px-2 py-1 text-left transition-colors group-hover/header:bg-az-hover"
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
          // Sized here, because the reset now leaves this button at its
          // content size: a bare 15px icon with no box to hover. A round
          // target of its own is what the leaked 40px pill was accidentally
          // providing, minus the overlap.
          class="flex size-7 shrink-0 items-center justify-center rounded-full text-az-muted transition-colors hover:bg-az-hover"
        >
          <Icon
            name={props.isOpen ? "chevron-up" : "chevron-down"}
            class="text-[15px] text-primary/70"
          />
        </Button>
      </div>

      {/*
       * Retained, not mounted by the disclosure click.
       *
       * PathScale/UI controls contain positioned paint children, such as a
       * Toggle thumb. Under Blitz, mounting one while this panel simultaneously
       * grows can expose one provisional frame at the panel origin before the
       * child's final offset is resolved. That was the detached white pill at
       * the top-left of Settings. Keeping the subtree alive gives every child
       * stable layout; `hidden` removes it from layout, paint and accessibility
       * while collapsed without reconstructing it on expansion.
       */}
      <div
        aria-hidden={!props.isOpen ? "true" : undefined}
        class={`overflow-hidden border-az-hairline-soft border-t ${props.contentClass ?? ""}`}
        classList={{ hidden: !props.isOpen }}
      >
        {props.children}
      </div>
    </Panel>
  );
}

export default Panel;
