import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { PillMenu } from "~/components/PillMenu";
import { PERMISSION_LABELS, PERMISSION_ORDER } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { useWorkspace } from "~/stores/workspace";
import type { Permission } from "~/types";

const PERMISSION_HINTS: Record<Permission, string> = {
  read_only: "Reads only. The crate default.",
  plan: "Proposes a plan, changes nothing.",
  ask: "Each gated call asks you first, mid-run.",
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
  /**
   * Reasoning levels the selected model accepts, in the vendor's order.
   *
   * Empty means the catalogue does not establish a ladder for this model, which
   * is different from "this model has no effort setting". The control is hidden
   * in that case rather than guessed at.
   */
  efforts: string[];
  effort: string;
  onEffortChange?: (effort: string) => void;
  permission: Permission;
  onModelChange: (model: string) => void;
  onPermissionChange: (permission: Permission) => void;
  /**
   * Resolves on success. The draft is held until then, so an IPC, database or
   * backend failure cannot swallow a prompt someone spent minutes writing.
   */
  onSend: (body: string) => Promise<void>;
  /** Shown on the right of the control row, e.g. "31.4k / 200k ctx · 16%". */
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
 * Attached files as pills: paperclip, basename, full path on hover, × to
 * drop one before sending. Shared with the Home task manager's composer.
 *
 * A pill, not a path in the text, because a path in the draft reads as
 * plumbing the user must not touch — this looks like the upload it
 * behaves as, while the transport underneath stays paths-in-prose.
 */
export function AttachmentPills(props: {
  paths: string[];
  onRemove: (path: string) => void;
}): JSX.Element {
  return (
    <Show when={props.paths.length > 0}>
      <div class="flex flex-wrap gap-1.5">
        <For each={props.paths}>
          {(path) => (
            <span
              title={path}
              class="flex max-w-[260px] items-center gap-1.5 rounded-full border border-az-hairline-strong bg-base-300 py-1 pr-1.5 pl-2.5 text-[11.5px]"
            >
              <Icon name="paperclip" class="shrink-0 text-[11px] text-az-muted" />
              <span class="min-w-0 truncate text-az-body">{path.split("/").pop() || path}</span>
              <button
                type="button"
                onClick={() => props.onRemove(path)}
                aria-label={`Remove ${path.split("/").pop() || path}`}
                class="flex size-[16px] shrink-0 items-center justify-center rounded-full text-az-faint transition-colors hover:bg-white/10 hover:text-base-content"
              >
                <Icon name="x" class="text-[11px]" />
              </button>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}

/**
 * The composer, and the only place the tab's model and permission live.
 *
 * Permission is per tab / per session and defaults to `read_only`, so it has to
 * be visible at the moment of sending rather than buried in a settings screen —
 * that is the whole reason it is a pill here and not a preference.
 */
export function Composer(props: ComposerProps): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [draft, setDraft] = createSignal("");
  const [attachments, setAttachments] = createSignal<string[]>([]);
  const [isSending, setIsSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let field!: HTMLTextAreaElement;

  // Sending while a run is live is allowed again — the store queues it and
  // sends when the run lands, so Enter never starts a second run and never
  // bounces the words back either. Attachments alone are a sendable message:
  // "eat this file" needs no caption.
  const canSend = () => (draft().trim().length > 0 || attachments().length > 0) && !isSending();

  /**
   * The Attach button: the OS picker, and the chosen files held as pills
   * beside the draft. The transport is unchanged — on send the paths join the
   * message body, because the agents read file paths in prose and nothing is
   * uploaded — but visually the file is "attached", not pasted plumbing.
   */
  const attach = async (): Promise<void> => {
    try {
      const paths = await actions.chooseAttachments();
      if (paths.length === 0) return;
      setAttachments((current) => [...current, ...paths.filter((path) => !current.includes(path))]);
      field.focus();
    } catch (cause) {
      log.warn(`could not attach: ${describeError(cause)}`);
    }
  };

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
      // The pills become prose here: the paths ride at the end of the body,
      // where the model reads them.
      const body = [draft().trim(), attachments().join("\n")]
        .filter((part) => part.length > 0)
        .join("\n\n");
      await props.onSend(body);
      setDraft("");
      setAttachments([]);
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
        <AttachmentPills
          paths={attachments()}
          onRemove={(path) =>
            setAttachments((current) => current.filter((existing) => existing !== path))
          }
        />
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

        {/*
          Posture and input controls left, model and effort right, per the newer
          reference. This departs from design/workspace.html, which puts the
          model pill on the left after Attach; recorded in the frontend README.
        */}
        <div class="flex items-center gap-2.5">
          <PillMenu
            label="Permission"
            icon="lock"
            value={props.permission}
            options={PERMISSION_ORDER.map((permission) => ({
              value: permission,
              label: PERMISSION_LABELS[permission],
              hint: PERMISSION_HINTS[permission],
            }))}
            onChange={props.onPermissionChange}
          />

          <button
            type="button"
            onClick={() => void attach()}
            // Greyed on a build whose backend lacks the picker, per the house
            // convention — a button that silently does nothing is the bug this
            // replaces.
            disabled={!isLive("chooseAttachments")}
            title="Attach files — their paths go into the prompt"
            aria-label="Attach files"
            class="flex size-[30px] items-center justify-center rounded-full border border-az-hairline-strong text-az-body transition-colors hover:border-primary/30 hover:text-az-title disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="plus" class="text-[16px]" />
          </button>

          <div class="flex-1" />

          {/* Text only, by request: the numbers already say how full it is. */}
          <Show when={props.usage}>
            <span class="font-mono text-[11.5px] text-az-faint">{props.usage}</span>
          </Show>

          <PillMenu
            label="Model"
            prefix="Claude"
            icon="sparkles"
            iconClass="text-primary"
            variant="outline"
            value={props.model}
            options={props.modelOptions}
            onChange={props.onModelChange}
          />

          {/*
            Effort is per model, not per agent, so the ladder comes from the
            catalogue entry rather than a shared list. A model whose ladder the
            crate has not established reports none, and the control is hidden
            rather than filled with a guess: `agent-abstraction` leaves Claude's
            `efforts` empty on purpose, and inventing levels here would put a
            list in the UI that nothing verified.
          */}
          <Show when={props.efforts.length > 0}>
            <PillMenu
              label="Effort"
              variant="outline"
              value={props.effort}
              options={props.efforts.map((effort) => ({ value: effort, label: effort }))}
              onChange={(effort) => props.onEffortChange?.(effort)}
            />
          </Show>

          {/*
            While a run is live the pair reads: speak into the turn, or stop
            it. A message sent now is delivered into the open turn and the
            model takes it at its next step boundary — a real interruption,
            so the button keeps its ordinary send face.
          */}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend()}
            aria-label={props.isRunning ? "Send into the running turn" : "Send"}
            title={
              props.isRunning
                ? "Delivered into the running turn — the agent takes it at its next step"
                : undefined
            }
            class="flex size-8 items-center justify-center rounded-full bg-primary text-primary-content transition-colors hover:bg-az-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="arrow-up" class="text-[17px]" />
          </button>
          <Show when={props.isRunning}>
            <button
              type="button"
              onClick={() => props.onStop?.()}
              // No handler means the backend cannot stop this run; a Stop
              // that only pretended would be worse than a disabled one.
              disabled={!props.onStop}
              aria-label="Stop the run"
              class="flex size-8 items-center justify-center rounded-full border border-primary/40 bg-base-300 transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span class="size-[11px] rounded-[3px] bg-primary" />
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
