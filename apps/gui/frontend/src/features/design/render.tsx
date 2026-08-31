/**
 * A design node, rendered as the component it names.
 *
 * The preview uses the real `@pathscale/ui` components, not pictures of
 * them. A designer whose canvas approximates the library is a designer that
 * lies about spacing, and spacing is most of what is being designed.
 *
 * Artboards render in the app's own document, which is the H6 decision, so these
 * are ordinary elements in the same tree as the chrome. Each carries
 * `data-design-id`, which is the whole hit-testing contract: the canvas
 * reads `event.target.closest("[data-design-id]")` and never touches
 * coordinates. That also makes every node addressable from the
 * accessibility tree for ps-qa.
 */

import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  Flex,
  Grid,
  Input,
  Link,
  Progress,
  Radio,
  Separator,
  Skeleton,
  Spinner,
  Switch,
  Text,
  Textarea,
} from "@pathscale/ui";
import { Dynamic, type JSX } from "@solidjs/web";
import { type Component, createErrorBoundary, For, Show } from "solid-js";
import { tx } from "~/stores/i18n";
import { lookup } from "./catalog";
import type { DesignNode } from "./document";

/* biome-ignore lint/suspicious/noExplicitAny: the registry is heterogeneous by
   construction: its whole job is to look a component up by a string the
   document holds. The catalog is what constrains which props reach it. */
type AnyComponent = Component<any>;

/**
 * Catalog name to component.
 *
 * `Dynamic` rather than a switch of literal JSX tags, which is also why the
 * ui-control id gate does not fire here: there is no `<Button>` tag in this
 * file to attach a literal id to. Every rendered node still gets a stable
 * `id`, derived from its node id, so it is addressable all the same.
 */
const REGISTRY: Record<string, AnyComponent> = {
  Flex,
  Grid,
  Card,
  "Card.Header": Card.Header,
  "Card.Body": Card.Body,
  "Card.Footer": Card.Footer,
  Separator,
  Text,
  Badge,
  Chip,
  Alert,
  Avatar,
  Progress,
  Spinner,
  Skeleton,
  Link,
  Button,
  Input,
  Textarea,
  Checkbox,
  Switch,
  Radio,
};

/** Whether the canvas can draw this type at all. */
export function isRenderable(type: string): boolean {
  return type in REGISTRY;
}

/**
 * The props actually handed to the component.
 *
 * `data-design-id` is the hit-test key, `id` is the QA address, and
 * `data-design-selected` gives the outline something to key off without a
 * second render path for the selected node.
 */
function componentProps(node: DesignNode, selected: boolean): Record<string, unknown> {
  return {
    ...node.props,
    id: `design-node-${node.id}`,
    "data-design-id": node.id,
    "data-design-type": node.type,
    ...(selected ? { "data-design-selected": "true" } : {}),
  };
}

export function DesignedNode(props: { node: DesignNode; selectedId: string }): JSX.Element {
  const entry = () => lookup(props.node.type);
  const component = () => REGISTRY[props.node.type];
  const selected = () => props.selectedId === props.node.id;

  return (
    <Show when={component()} fallback={<UnknownNode node={props.node} />}>
      {(resolved) => {
        /*
         * One boundary per node, not one per canvas.
         *
         * A library component that needs a parent context it has not been
         * given, a Radio outside a RadioGroup being the live example, throws
         * on render. Without this, one bad drop blanks the entire artboard
         * and the source pane goes with it, which would read as the whole
         * feature crashing rather than one node being in the wrong place.
         *
         * `createErrorBoundary` rather than an `<ErrorBoundary>` element:
         * Solid 2 exports the primitive and not the component.
         */
        const guarded = createErrorBoundary(
          () => (
            <Dynamic component={resolved()} {...componentProps(props.node, selected())}>
              <Show when={entry()?.children === "text"}>{props.node.text}</Show>
              <Show when={entry()?.children === "nodes"}>
                <For each={props.node.children}>
                  {(child) => <DesignedNode node={child} selectedId={props.selectedId} />}
                </For>
              </Show>
            </Dynamic>
          ),
          () => <BrokenNode node={props.node} />,
        );
        return <>{guarded()}</>;
      }}
    </Show>
  );
}

/** A type the catalog knows but the registry cannot draw. */
function UnknownNode(props: { node: DesignNode }): JSX.Element {
  return (
    <div
      data-design-id={props.node.id}
      data-design-type={props.node.type}
      class="rounded-lg border border-az-hairline border-dashed px-3 py-2 text-az-muted text-ui-caption"
    >
      {props.node.type}
    </div>
  );
}

/** A node whose component threw. Still selectable, still deletable. */
function BrokenNode(props: { node: DesignNode }): JSX.Element {
  return (
    <div
      data-design-id={props.node.id}
      data-design-type={props.node.type}
      class="rounded-lg border border-error/45 border-dashed px-3 py-2 text-error text-ui-caption"
    >
      {tx("{component} needs a parent it does not have here", {
        component: props.node.type,
      })}
    </div>
  );
}
