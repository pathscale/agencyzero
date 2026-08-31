import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { tx } from "~/stores/i18n";
import { ROOT_ID } from "./document";
import { beginPointerDrag, hitAt } from "./gesture";
import { DesignedNode } from "./render";
import { design } from "./store";

/**
 * The artboard.
 *
 * Renders in the app's own document, which is the H6 decision and the reason
 * everything here is simple: hit testing is `closest("[data-design-id]")`,
 * the control socket can see every node, and ps-qa addresses them by id.
 *
 * Pointer events are taken in the capture phase and stopped there. A designed
 * Button is a real Button, so without that a click would press it instead of
 * selecting it. Capture is the exact tool for "the canvas sees this first and
 * the component never does", and it needs no `pointer-events: none` layer,
 * which would have broken the hit test it was meant to serve.
 */
export function Canvas(props: {
  canvas: () => HTMLElement | undefined;
  setCanvas: (element: HTMLElement) => void;
}): JSX.Element {
  const doc = () => design.document();
  const empty = () => doc().root.children.length === 0;

  const onPointerDown = (event: PointerEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    const hit = hitAt(event.clientX, event.clientY);
    design.select(hit?.id ?? ROOT_ID);
    if (!hit) return;
    design.beginDrag({ kind: "node", nodeId: hit.id });
    beginPointerDrag({ x: event.clientX, y: event.clientY }, props.canvas, () => {
      /* An unmoved press on a node is a selection, already applied above. */
    });
  };

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div class="flex items-baseline justify-between gap-2 px-1">
        <span class="text-az-muted text-ui-micro">{tx("Artboard")}</span>
        <Show when={design.dropPlan()}>
          {(plan) => (
            <span
              role="status"
              aria-label={tx("Drop target {target}", { target: plan().relativeTo })}
              class="font-mono text-primary text-ui-micro"
            >
              {plan().kind} · {plan().relativeTo}
            </span>
          )}
        </Show>
      </div>

      <section
        ref={props.setCanvas}
        id="design-canvas"
        // A named section, so the artboard is addressable by name rather than
        // by position. A bare div carries no role for the name to attach to.
        aria-label={tx("Design canvas")}
        onPointerDown={onPointerDown}
        class="az-scroll flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto rounded-panel border border-az-hairline bg-base-100 p-6"
      >
        <Show
          when={!empty()}
          fallback={
            <div class="flex flex-1 items-center justify-center rounded-xl border border-az-hairline border-dashed py-16 text-az-muted text-ui-detail">
              {tx("Drag a component here")}
            </div>
          }
        >
          <For each={doc().root.children}>
            {(node) => <DesignedNode node={node} selectedId={design.selectedId()} />}
          </For>
        </Show>
      </section>
    </div>
  );
}
