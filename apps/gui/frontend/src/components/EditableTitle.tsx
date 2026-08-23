import { Input } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
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
 * name — a nameless tab is unusable and there is no undo. The pencil only
 * appears on hover or focus, so a header that is usually read rather than
 * edited does not carry a permanent button.
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

  /*
   * The class strings as memos, not inline ternaries.
   *
   * Read inline in JSX, the first press did nothing and the second opened the
   * editor: `start()` ran and the write landed every time, and the view only
   * caught up on a later render. A `createMemo` owns its own computation
   * rather than borrowing whichever effect reads it first, which is the
   * ownership freeze `HomeTab.tsx` documents for a compute placed directly in
   * a Layout component.
   */
  const nameClass = createMemo(
    () => `flex min-w-0 flex-1 items-center gap-1.5${editing() ? " hidden" : ""}`,
  );
  const editorClass = createMemo(() => `flex min-w-0 flex-1${editing() ? "" : " hidden"}`);

  let field: HTMLInputElement | undefined;

  const start = () => {
    setDraft(props.value);
    setEditing(true);
    // After the style swap has been applied, so the field is displayed by the
    // time it is asked to take focus.
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
    /*
     * One stable parent, both branches always mounted, swapped with `hidden`.
     *
     * The obvious shape is a `<Show>` whose fallback is the read-only name and
     * whose body is the field. Measured against a running 0.8.25, that shape
     * never displays: the editing branch is built but never attached, so its
     * textbox has exactly one parent and no further ancestors, where an input
     * that is merely hidden still walks eight levels to the window root. The
     * pencil stayed on screen and each click leaked another orphan.
     *
     * `scripts/repro/rename-editor-detached.sh` measures all of that. Keeping
     * both subtrees mounted under one parent means the swap is a style change
     * on nodes that are already in the document, which is a path the renderer
     * does honour.
     */
    <span class={`flex min-w-0 items-center gap-1.5 ${props.class ?? ""}`}>
      <span class={nameClass()} aria-hidden={editing() ? "true" : undefined}>
        <Show
          when={props.onActivate}
          fallback={<span class="min-w-0 truncate">{props.value}</span>}
        >
          {(activate) => (
            <Button type="button" onClick={() => activate()()} class="min-w-0 truncate text-left">
              {props.value}
            </Button>
          )}
        </Show>
        <button
          type="button"
          /*
           * native-control: A native button, not the library's.
           *
           * The library `Button` renders through `Dynamic`, and the click on
           * this one never reached `start()`: driving it against a running
           * build acknowledged the hit in 1.5ms with no state change, against
           * 63ms and a 254-node change for a control button on the same
           * surface. Nothing here needs the library's variants.
           *
           * Editing starts on `mousedown`, not `click`.
           *
           * The row this sits in is a `role="button"` whose own `onClick`
           * folds it. Solid 2 delegates `click`, so both handlers are read
           * during one synthetic walk up from the target, and the pencil's
           * `stopPropagation` lost that race: pressing it folded the row
           * (+30 nodes, measured) and left the editor closed at 0x0.
           *
           * `mousedown` fires before `click` exists, so stopping it there
           * keeps the row's gesture from ever starting. It also has to stay a
           * JSX handler: the same logic moved to a hand-attached listener in a
           * `ref` stopped the fold correctly but still never opened the
           * editor, because a `ref` callback runs outside the reactive system
           * and the write landed in a signal nothing was watching.
           *
           * Do not reach for `runWithOwner` to fix that: a reactive write from
           * inside an owned scope raises `REACTIVE_WRITE_IN_OWNED_SCOPE`,
           * which escapes as `REACTIVITY_HALTED` and freezes the whole app.
           * `lib/live.ts` documents that trap.
           *
           * Measured after this change: the textbox goes from `0x0 HIDDEN` to
           * `300x21` on one press.
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
          class="flex size-[18px] shrink-0 items-center justify-center rounded text-az-faint transition-colors hover:bg-white/8 hover:text-az-body"
        >
          <Icon name="pencil" class="text-[11px]" />
        </button>
      </span>
      {/*
        Wrapped, and the *wrapper* is what hides.

        `Input.Field` renders inside the library's own control div, so styling
        the field alone left that div in the layout: measured at 101x46 beside
        every project name, painting as a black rectangle and squeezing the
        name it sits next to down to a few characters. Hiding from the outside
        removes the box as well as its contents.
      */}
      <span class={editorClass()}>
        <Input.Field
          /*
           * Focused when editing begins, not by `autofocus`.
           *
           * The field is mounted for the life of the component now, so there is
           * no mount to hang focus off, and `autofocus` is applied once at the
           * end of the flush that appends a node. `Composer` reaches for
           * `field.focus()` for the same reason.
           */
          ref={(element: HTMLInputElement) => {
            field = element;
          }}
          value={draft()}
          aria-label={props.label ?? tx("Project name")}
          /*
           * The row behind this field opens a project on double click, so
           * selecting a word to retype it navigated away and dropped the edit.
           * A field's own mouse gestures stop here.
           */
          onClick={(event) => event.stopPropagation()}
          onDblClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          // Only a blur that leaves an open editor commits. The field is mounted
          // for the life of the component now, so it also blurs while hidden,
          // and committing on that would close the editor as soon as it opened.
          onBlur={() => {
            if (editing()) void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              // Abandoned, not committed: blur would otherwise save what Escape
              // was pressed to discard.
              setDraft(props.value);
              setEditing(false);
            }
          }}
          class={`min-w-0 flex-1 rounded-md border border-az-hairline-strong bg-az-inset px-2 py-0.5 text-az-title outline-none focus:border-az-link ${props.inputClass ?? ""}`}
        />
      </span>
    </span>
  );
}
