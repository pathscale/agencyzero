import { createSignal, type JSX, onMount, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { PillMenu } from "~/components/PillMenu";
import { PERMISSION_LABELS, PERMISSION_ORDER } from "~/lib/labels";
import type { Permission } from "~/types";

const PERMISSION_HINTS: Record<Permission, string> = {
  read_only: "Reads only. The crate default.",
  plan: "Proposes a plan, changes nothing.",
  edit: "Edits inside the working directories.",
  auto: "Runs tools without asking each time.",
  bypass: "No prompts. The moderator is the only check.",
};

export type ComposerProps = {
  placeholder: string;
  model: string;
  /**
   * What the model pill offers, already filtered to the user's Settings choice.
   *
   * Supplied rather than derived here so the composer stays a controlled
   * component: it renders the model it is given and reports changes, and has no
   * opinion on which models exist.
   */
  modelOptions: { value: string; label: string }[];
  permission: Permission;
  onModelChange: (model: string) => void;
  onPermissionChange: (permission: Permission) => void;
  /**
   * Resolves on success. The draft is held until then, so an IPC, database or
   * backend failure cannot swallow a prompt someone spent minutes writing.
   */
  onSend: (body: string) => Promise<void>;
  /** Shown on the right of the control row, e.g. "18.7k tok · $0.017". */
  usage?: string;
  /** A run is in flight: the send button becomes Stop. */
  isRunning?: boolean;
  onStop?: () => void;
  /** Larger prompt text, centred layout — the new-project variant. */
  size?: "md" | "lg";
  /** Put the cursor here on mount, so an opened tab is ready to type into. */
  autofocus?: boolean;
};

/**
 * The composer, and the only place the tab's model and permission live.
 *
 * Permission is per tab / per session and defaults to `read_only`, so it has to
 * be visible at the moment of sending rather than buried in a settings screen —
 * that is the whole reason it is a pill here and not a preference.
 */
export function Composer(props: ComposerProps): JSX.Element {
  const [draft, setDraft] = createSignal("");
  const [isSending, setIsSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let field!: HTMLTextAreaElement;

  const canSend = () => draft().trim().length > 0 && !isSending();

  /**
   * The offered models, plus the tab's own if the selection no longer holds it.
   *
   * A tab keeps the model it was set to. Dropping it from the menu because
   * Settings stopped offering it would leave the pill showing one model and the
   * menu unable to express it, and the next message would go out under a model
   * the user never chose. Keeping it visible makes the mismatch the user's to
   * resolve.
   */
  const options = () =>
    props.modelOptions.some((option) => option.value === props.model)
      ? props.modelOptions
      : [...props.modelOptions, { value: props.model, label: props.model }];

  /**
   * Clears only after the send resolves.
   *
   * A prompt is often long and carefully written; clearing on dispatch and
   * discovering the failure afterwards means it is already gone. `isSending`
   * also blocks the double-submit that Enter-mashing would otherwise cause.
   */
  async function submit(): Promise<void> {
    if (!canSend()) return;

    setError(null);
    setIsSending(true);
    try {
      await props.onSend(draft().trim());
      setDraft("");
      resize();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSending(false);
    }
  }

  /*
   * `autofocus` as an attribute is only honoured on the initial page load, and
   * this element is mounted when a tab opens — so the browser ignores it and
   * the cursor lands nowhere. Focused explicitly instead, which is the point:
   * open a tab and start typing.
   */
  onMount(() => {
    if (props.autofocus) field.focus();
  });

  /** Grow with the content up to a ceiling, then scroll — no jumping layout. */
  function resize(): void {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 168)}px`;
  }

  return (
    <div
      class={`az-ring rounded-[17px] ${props.size === "lg" ? "az-ring-strong rounded-[19px]" : ""}`}
    >
      <div
        class={`flex flex-col gap-3 bg-az-inset ${props.size === "lg" ? "rounded-[18px] p-[18px] pb-3.5" : "rounded-2xl p-[15px] pb-3"}`}
      >
        <textarea
          ref={field}
          rows={1}
          value={draft()}
          placeholder={props.placeholder}
          aria-label={props.placeholder}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
            resize();
          }}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a newline. Standard for a chat box,
            // and the reason this is a textarea rather than an input.
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void submit();
          }}
          class={`az-scroll w-full resize-none bg-transparent text-base-content leading-[1.45] placeholder:text-az-faint focus:outline-none ${
            props.size === "lg" ? "text-[15px]" : "text-[14.5px]"
          }`}
        />

        <Show when={error()}>
          {(message) => (
            <p role="alert" class="text-[12px] text-error">
              Could not send — your message is still here. {message()}
            </p>
          )}
        </Show>

        <div class="flex items-center gap-2.5">
          <button
            type="button"
            title="Attach"
            aria-label="Attach"
            class="flex size-[30px] items-center justify-center rounded-full border border-az-hairline-strong text-az-body transition-colors hover:border-white/30 hover:text-az-title"
          >
            <Icon name="plus" class="text-[16px]" />
          </button>

          <PillMenu
            label="Model"
            prefix="Claude"
            icon="sparkles"
            iconClass="text-primary"
            value={props.model}
            options={options()}
            onChange={props.onModelChange}
          />

          <PillMenu
            label="Permission"
            icon="lock"
            variant="outline"
            value={props.permission}
            options={PERMISSION_ORDER.map((permission) => ({
              value: permission,
              label: PERMISSION_LABELS[permission],
              hint: PERMISSION_HINTS[permission],
            }))}
            onChange={props.onPermissionChange}
          />

          <div class="flex-1" />

          <Show when={props.usage}>
            <span class="font-mono text-[11.5px] text-az-faint">{props.usage}</span>
          </Show>

          <button
            type="button"
            title="Dictate"
            aria-label="Dictate"
            class="text-az-body transition-colors hover:text-az-title"
          >
            <Icon name="mic" class="text-[16px]" />
          </button>

          <Show
            when={props.isRunning}
            fallback={
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend()}
                aria-label="Send"
                class="flex size-8 items-center justify-center rounded-full bg-primary text-primary-content transition-colors hover:bg-[#fff176] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name="arrow-up" class="text-[17px]" />
              </button>
            }
          >
            <button
              type="button"
              onClick={() => props.onStop?.()}
              aria-label="Stop the run"
              class="flex size-8 items-center justify-center rounded-full border border-primary/40 bg-base-300 transition-colors hover:border-primary"
            >
              <span class="size-[11px] rounded-[3px] bg-primary" />
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
