import { createSignal, type JSX, Show } from "solid-js";
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

  const start = () => {
    setDraft(props.value);
    setEditing(true);
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
    <Show
      when={editing()}
      fallback={
        <span class={`flex min-w-0 items-center gap-1.5 ${props.class ?? ""}`}>
          <Show
            when={props.onActivate}
            fallback={<span class="min-w-0 truncate">{props.value}</span>}
          >
            {(activate) => (
              <button type="button" onClick={() => activate()()} class="min-w-0 truncate text-left">
                {props.value}
              </button>
            )}
          </Show>
          <button
            type="button"
            // Stopped so a rename click cannot double as the header's own
            // click (on Home, that click folds the group).
            onClick={(event) => {
              event.stopPropagation();
              start();
            }}
            disabled={busy()}
            aria-label={props.label ?? tx("Rename {name}", { name: props.value })}
            // Always visible. Hover-to-reveal hides the only clue that a name
            // can be changed at all, from the one person who wants to change it.
            class="flex size-[18px] shrink-0 items-center justify-center rounded text-az-faint transition-colors hover:bg-white/8 hover:text-az-body"
          >
            <Icon name="pencil" class="text-[11px]" />
          </button>
        </span>
      }
    >
      <input
        // The field only exists once you have asked to edit, so focusing it is
        // completing the action rather than stealing focus on load.
        autofocus
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
        onBlur={() => void commit()}
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
    </Show>
  );
}
