import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, onSettled, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { tx } from "~/stores/i18n";
import { Canvas } from "./Canvas";
import { Inspector } from "./Inspector";
import { Palette } from "./Palette";
import { SourcePane } from "./SourcePane";
import { design } from "./store";

/**
 * The Design tab: palette, artboard, properties, emitted source.
 *
 * Four views of one document. The source pane is deliberately never hidden,
 * because the source is what the feature produces and everything else is a
 * way of arriving at it.
 */
export function DesignTab(): JSX.Element {
  const [canvas, setCanvas] = createSignal<HTMLElement | undefined>(undefined);

  onSettled(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (typing) return;
      const accel = event.metaKey || event.ctrlKey;
      if (accel && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) design.redo();
        else design.undo();
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        design.remove(design.selectedId());
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 rounded-panel border border-az-hairline bg-az-sunken p-4">
      <Toolbar />
      <div class="flex min-h-0 min-w-0 flex-1 gap-3">
        <Palette canvas={canvas} />
        <Canvas canvas={canvas} setCanvas={setCanvas} />
        <div class="flex min-h-0 w-[364px] shrink-0 flex-col gap-3">
          <div class="flex max-h-[46%] min-h-0 flex-none">
            <Inspector />
          </div>
          <SourcePane />
        </div>
      </div>
    </div>
  );
}

function Toolbar(): JSX.Element {
  const history = () => design.history();

  return (
    <div class="flex min-w-0 items-center gap-3">
      <div class="min-w-0 flex-1">
        <h1 class="font-semibold text-az-title text-ui-title tracking-[-.01em]">{tx("Design")}</h1>
        <p class="truncate text-az-muted text-ui-micro">
          {tx("Compose @pathscale/ui components and read the source they emit")}
        </p>
      </div>
      <Button
        id="design-undo"
        type="button"
        aria-label={tx("Undo")}
        title={tx("Undo")}
        onClick={() => design.undo()}
        disabled={history().past === 0}
        class="flex size-8 items-center justify-center rounded-lg text-az-muted transition-colors hover:bg-az-hover hover:text-base-content disabled:opacity-40"
      >
        <Icon name="history" class="text-ui-body" />
      </Button>
      <Button
        id="design-redo"
        type="button"
        aria-label={tx("Redo")}
        title={tx("Redo")}
        onClick={() => design.redo()}
        disabled={history().future === 0}
        class="flex size-8 items-center justify-center rounded-lg text-az-muted transition-colors hover:bg-az-hover hover:text-base-content disabled:opacity-40"
      >
        <Icon name="refresh-cw" class="text-ui-body" />
      </Button>
      <Show when={design.document().root.children.length > 0}>
        <Button
          id="design-clear"
          type="button"
          aria-label={tx("Clear artboard")}
          title={tx("Clear artboard")}
          onClick={() => design.clear()}
          class="flex size-8 items-center justify-center rounded-lg text-az-muted transition-colors hover:bg-az-hover hover:text-error"
        >
          <Icon name="x" class="text-ui-body" />
        </Button>
      </Show>
    </div>
  );
}
