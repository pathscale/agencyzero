import { Input, Switch } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { tx } from "~/stores/i18n";
import { lookup, type PropSpec, type PropValue } from "./catalog";
import { type DesignNode, nodeLabel, pathTo, ROOT_TYPE } from "./document";
import { design } from "./store";

/**
 * The properties panel.
 *
 * Enums are drawn as a row of value buttons rather than a Select. Two
 * reasons, and the second is the load-bearing one: every value is visible at
 * a glance, which is what a design tool wants, and every value is separately
 * addressable by accessible name, which is what
 * `docs/ui-verification.md` requires to drive an outcome.
 *
 * A prop sitting at its catalog default shows as `Default` and is not stored
 * on the node, so it never reaches the emitted source. Writing `variant="solid"`
 * on a Button whose default is already `solid` produces an attribute that
 * changes nothing, and the emitted source is the deliverable.
 */
export function Inspector(): JSX.Element {
  const node = () => design.selectedNode();
  const entry = () => {
    const current = node();
    return current ? lookup(current.type) : null;
  };

  return (
    <div class="az-scroll flex min-h-0 w-full flex-col gap-3 overflow-y-auto rounded-panel border border-az-hairline bg-base-100 p-3">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="font-medium text-az-title text-ui-label">{tx("Properties")}</h2>
        <Show when={node() && node()?.type !== ROOT_TYPE}>
          <Button
            id="design-remove-node"
            type="button"
            aria-label={tx("Delete component")}
            title={tx("Delete component")}
            onClick={() => design.remove(design.selectedId())}
            class="flex size-6 items-center justify-center rounded-md text-az-muted transition-colors hover:bg-az-hover hover:text-error"
          >
            <Icon name="x" class="text-ui-detail" />
          </Button>
        </Show>
      </div>

      <Breadcrumb />

      <Show when={node()} fallback={<Hint>{tx("Select a component on the canvas")}</Hint>}>
        {(current) => (
          <Show when={current().type !== ROOT_TYPE} fallback={<ArtboardFields />}>
            <div class="flex flex-col gap-3">
              <Show when={entry()?.children === "text"}>
                <TextField node={current()} />
              </Show>
              <Show
                when={(entry()?.props.length ?? 0) > 0}
                fallback={<Hint>{tx("This component has no props")}</Hint>}
              >
                <For each={entry()?.props}>
                  {(spec) => <PropField node={current()} spec={spec} />}
                </For>
              </Show>
            </div>
          </Show>
        )}
      </Show>
    </div>
  );
}

function Hint(props: { children: JSX.Element }): JSX.Element {
  return <p class="text-az-muted text-ui-caption">{props.children}</p>;
}

/** Where the selection sits, and a way back up to any ancestor. */
function Breadcrumb(): JSX.Element {
  const trail = () => pathTo(design.document(), design.selectedId());
  return (
    <div class="flex flex-wrap items-center gap-1">
      <For each={trail()}>
        {(step, index) => (
          <>
            <Show when={index() > 0}>
              <Icon name="chevron-right" class="text-az-faint text-ui-micro" />
            </Show>
            <Button
              id={`design-breadcrumb-${step.id}`}
              type="button"
              aria-label={nodeLabel(step)}
              onClick={() => design.select(step.id)}
              class={`rounded px-1 text-ui-micro transition-colors ${
                step.id === design.selectedId()
                  ? "text-primary"
                  : "text-az-muted hover:text-base-content"
              }`}
            >
              {step.type === ROOT_TYPE ? tx("Artboard") : step.type}
            </Button>
          </>
        )}
      </For>
    </div>
  );
}

/** The artboard's own field: the name every emitted symbol is built from. */
function ArtboardFields(): JSX.Element {
  /*
   * A div, not a label. `Input` owns the real control and generates its own
   * id, so a wrapping label associates with nothing; the Input carries the
   * accessible name itself, which is also the address ps-qa drives.
   */
  return (
    <div class="flex flex-col gap-1">
      <span class="text-az-muted text-ui-micro">{tx("Component name")}</span>
      <Input
        id="design-artboard-name"
        aria-label={tx("Component name")}
        value={design.document().name}
        onInput={(event: InputEvent) =>
          design.rename((event.currentTarget as HTMLInputElement).value)
        }
      />
    </div>
  );
}

/** The literal child of a text component, edited in place. */
function TextField(props: { node: DesignNode }): JSX.Element {
  return (
    <div class="flex flex-col gap-1">
      <span class="text-az-muted text-ui-micro">{tx("Text")}</span>
      <Input
        id={`design-text-${props.node.id}`}
        aria-label={tx("Text")}
        value={props.node.text ?? ""}
        onInput={(event: InputEvent) =>
          design.setText(props.node.id, (event.currentTarget as HTMLInputElement).value)
        }
      />
    </div>
  );
}

function PropField(props: { node: DesignNode; spec: PropSpec }): JSX.Element {
  const value = (): PropValue | undefined => props.node.props[props.spec.name];
  const set = (next: PropValue | undefined): void =>
    design.setProp(props.node.id, props.spec.name, next);

  return (
    <div class="flex flex-col gap-1">
      <span class="text-az-body text-ui-micro" title={props.spec.hint}>
        {props.spec.name}
      </span>
      <Show when={props.spec.type.kind === "enum"}>
        <EnumField spec={props.spec} value={value()} onSet={set} nodeId={props.node.id} />
      </Show>
      <Show when={props.spec.type.kind === "boolean"}>
        <Switch
          id={`design-prop-${props.node.id}-${props.spec.name}`}
          aria-label={props.spec.name}
          checked={value() === true}
          /* The library forwards the native change event, not a boolean. */
          onChange={(event: Event) =>
            set((event.currentTarget as HTMLInputElement).checked ? true : undefined)
          }
        />
      </Show>
      <Show when={props.spec.type.kind === "string"}>
        <Input
          id={`design-prop-${props.node.id}-${props.spec.name}`}
          aria-label={props.spec.name}
          value={String(value() ?? "")}
          onInput={(event: InputEvent) => {
            const next = (event.currentTarget as HTMLInputElement).value;
            set(next === "" ? undefined : next);
          }}
        />
      </Show>
      <Show when={props.spec.type.kind === "number"}>
        <Input
          id={`design-prop-${props.node.id}-${props.spec.name}`}
          aria-label={props.spec.name}
          type="number"
          value={String(value() ?? "")}
          onInput={(event: InputEvent) => {
            const raw = (event.currentTarget as HTMLInputElement).value;
            set(raw === "" ? undefined : Number(raw));
          }}
        />
      </Show>
    </div>
  );
}

function EnumField(props: {
  spec: PropSpec;
  value: PropValue | undefined;
  nodeId: string;
  onSet: (next: PropValue | undefined) => void;
}): JSX.Element {
  const values = () => (props.spec.type.kind === "enum" ? props.spec.type.values : []);
  const chosen = () => props.value ?? props.spec.default;

  return (
    <div class="flex flex-wrap gap-1">
      <Button
        id={`design-prop-${props.nodeId}-${props.spec.name}-default`}
        type="button"
        aria-label={`${props.spec.name} default`}
        onClick={() => props.onSet(undefined)}
        class={`rounded-md border px-1.5 py-0.5 text-ui-micro transition-colors ${
          props.value === undefined
            ? "border-primary/45 bg-az-chip text-primary"
            : "border-az-hairline text-az-muted hover:text-base-content"
        }`}
      >
        {tx("Default")}
      </Button>
      <For each={values()}>
        {(option) => (
          <Button
            id={`design-prop-${props.nodeId}-${props.spec.name}-${option}`}
            type="button"
            aria-label={`${props.spec.name} ${option}`}
            onClick={() => props.onSet(option)}
            class={`rounded-md border px-1.5 py-0.5 text-ui-micro transition-colors ${
              chosen() === option && props.value !== undefined
                ? "border-primary/45 bg-az-chip text-primary"
                : "border-az-hairline text-az-body hover:text-base-content"
            }`}
          >
            {option}
          </Button>
        )}
      </For>
    </div>
  );
}
