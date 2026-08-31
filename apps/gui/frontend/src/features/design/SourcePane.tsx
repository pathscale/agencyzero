import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { copyText } from "~/features/project/MessageBody";
import { whileMounted } from "~/lib/live";
import { tx } from "~/stores/i18n";
import { EMITTERS } from "./emit";
import { design } from "./store";

/**
 * The emitted source.
 *
 * This is the deliverable, so it is on screen the whole time rather than
 * behind an Export button. A designer whose output you have to ask for is a
 * designer you cannot trust: the point of watching the source change as you
 * drag is that you can see immediately when it emits something you did not
 * mean.
 */
export function SourcePane(): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const [fileIndex, setFileIndex] = createSignal(0);
  const alive = whileMounted();

  const files = () => design.emitted();
  const active = () => files()[Math.min(fileIndex(), files().length - 1)];

  const copy = async (): Promise<void> => {
    const file = active();
    if (!file) return;
    const ok = await copyText(file.source);
    if (!ok) return;
    alive(setCopied)(true);
    window.setTimeout(
      alive(() => setCopied(false)),
      1200,
    );
  };

  return (
    <div class="flex min-h-0 w-full flex-1 flex-col gap-2 rounded-panel border border-az-hairline bg-base-100 p-3">
      <div class="flex items-center gap-2">
        <h2 class="flex-1 font-medium text-az-title text-ui-label">{tx("Source")}</h2>
        <Button
          id="design-copy-source"
          type="button"
          aria-label={tx("Copy source")}
          title={tx("Copy source")}
          onClick={() => void copy()}
          class="flex size-7 items-center justify-center rounded-md text-az-muted transition-colors hover:bg-az-hover hover:text-primary"
        >
          <Icon name={copied() ? "check" : "copy"} class="text-ui-detail" />
        </Button>
      </div>

      <div
        role="status"
        aria-label={tx("Emitting {count} files", { count: files().length })}
        class="sr-only"
      >
        {tx("Emitting {count} files", { count: files().length })}
      </div>

      <div class="flex gap-1">
        <For each={EMITTERS}>
          {(emitter) => (
            <Button
              id={`design-target-${emitter.id}`}
              type="button"
              aria-label={emitter.label}
              title={emitter.summary}
              onClick={() => {
                design.setTarget(emitter.id);
                setFileIndex(0);
              }}
              class={`flex-1 rounded-md border px-2 py-1 text-ui-micro transition-colors ${
                design.target() === emitter.id
                  ? "border-primary/45 bg-az-chip text-primary"
                  : "border-az-hairline text-az-body hover:text-base-content"
              }`}
            >
              {emitter.label}
            </Button>
          )}
        </For>
      </div>

      <Show when={files().length > 1}>
        <div class="flex gap-1">
          <For each={files()}>
            {(file, index) => (
              <Button
                id={`design-file-${file.path}`}
                type="button"
                aria-label={file.path}
                onClick={() => setFileIndex(index())}
                class={`rounded px-1.5 py-0.5 font-mono text-ui-micro transition-colors ${
                  index() === fileIndex() ? "text-primary" : "text-az-muted hover:text-base-content"
                }`}
              >
                {file.path}
              </Button>
            )}
          </For>
        </div>
      </Show>

      <Show when={active()}>
        {(file) => (
          /*
           * The name goes on a region wrapping the `<pre>`, not on the `<pre>`
           * itself, which has no role to carry it. The name is how ps-qa
           * addresses the emitted text.
           */
          <section aria-label={tx("Emitted source")} class="flex min-h-0 flex-1 flex-col">
            <pre
              data-selectable="true"
              class="az-scroll min-h-0 flex-1 overflow-auto rounded-lg border border-az-hairline bg-az-inset p-3 font-mono text-az-body text-ui-tiny leading-[1.55]"
            >
              {file().source}
            </pre>
          </section>
        )}
      </Show>
    </div>
  );
}
