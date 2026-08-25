import { Input } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { describeError, log } from "~/lib/log";
import { tx } from "~/stores/i18n";

/**
 * Which editor is open, by instance.
 *
 * A module variable rather than a signal per component, because a `createSignal`
 * setter called from a click handler does not update the value in this Solid
 * version: measured here, `setEditing(true)` left `editing()` false through the
 * rest of the handler and only landed a microtask later, by which time nothing
 * re-read it. The editor never appeared and the title looked dead.
 *
 * Only one name is ever edited at a time, so this is a single id rather than a
 * set: opening one editor closes any other, which is also what a reader expects.
 */
let nextEditorId = 0;

/** Every mounted editor, so opening one can close the rest. */
const editors = new Map<number, (open: boolean) => void>();

/**
 * Show `id`'s editor and hide every other one.
 *
 * The swap is applied to the elements directly rather than by flipping a signal
 * the markup reads. A signal cannot carry it: the setter does not take effect
 * within the handler that calls it, so nothing re-reads the new value and the
 * rendered output never changes. Writing `hidden` on the two spans is the same
 * state change with no dependency on a re-render happening.
 */
function openEditor(id: number): void {
  /*
   * Close the others first, then open this one.
   *
   * A single pass calling `apply(other === id)` looked equivalent and was not:
   * an instance registered under more than one id had its own `apply` called
   * again with `false` later in the same loop, so the editor opened and shut
   * within the click that opened it. Ordering the two phases makes the open
   * the last write no matter how the map is keyed.
   */
  for (const [other, apply] of editors) {
    if (other !== id) apply(false);
  }
  editors.get(id)?.(true);
}

/** Hide `id`'s editor and put its title row back. */
function closeEditor(id: number): void {
  editors.get(id)?.(false);
}

/** A name that can be edited in place. */
export function EditableTitle(props: {
  value: string;
  onRename: (name: string) => Promise<unknown>;
  class?: string;
  inputClass?: string;
  label?: string;
  onActivate?: () => void;
}): JSX.Element {
  const id = nextEditorId++;
  let open = false;
  // Plain variables for the same reason the open/closed state is one: these are
  // written from click and key handlers, where a signal setter does not land.
  let draftValue = "";
  const draft = () => draftValue;
  const setDraft = (next: string) => {
    draftValue = next;
    if (field) field.value = next;
  };
  const editing = () => open;
  const [busy, setBusy] = createSignal(false);
  let field: HTMLInputElement | undefined;
  let focused = false;
  let titleRow: HTMLSpanElement | undefined;
  let editorRow: HTMLSpanElement | undefined;

  /**
   * The one place the open/closed state reaches the document.
   *
   * An inline `display` rather than toggling `hidden`/`flex`. Those two are
   * both plain utilities, and `.hidden{display:none}` is emitted *after*
   * `.flex{display:flex}`, so an element carrying both stays hidden however the
   * classes were toggled: the cascade decides on source order, not on which was
   * added last. Measured here, the row's own layout moved while the element it
   * was meant to reveal stayed `0x0`.
   */
  const apply = (next: boolean): void => {
    log.warn(
      `RP apply id=${id} next=${next} via=${new Error().stack?.split("\n").slice(1, 4).join(" | ")}`,
    );
    open = next;
    if (titleRow) titleRow.style.display = next ? "none" : "flex";
    if (editorRow) editorRow.style.display = next ? "flex" : "none";
  };
  editors.set(id, apply);
  onCleanup(() => editors.delete(id));

  const start = () => {
    setDraft(props.value);
    openEditor(id);
    queueMicrotask(() => {
      field?.focus();
      field?.select();
    });
  };

  const cancel = () => {
    setDraft(props.value);
    closeEditor(id);
  };

  const commit = async (): Promise<void> => {
    const name = draft().trim();
    closeEditor(id);
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
      {/*
        Both branches are always built, and visibility is a class rather than a
        `Show` swap.

        `Show` mounted the editor only once `editing()` had already flipped, so
        the whole interaction depended on that one signal read re-running the
        fallback branch. In the real renderer it did not: the pencil's click was
        delivered and acknowledged, the handler ran, and the tree never changed,
        so the editor could not be reached at all and the title looked dead.
        Keeping both in the tree removes the dependency: the pencil toggles what
        is shown, not what exists.
      */}
      <span
        ref={(element: HTMLSpanElement) => {
          titleRow = element;
        }}
        class="flex min-w-0 flex-1 items-center gap-1.5"
      >
        <Show
          when={props.onActivate}
          fallback={<span class="min-w-0 truncate">{props.value}</span>}
        >
          {(activate) => (
            <Button
              type="button"
              onClick={() => activate()()}
              aria-label={tx("Open project {name}", { name: props.value })}
              class="min-w-0 truncate text-left"
            >
              {props.value}
            </Button>
          )}
        </Show>
        <Button
          type="button"
          onClick={start}
          disabled={busy()}
          aria-label={props.label ?? tx("Rename {name}", { name: props.value })}
          class="flex size-[18px] shrink-0 items-center justify-center rounded p-0 text-az-faint transition-colors hover:bg-white/8 hover:text-az-body"
        >
          <Icon name="pencil" class="text-[11px]" />
        </Button>
      </span>
      <span
        ref={(element: HTMLSpanElement) => {
          editorRow = element;
        }}
        class="hidden min-w-0 flex-1"
      >
        <Input.Field
          ref={(element: HTMLInputElement) => {
            field = element;
          }}
          value={draft()}
          aria-label={props.label ?? tx("Project name")}
          autofocus
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          /*
           * Clicking away has to close the editor too. Without this the only
           * ways out are Enter and Escape, so a reader who opens the editor
           * with the pointer and then clicks elsewhere is left with an input
           * that will not go away: the state lives in this component rather
           * than in the tab, so it survives a tab switch and comes back still
           * open. Committing rather than cancelling keeps a typed name, which
           * is the reading most people expect from clicking away.
           */
          onBlur={() => {
            /*
             * Only once the field has actually taken focus.
             *
             * Opening the editor moves focus, and the blur that fires on the
             * outgoing element reaches this handler while the editor is still
             * being shown: it committed and closed within the same click that
             * opened it, which is why the pencil looked dead. `focused` is set
             * by `onFocus`, so a blur before that is the opening one and is
             * not a reader clicking away.
             */
            if (!focused) return;
            focused = false;
            if (editing()) void commit();
          }}
          onFocus={() => {
            focused = true;
          }}
          class={`min-w-0 flex-1 rounded-md border border-az-hairline-strong bg-az-inset px-2 py-0.5 text-az-title outline-none focus:border-az-link ${props.inputClass ?? ""}`}
        />
      </span>
    </span>
  );
}
