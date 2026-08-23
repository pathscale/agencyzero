import { Input } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { describeError, log } from "~/lib/log";
import { tx } from "~/stores/i18n";

/**
 * A name you can correct in place.
 *
 * The project name is derived from the front of the first prompt, which is a
 * guess that is right often enough to be useful and wrong often enough to need
 * fixing. This is stage 3 of the naming design: whatever the derived stages
 * produce, the name is the user's to change.
 *
 * Commits on Enter or blur, abandons on Escape, and refuses to write an empty
 * name — a nameless tab is unusable and there is no undo.
 */
export function EditableTitle(props: {
  value: string;
  onRename: (name: string) => Promise<unknown>;
  class?: string;
  inputClass?: string;
  /** Announced to screen readers, since the pencil is an icon alone. */
  label?: string;
  /**
   * What clicking the name itself does, when it is more than a label — on
   * Home it opens the project. Renaming stays on the pencil either way: a
   * name that both navigates and edits depending on where the pixel landed
   * would do the wrong one half the time.
   */
  onActivate?: () => void;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  let field: HTMLInputElement | undefined;

  const start = () => {
    setDraft(props.value);
    setEditing(true);
    // After the field has been mounted, so it exists by the time it is asked
    // to take focus.
    queueMicrotask(() => {
      field?.focus();
      field?.select();
    });
  };

  const commit = async (): Promise<void> => {
    const name = draft().trim();
    setEditing(false);
    // Nothing to do for an unchanged or empty name, and an empty one must not
    // reach the backend at all.
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
              /*
               * Editing starts on `mousedown`, not `click`.
               *
               * On Home this sits inside a `role="button"` row whose own
               * `onClick` folds it. Solid delegates `click`, so both handlers
               * are read during one synthetic walk up from the target and a
               * `stopPropagation` here loses that race: the row folded and the
               * editor stayed closed. `mousedown` fires before `click` exists,
               * so stopping it there keeps the row's gesture from starting.
               *
               * It has to stay a JSX handler. The same logic in a `ref`
               * callback stopped the fold but never opened the editor, because
               * a `ref` runs outside the reactive system and the write landed
               * in a signal nothing was watching. Do not reach for
               * `runWithOwner` to fix that: a reactive write from inside an
               * owned scope raises `REACTIVE_WRITE_IN_OWNED_SCOPE`, which
               * escapes as `REACTIVITY_HALTED` and freezes the app.
               * `lib/live.ts` documents that trap.
               */
              onMouseDown={(event) => {
                event.stopPropagation();
                start();
              }}
              onClick={(event) => event.stopPropagation()}
              onDblClick={(event) => event.stopPropagation()}
              disabled={busy()}
              aria-label={props.label ?? tx("Rename {name}", { name: props.value })}
              // Always visible. Hover-to-reveal hides the only clue that a name
              // can be changed at all, from the one person who wants to change it.
              class="flex size-[18px] shrink-0 items-center justify-center rounded p-0 text-az-faint transition-colors hover:bg-white/8 hover:text-az-body"
            >
              <Icon name="pencil" class="text-[11px]" />
            </Button>
          </span>
        }
      >
        <span class="flex min-w-0 flex-1">
          <Input.Field
            // Focused when editing begins rather than by `autofocus`, which is
            // applied once at the end of the flush that appends the node.
            // `Composer` reaches for `field.focus()` for the same reason.
            ref={(element: HTMLInputElement) => {
              field = element;
            }}
            value={draft()}
            aria-label={props.label ?? tx("Project name")}
            /*
             * The row behind this field opens a project on double click, so
             * selecting a word to retype it navigated away and dropped the
             * edit. A field's own mouse gestures stop here.
             */
            onClick={(event) => event.stopPropagation()}
            onDblClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                // Abandoned, not committed: blur would otherwise save what
                // Escape was pressed to discard.
                setDraft(props.value);
                setEditing(false);
              }
            }}
            class={`min-w-0 flex-1 rounded-md border border-az-hairline-strong bg-az-inset px-2 py-0.5 text-az-title outline-none focus:border-az-link ${props.inputClass ?? ""}`}
          />
        </span>
      </Show>
    </span>
  );
}
