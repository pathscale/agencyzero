import { Input } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { describeError, log } from "~/lib/log";
import { tx } from "~/stores/i18n";

/** A name that can be edited in place. */
export function EditableTitle(props: {
  value: string;
  onRename: (name: string) => Promise<unknown>;
  class?: string;
  inputClass?: string;
  label?: string;
  onActivate?: () => void;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let field: HTMLInputElement | undefined;

  const start = () => {
    setDraft(props.value);
    setEditing(true);
    queueMicrotask(() => {
      field?.focus();
      field?.select();
    });
  };

  const cancel = () => {
    setDraft(props.value);
    setEditing(false);
  };

  const commit = async (): Promise<void> => {
    const name = draft().trim();
    setEditing(false);
    if (!name || name === props.value) return;

    setBusy(true);
    try {
      await props.onRename(name);
    } catch (cause) {
      log.error(`could not rename: ${describeError(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span class={`flex min-w-0 items-center gap-1.5 ${props.class ?? ""}`}>
      <Show
        when={editing()}
        fallback={
          <span class="flex min-w-0 flex-1 items-center gap-1.5">
            <Show
              when={props.onActivate}
              fallback={<span class="min-w-0 truncate">{props.value}</span>}
            >
              {(activate) => (
                <Button
                  type="button"
                  onClick={() => activate()()}
                  class="min-w-0 truncate text-left"
                >
                  {props.value}
                </Button>
              )}
            </Show>
            <Button
              type="button"
              onMouseDown={(event) => {
                event.stopPropagation();
                start();
              }}
              onClick={(event) => event.stopPropagation()}
              onDblClick={(event) => event.stopPropagation()}
              disabled={busy()}
              aria-label={props.label ?? tx("Rename {name}", { name: props.value })}
              class="flex size-[18px] shrink-0 items-center justify-center rounded p-0 text-az-faint transition-colors hover:bg-white/8 hover:text-az-body"
            >
              <Icon name="pencil" class="text-[11px]" />
            </Button>
          </span>
        }
      >
        <span class="flex min-w-0 flex-1">
          <Input
            ref={(element: HTMLInputElement) => {
              field = element;
            }}
            value={draft()}
            aria-label={props.label ?? tx("Project name")}
            onClick={(event) => event.stopPropagation()}
            onDblClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
            class={`min-w-0 flex-1 rounded-md border border-az-hairline-strong bg-az-inset px-2 py-0.5 text-az-title outline-none focus:border-az-link ${props.inputClass ?? ""}`}
          />
        </span>
      </Show>
    </span>
  );
}
