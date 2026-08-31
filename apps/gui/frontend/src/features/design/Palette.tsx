import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { Button } from "~/components/Button";
import { tx } from "~/stores/i18n";
import { type CatalogEntry, grouped } from "./catalog";
import { beginPointerDrag } from "./gesture";
import { design } from "./store";

const GROUP_LABEL = {
  layout: "Layout",
  display: "Display",
  form: "Form",
} as const;

/**
 * The component palette.
 *
 * Every item is a real button with an accessible name, so the whole palette
 * works by click as well as by drag. That is not a courtesy: a drag is not
 * addressable from the accessibility tree, and `docs/ui-verification.md` is
 * explicit that outcomes are driven by name. Click-to-append is the path QA
 * drives; drag is the path a person prefers.
 */
export function Palette(props: { canvas: () => HTMLElement | undefined }): JSX.Element {
  return (
    <div class="az-scroll flex w-[196px] shrink-0 flex-col gap-3 overflow-y-auto rounded-panel border border-az-hairline bg-base-100 p-3">
      <div>
        <h2 class="font-medium text-az-title text-ui-label">{tx("Components")}</h2>
        <p class="mt-0.5 text-az-muted text-ui-micro">{tx("Drag onto the canvas, or click")}</p>
      </div>
      <For each={grouped()}>
        {(section) => (
          <div class="flex flex-col gap-1">
            <span class="text-az-faint text-ui-micro uppercase tracking-[.08em]">
              {tx(GROUP_LABEL[section.group])}
            </span>
            <For each={section.entries}>
              {(entry) => <PaletteItem entry={entry} canvas={props.canvas} />}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

function PaletteItem(props: {
  entry: CatalogEntry;
  canvas: () => HTMLElement | undefined;
}): JSX.Element {
  const dragging = () => {
    const source = design.dragging();
    return source?.kind === "palette" && source.entry.name === props.entry.name;
  };

  return (
    <Button
      id={`design-palette-${props.entry.name.replace(".", "-").toLowerCase()}`}
      type="button"
      title={props.entry.summary}
      aria-label={props.entry.name}
      onPointerDown={(event: PointerEvent) => {
        design.beginDrag({ kind: "palette", entry: props.entry });
        beginPointerDrag({ x: event.clientX, y: event.clientY }, props.canvas, () =>
          design.add(props.entry),
        );
      }}
      class={`flex h-7 w-full items-center rounded-lg border px-2 text-left text-ui-caption transition-colors ${
        dragging()
          ? "border-primary/45 bg-az-chip text-primary"
          : "border-transparent text-az-body hover:bg-az-hover hover:text-base-content"
      }`}
    >
      {props.entry.name}
    </Button>
  );
}
