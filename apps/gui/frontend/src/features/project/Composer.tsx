import { createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { PillMenu } from "~/components/PillMenu";
import { PERMISSION_LABELS, PERMISSION_ORDER } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { compileAdvancedPrompt, type PromptModelOption } from "~/lib/promptEditor";
import { parseSlash } from "~/lib/slash";
import { prefs, setPrefs } from "~/stores/prefs";
import { useWorkspace } from "~/stores/workspace";
import type { Agent, Permission } from "~/types";

const PERMISSION_HINTS: Record<Permission, string> = {
  read_only: "Reads only. The crate default.",
  plan: "Proposes a plan, changes nothing.",
  ask: "Each gated call asks you first, mid-run.",
  edit: "Edits inside the working directories.",
  auto: "Runs tools without asking each time.",
  bypass: "No prompts. The moderator is the only check.",
};

export type ComposerProps = {
  /**
   * Where a half-written message is filed, usually the tab key.
   *
   * Switching tabs unmounts the screen this lives on, so without somewhere
   * outside the component to keep it, an unsent reply dies with the unmount.
   * Absent means "do not persist" — the tests mount a bare composer.
   */
  draftKey?: string;
  placeholder: string;
  agent: Agent;
  model: string;
  /**
   * What the model pill offers, already filtered to the user's Settings choice.
   *
   * Supplied rather than derived here so the composer stays a controlled
   * component: it renders the model it is given and reports changes, and has no
   * opinion on which models exist.
   */
  modelOptions: PromptModelOption[];
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
  /** Postures this provider can execute without silently degrading them. */
  permissions?: Permission[];
  onModelChange: (agent: Agent, model: string) => void;
  onPermissionChange: (permission: Permission) => void;
  /**
   * Run `/compact` against this conversation's session.
   *
   * A callback rather than a project id, so the composer stays the controlled
   * component it is everywhere else: it knows a command was typed, not which
   * conversation it belongs to. Absent means the surface has no session to
   * compact, which is the honest state for the mock and for a bare test mount.
   */
  onCompact?: () => Promise<void>;
  /**
   * What this conversation's agent reported it can do.
   *
   * Only used to explain a command this app does not run: "the agent offers
   * /context" beats "unknown command" for something the user can see working in
   * their own terminal. Absent until a run reports one, and absence means the
   * parser does not second-guess an unknown word.
   */
  available?: { all: string[]; skills: string[] };
  /**
   * Resolves on success. The draft is held until then, so an IPC, database or
   * backend failure cannot swallow a prompt someone spent minutes writing.
   */
  onSend: (body: string) => Promise<void>;
  /** Shown on the right of the control row, e.g. "31.4k / 200k ctx · 16%". */
  usage?: string;
  /** A run is in flight: the send button becomes Stop. */
  isRunning?: boolean;
  /** Whether a send during that run enters it instead of waiting for the slot. */
  canFollowUp?: boolean;
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
/** A shared empty list, so `attachments()` is stable when nothing is staged. */
const EMPTY_ATTACHMENTS: string[] = [];

export function Composer(props: ComposerProps): JSX.Element {
  const { actions, isLive } = useWorkspace();
  /*
   * The draft is *derived* from the key, never copied into local state.
   *
   * Switching between two project tabs does not unmount this component — both
   * live in the same `<Match>` branch, so Solid reuses the instance and only
   * swaps the props. A signal seeded once at mount therefore kept the previous
   * tab's words, showed them under the new tab, and wrote them back under the
   * new key on the next keystroke: one draft leaked into the next tab and the
   * one it landed on was overwritten. Reading through `props.draftKey` on every
   * render is what makes the box always show *this* tab's text.
   *
   * The local signal is only for a composer mounted without a key, which is how
   * the tests drive it.
   */
  const [unkeyed, setUnkeyed] = createSignal("");
  const draft = () => (props.draftKey ? (prefs.composerDrafts[props.draftKey] ?? "") : unkeyed());

  const remember = (text: string) => {
    if (!props.draftKey) {
      setUnkeyed(text);
      return;
    }
    setPrefs("composerDrafts", props.draftKey, text);
  };

  /*
   * Everything else the composer holds is keyed the same way, and for the same
   * reason the draft is.
   *
   * The instance is reused across tabs, so a plain signal is *one* value shown
   * under every tab in turn. The draft was fixed for that; these were not, and
   * each leaked in its own way. An error from one conversation appeared under
   * all of them, which is what made a failure in a single project look like the
   * app being broken everywhere. Staged attachments were worse than confusing:
   * files chosen in one tab were still attached in the next, so the send button
   * would have handed another project's paths to this project's agent.
   *
   * Keyed rather than cleared on switch, so coming back to a tab finds what was
   * left there. The unkeyed bucket is for a bare composer, which is how the
   * tests mount it.
   */
  const UNKEYED = "\u0000unkeyed";
  const bucket = () => props.draftKey ?? UNKEYED;
  const advanced = () => prefs.advancedComposerKeys.includes(bucket());
  const compiled = createMemo(() =>
    advanced() ? compileAdvancedPrompt(draft(), props.modelOptions) : null,
  );
  const toggleAdvanced = () => {
    const key = bucket();
    setPrefs(
      "advancedComposerKeys",
      advanced()
        ? prefs.advancedComposerKeys.filter((candidate) => candidate !== key)
        : [...prefs.advancedComposerKeys, key],
    );
  };
  const [errors, setErrors] = createSignal<Record<string, string | null>>({});
  const [staged, setStaged] = createSignal<Record<string, string[]>>({});
  const [sending, setSending] = createSignal<Record<string, boolean>>({});

  const error = () => errors()[bucket()] ?? null;
  const attachments = () => staged()[bucket()] ?? EMPTY_ATTACHMENTS;
  const isSending = () => sending()[bucket()] ?? false;

  /*
   * Written against a captured key, never `bucket()`, so a result that lands
   * after the user switched tabs reports under the conversation it belongs to
   * rather than the one now on screen.
   */
  const setErrorFor = (key: string, message: string | null) =>
    setErrors((current) => ({ ...current, [key]: message }));
  const setSendingFor = (key: string, value: boolean) =>
    setSending((current) => ({ ...current, [key]: value }));
  const setError = (message: string | null) => setErrorFor(bucket(), message);
  const setAttachments = (next: string[] | ((previous: string[]) => string[])) => {
    const key = bucket();
    setStaged((current) => ({
      ...current,
      [key]: typeof next === "function" ? next(current[key] ?? EMPTY_ATTACHMENTS) : next,
    }));
  };
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

    /*
     * A slash command is handled here and never sent. It changes this tab's own
     * state, so there is nothing for an agent to do with it — and for the
     * commands that *would* need one, being told costs nothing where sending
     * would bill a turn for the model reading "/compact" as a request.
     */
    const command = parseSlash(draft(), {
      models: props.modelOptions.map((option) => option.model),
      efforts: props.efforts,
      available: props.available,
    });
    if (command.kind !== "none") {
      switch (command.kind) {
        case "model":
          {
            const option =
              props.modelOptions.find(
                (candidate) => candidate.agent === props.agent && candidate.model === command.model,
              ) ?? props.modelOptions.find((candidate) => candidate.model === command.model);
            if (option) props.onModelChange(option.agent, option.model);
          }
          break;
        case "effort":
          props.onEffortChange?.(command.effort);
          break;
        case "permission":
          props.onPermissionChange(command.permission);
          break;
        /*
         * The one command that leaves this window, and the only one whose
         * progress and result belong in the transcript rather than here.
         *
         * A compaction runs for a while and then changes the conversation the
         * user is reading, so it reports where they are reading: a status line
         * in the chat while it runs, and a note in the thread when it lands.
         * Reporting it here instead put "Compacted." in red under the composer,
         * where the only other thing that appears is a failure.
         *
         * Only a refusal that leaves no note behind — an occupied slot, a
         * backend that could not be reached — surfaces here, because nothing
         * else would say it.
         */
        case "compact": {
          const compact = props.onCompact;
          if (!compact) {
            setError("This conversation has no session to compact.");
            break;
          }
          /*
           * Fired without holding the composer. `sending` exists to stop a
           * second copy of *this message* going out while the first is in
           * flight, and a compaction is not a message — flagging it locked the
           * box for the whole minute the compaction ran, so Enter did nothing
           * and the words had nowhere to go. Which defeated the point: the
           * store queues anything typed during a compaction and sends it when
           * the session comes back, and it can only do that if you can type.
           *
           * The key is captured now anyway: a compaction takes a while, and a
           * failure belongs to the conversation it was asked of even if the
           * user has moved to another tab.
           */
          const key = bucket();
          void compact().catch((cause: unknown) => setErrorFor(key, describeError(cause)));
          break;
        }
        default:
          setError(command.message);
      }
      // Only a command that took effect clears the box; an error leaves the
      // words there to be corrected rather than retyped.
      if (command.kind !== "error" && command.kind !== "help") {
        remember("");
        resize();
      }
      if (command.kind === "help") setError(command.message);
      return;
    }

    // Captured before the await for the same reason the compaction captures it:
    // a send that fails after the user switched tabs must report under the tab
    // it was typed in, not whichever is on screen when the rejection lands.
    const key = bucket();
    setSendingFor(key, true);
    try {
      const advancedPrompt = compiled();
      if (advancedPrompt && advancedPrompt.errors.length > 0) {
        setErrorFor(key, advancedPrompt.errors.join(" "));
        return;
      }
      if (advancedPrompt?.model) {
        props.onModelChange(advancedPrompt.model.agent, advancedPrompt.model.model);
      }
      // The pills become prose here: the paths ride at the end of the body,
      // where the model reads them.
      const body = [advancedPrompt?.dataPlane ?? draft().trim(), attachments().join("\n")]
        .filter((part) => part.length > 0)
        .join("\n\n");
      if (body.length === 0) {
        setErrorFor(key, "The prompt contains controls but no message to send.");
        return;
      }
      await props.onSend(body);
      remember("");
      setAttachments([]);
      resize();
    } catch (cause) {
      setErrorFor(
        key,
        `Could not send — your message is still here. ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } finally {
      setSendingFor(key, false);
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
            remember(event.currentTarget.value);
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

        <Show when={advanced()}>
          <div class="rounded-lg border border-az-hairline bg-base-300/45 px-3 py-2">
            <div class="mb-1 font-semibold text-[10px] text-az-faint uppercase tracking-[0.08em]">
              Prompt Syntax preview
            </div>
            <div class="whitespace-pre-wrap text-[12px] text-az-body leading-relaxed">
              <For each={compiled()?.segments ?? []}>
                {(segment) =>
                  segment.type === "directive" ? (
                    <mark class="rounded border border-primary/30 bg-primary/15 px-0.5 text-primary">
                      {segment.source}
                    </mark>
                  ) : (
                    segment.text
                  )
                }
              </For>
            </div>
            <Show when={(compiled()?.errors.length ?? 0) > 0}>
              <ul class="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] text-error">
                <For each={compiled()?.errors}>{(message) => <li>{message}</li>}</For>
              </ul>
            </Show>
          </div>
        </Show>

        {/*
          Whatever is written here is the whole line. It used to be prefixed
          with "Could not send — your message is still here", which is true of a
          failed send and of nothing else: a successful compaction reported
          through this slot read as a failure, in red, directly under the box.
          The prefix now belongs to the send path that earns it.
        */}
        <Show when={error()}>
          {(message) => (
            <p role="alert" class="text-[12px] text-error">
              {message()}
            </p>
          )}
        </Show>

        {/*
          Posture and input controls left, model and effort right, per the newer
          reference. This departs from design/workspace.html, which puts the
          model pill on the left after Attach; recorded in the frontend README.
        */}
        <div class="flex items-center gap-2.5">
          <button
            type="button"
            onClick={toggleAdvanced}
            aria-pressed={advanced()}
            title="Parse Prompt Syntax controls before sending"
            class={`rounded-full border px-2.5 py-1 font-medium text-[11px] transition-colors ${
              advanced()
                ? "border-primary/35 bg-primary/15 text-primary"
                : "border-az-hairline-strong text-az-muted hover:text-base-content"
            }`}
          >
            Advanced
          </button>

          <PillMenu
            label="Permission"
            icon="lock"
            value={props.permission}
            options={(props.permissions ?? PERMISSION_ORDER).map((permission) => ({
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
            icon="sparkles"
            iconClass="text-primary"
            variant="outline"
            value={`${props.agent}:${props.model}`}
            options={props.modelOptions}
            onChange={(value) => {
              const option = props.modelOptions.find((candidate) => candidate.value === value);
              if (option) props.onModelChange(option.agent, option.model);
            }}
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

          {/* While a run is live, the provider capability decides whether this
              interrupts the open turn or queues for the next one. */}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend()}
            aria-label={
              props.isRunning
                ? props.canFollowUp
                  ? "Send into the running turn"
                  : "Queue after the running turn"
                : "Send"
            }
            title={
              props.isRunning
                ? props.canFollowUp
                  ? "Delivered into the running turn; the agent takes it at its next step"
                  : "Queued until the running turn finishes"
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
