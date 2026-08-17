import { Textarea } from "@pathscale/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { PillMenu } from "~/components/PillMenu";
import { AGENT_LABELS, PERMISSION_ORDER, permissionLabel } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import {
  assumedOutputTokensForEffort,
  compactEstimate,
  compactedContextTokens,
  compactionCost,
  costLabel,
  estimate,
  thinkingCostPerThousand,
} from "~/lib/pricing";
import { compileAdvancedPrompt, type PromptModelOption } from "~/lib/promptEditor";
import { parseSlash } from "~/lib/slash";
import { tx, type UiMessage } from "~/stores/i18n";
import { prefs, setPrefs } from "~/stores/prefs";
import { useWorkspace } from "~/stores/workspace";
import type { Agent, Permission, Question, StudyTurnMetadata } from "~/types";

const PERMISSION_HINTS = {
  read_only: "Reads only. The crate default.",
  plan: "Proposes a plan, changes nothing.",
  ask: "Each gated call asks you first, mid-run.",
  edit: "Edits inside the working directories.",
  auto: "Runs tools without asking each time.",
  bypass: "No prompts. The moderator is the only check.",
} satisfies Record<Permission, UiMessage>;

const permissionHint = (permission: Permission): string => tx(PERMISSION_HINTS[permission]);

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
  /**
   * "Extra Thinking": whether the model may reason before answering. Only Claude
   * acts on it, so the control is shown always but disabled for other agents
   * rather than hidden, the same way a greyed pill elsewhere means "not here".
   */
  extraThinking: boolean;
  onExtraThinkingChange?: (enabled: boolean) => void;
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
  onSend: (body: string, study: StudyTurnMetadata, replyQuestionId?: string) => Promise<void>;
  /** Question whose durable id will accompany the next sent owner message. */
  replyQuestion?: Question;
  replyQuestionNumber?: number;
  onCancelQuestionReply?: () => void;
  /** Context readout, shown as a chip in the composer's top-right corner. */
  usage?: string;
  /**
   * The warm context this next turn will resend, in tokens. Drives the live
   * cost estimate by the Send button and the pre-send alert. Absent or 0 on a
   * fresh session, where the estimate is just the new prompt.
   */
  contextTokens?: number;
  /** Reported provider context limit; absent when the provider exposes none. */
  contextWindow?: number;
  /** The provider/model that owns the history represented by contextTokens. */
  contextAgent?: Agent;
  contextModel?: string;
  /** A run is in flight: the send button becomes Stop. */
  isRunning?: boolean;
  /** Whether a send during that run enters it instead of waiting for the slot. */
  canFollowUp?: boolean;
  onStop?: () => void;
  /** Footer chrome entered or left and may have changed transcript height. */
  onChromeChange?: () => void;
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
              <Button
                type="button"
                onClick={() => props.onRemove(path)}
                aria-label={tx("Remove {name}", { name: path.split("/").pop() || path })}
                class="flex size-[16px] shrink-0 items-center justify-center rounded-full text-az-faint transition-colors hover:bg-white/10 hover:text-base-content"
              >
                <Icon name="x" class="text-[11px]" />
              </Button>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}

/** Trusted reply metadata, staged like an attachment but never editable prose. */
export function QuestionReplyPill(props: {
  question?: Question;
  number?: number;
  onRemove?: () => void;
}): JSX.Element {
  return (
    <Show when={props.question}>
      {(question) => (
        <span
          title={question().text}
          class="flex w-fit max-w-full items-center gap-1.5 self-start rounded-full border border-primary/35 bg-primary/10 py-1 pr-1.5 pl-2.5 text-[11.5px]"
        >
          <Icon name="message-square-dashed" class="shrink-0 text-[11px] text-primary" />
          <span class="shrink-0 font-semibold text-primary">
            {tx("Reply to #{number}", { number: props.number ?? "?" })}
          </span>
          <Show when={props.onRemove}>
            <Button
              type="button"
              onClick={() => props.onRemove?.()}
              aria-label={tx("Remove question reply")}
              class="flex size-[16px] shrink-0 items-center justify-center rounded-full text-az-faint transition-colors hover:bg-white/10 hover:text-base-content"
            >
              <Icon name="x" class="text-[11px]" />
            </Button>
          </Show>
        </span>
      )}
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
  const { state, actions, isLive } = useWorkspace();
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
  // The mounted selection is the effort that produced the warm session. Keep
  // it stable while another effort is previewed; an accepted send establishes
  // the next baseline.
  const [lastSentEffort, setLastSentEffort] = createSignal(props.effort);
  const advanced = () => prefs.advancedComposerKeys.includes(bucket());
  const expanded = () => prefs.expandedComposerKeys.includes(bucket());
  const compiled = createMemo(() =>
    advanced() ? compileAdvancedPrompt(draft(), props.modelOptions) : null,
  );

  /*
   * The live cost estimate for the next turn. Recomputed on every keystroke,
   * every model switch, and after a /compact shrinks the context — all of which
   * flow through the signals it reads (draft, props.model, props.contextTokens),
   * so nothing else has to poke it. An advanced prompt that names a model steers
   * the estimate to that model, matching what will actually run.
   *
   * The whole point is to answer "is this next turn expensive?" before Enter,
   * so the model used here is the one the send will use, and the context is the
   * warm history the agent resends.
   */
  const estimateModel = () => compiled()?.model?.model ?? props.model;
  const estimateAgent = () => compiled()?.model?.agent ?? props.agent;
  const isContextSwitch = () =>
    (props.contextTokens ?? 0) > 0 &&
    (estimateAgent() !== props.contextAgent || estimateModel() !== props.contextModel);
  const isEffortSwitch = () =>
    !isContextSwitch() &&
    props.agent === "claude" &&
    (props.contextTokens ?? 0) > 0 &&
    props.effort !== lastSentEffort();
  const isColdContext = () => isContextSwitch() || isEffortSwitch();
  /*
   * A half-typed `/compact` (or any command) is not a turn, so the estimate must
   * not price the drafted string as a prompt. `/compact` in particular runs the
   * compaction pass — a real, often large cost — so the chip and alert should
   * show *that* the moment the command is recognised, before Enter. Recomputed
   * with the draft, so the figure appears as you finish typing "/compact" and
   * clears the instant you add an argument that makes it prose again.
   */
  const isCompactCommand = () =>
    Boolean(props.onCompact) &&
    parseSlash(draft(), {
      models: props.modelOptions.map((option) => option.model),
      efforts: props.efforts,
      available: props.available,
    }).kind === "compact";
  const costEstimate = createMemo(() => {
    const table = state.pricing;
    if (!table) return null;
    const warnUsd = state.settings?.costWarningUsd ?? table.warnUsd;
    const effectiveTable = {
      ...table,
      warnUsd,
      // A custom warning above the built-in $2 danger threshold must still
      // mean what the slider says. Keep "high" above warning rather than
      // letting it reopen the card before the chosen threshold.
      highUsd: Math.max(table.highUsd, warnUsd * 2),
    };
    if (isCompactCommand()) {
      return compactEstimate(effectiveTable, estimateModel(), props.contextTokens ?? 0);
    }
    return estimate(
      effectiveTable,
      estimateModel(),
      draft(),
      props.contextTokens ?? 0,
      assumedOutputTokensForEffort(props.effort, props.agent === "claude" && props.extraThinking),
      isColdContext(),
    );
  });

  /*
   * Dismiss means a real ten-minute snooze, not "hide until the next
   * keystroke". That older behaviour made a warning the user had explicitly
   * closed jump straight back while they were still editing. The count is
   * durable so its second appearance can offer the permanent opt-out.
   */
  const [confirmDisableCostWarning, setConfirmDisableCostWarning] = createSignal(false);
  const dismissCostAlert = () => {
    setConfirmDisableCostWarning(false);
    setPrefs({
      costWarningDismissals: prefs.costWarningDismissals + 1,
      costWarningSnoozedUntil: Date.now() + 10 * 60 * 1_000,
    });
  };
  const showCostAlert = () => {
    const est = costEstimate();
    if (prefs.costWarningsDisabled || Date.now() < prefs.costWarningSnoozedUntil) return false;
    if (!est?.priced || (est.severity === "low" && !isContextSwitch())) return false;
    return true;
  };
  createEffect(() => {
    // Both values change the warning's height. The callback is optional because
    // draft and test composers have no transcript above them to realign.
    void showCostAlert();
    void confirmDisableCostWarning();
    props.onChromeChange?.();
  });
  const compactPressure = () => {
    const tokens = props.contextTokens ?? 0;
    const window = props.contextWindow ?? 0;
    const share = window > 0 ? tokens / window : null;
    if (share !== null) {
      if (share >= 0.9) return "red" as const;
      if (share >= 0.8) return "orange" as const;
      if (share >= 0.65) return "yellow" as const;
      return null;
    }
    // Codex does not currently report its window. Raw thresholds keep the
    // app-owned rollover available without inventing a percentage.
    if (props.agent === "codex") {
      if (tokens >= 300_000) return "red" as const;
      if (tokens >= 200_000) return "orange" as const;
      if (tokens >= 100_000) return "yellow" as const;
    }
    return null;
  };
  const runCompact = () => {
    const compact = props.onCompact;
    if (!compact) return;
    const key = bucket();
    void compact().catch((cause: unknown) => setErrorFor(key, describeError(cause)));
  };
  const toggleAdvanced = () => {
    const key = bucket();
    setPrefs(
      "advancedComposerKeys",
      advanced()
        ? prefs.advancedComposerKeys.filter((candidate) => candidate !== key)
        : [...prefs.advancedComposerKeys, key],
    );
  };
  const toggleExpanded = () => {
    const key = bucket();
    setPrefs(
      "expandedComposerKeys",
      expanded()
        ? prefs.expandedComposerKeys.filter((candidate) => candidate !== key)
        : [...prefs.expandedComposerKeys, key],
    );
  };
  const [errors, setErrors] = createSignal<Record<string, string | null>>({});
  const [staged, setStaged] = createSignal<Record<string, string[]>>({});
  const [sending, setSending] = createSignal<Record<string, boolean>>({});

  const error = () => errors()[bucket()] ?? null;
  const attachments = () => staged()[bucket()] ?? EMPTY_ATTACHMENTS;
  const isSending = () => sending()[bucket()] ?? false;
  const selectedAgent = () => state.agents.find((candidate) => candidate.agent === props.agent);
  const agentReady = () => state.boot.status !== "ready" || selectedAgent()?.state === "connected";
  const agentBlockedReason = () =>
    tx("{agent} is not ready. Install or sign in from Settings, then run the agent checks again.", {
      agent: AGENT_LABELS[props.agent],
    });

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
  const [promptHeight, setPromptHeight] = createSignal(22);
  /*
   * Drives the drift across the composer's edge. Tracked here rather than with
   * `:focus-within` so the animation starts and stops on an event this code
   * owns: it is a render loop for as long as it runs.
   *
   * Keyed on keystrokes rather than on focus, and this is the whole point.
   * Blitz treats a running CSS animation as an active document and submits
   * full frames for as long as one exists, so this class is worth ~30fps of
   * resolve, scene and paint over the entire window: measured at 1.4fps and
   * under 2% CPU with the composer unfocused, and 29.9fps and 46% CPU with a
   * cursor sitting in it and nothing else happening at all. Focus is not
   * writing. A cursor parked in the box while its owner reads the transcript,
   * or walks away, held a core for four hours.
   */
  const DRIFT_IDLE_MS = 3_000;
  const [writing, setWriting] = createSignal(false);
  let driftTimer: ReturnType<typeof setTimeout> | undefined;
  const stopDrift = (): void => {
    if (driftTimer !== undefined) clearTimeout(driftTimer);
    driftTimer = undefined;
    setWriting(false);
  };
  // Each keystroke re-arms the timer, so a burst of typing is one continuous
  // drift rather than a flicker, and it ends a few seconds after the last one.
  const keepDrifting = (): void => {
    setWriting(true);
    if (driftTimer !== undefined) clearTimeout(driftTimer);
    driftTimer = setTimeout(stopDrift, DRIFT_IDLE_MS);
  };
  onCleanup(stopDrift);

  // Sending while a run is live is allowed again — the store queues it and
  // sends when the run lands, so Enter never starts a second run and never
  // bounces the words back either. Attachments alone are a sendable message:
  // "eat this file" needs no caption.
  const canSend = () =>
    agentReady() && (draft().trim().length > 0 || attachments().length > 0) && !isSending();

  /**
   * The Attach button: the OS picker, and the chosen files held as pills
   * beside the draft. The transport is unchanged — on send the paths join the
   * message body, because the agents read file paths in prose and nothing is
   * uploaded — but visually the file is "attached", not pasted plumbing.
   */
  const attach = async (): Promise<void> => {
    const key = bucket();
    try {
      setErrorFor(key, null);
      const paths = await actions.chooseAttachments();
      if (paths.length === 0) return;
      setAttachments((current) => [...current, ...paths.filter((path) => !current.includes(path))]);
      field.focus();
    } catch (cause) {
      /*
       * Say so on the surface, not only in the log. This used to warn and
       * return, so a picker that failed to open was indistinguishable from
       * one the owner cancelled: the button appeared to do nothing at all,
       * and the only trace was a console nobody has open.
       */
      const detail = describeError(cause);
      log.warn(`could not attach: ${detail}`);
      setErrorFor(key, `Could not attach a file. ${detail}`);
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
          runCompact();
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
      const authored = draft();
      const parsedAuthored = advancedPrompt ?? compileAdvancedPrompt(authored, props.modelOptions);
      const study = {
        authoredCharacterCount: [...authored].length,
        authoredLineCount:
          authored.length === 0 ? 0 : authored.replaceAll("\r\n", "\n").split("\n").length,
        attachmentCount: attachments().length,
        userAuthoredPs: parsedAuthored.segments.some((segment) => segment.type === "directive"),
      };
      if (props.replyQuestion) {
        await props.onSend(body, study, props.replyQuestion.id);
      } else {
        await props.onSend(body, study);
      }
      setLastSentEffort(props.effort);
      remember("");
      setAttachments([]);
      props.onCancelQuestionReply?.();
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
    resize();
    /*
     * And again once layout has settled.
     *
     * The call above runs before the field has been laid out, which is exactly
     * the case `resize` documents as reporting `scrollHeight = 0`: it then
     * writes the 22px compact floor. Nothing re-measures afterwards, because
     * the effect below only re-runs when the draft or the expanded flag
     * changes, so an untouched composer keeps that floor for the life of the
     * tab.
     *
     * The viewport wrapper takes its height from `promptHeight` and clips,
     * while the textarea keeps its own `rows` height. Measured on a fresh
     * launch: the textbox was 836x44 inside an 836x26 parent at the same
     * origin. The 18px that do not fit are painted by the caret, which blinks
     * on its own 500ms clock, so the overflow reads as a small horizontal
     * rectangle flashing near the composer with nothing logical next to it.
     */
    queueMicrotask(() => resize());
  });

  /* What the last resize actually wrote, so a keystroke that changes no
   * geometry writes nothing. Every style write marks layout stale, and the
   * `scrollHeight` read below then has to resolve the whole document before it
   * can answer: measured at 12.77ms per keystroke on a 3599-node tree, which
   * was 82% of the cost of typing a character. */
  let lastLength = -1;
  let lastHeight = -1;
  let lastCeiling = -1;

  /** Grow with the content up to a ceiling, then scroll — no jumping layout. */
  function resize(): void {
    // Expanded is a deliberate fixed workspace. Letting its measured content
    // drive height made it jump while the owner was typing.
    const modeCeiling = expanded() ? 240 : 168;
    // A retained or just-restored view can briefly report scrollHeight = 0.
    // Zero used to collapse the field completely until Expand supplied its
    // 240px floor. Keep one writable line in compact mode even while layout is
    // settling; the next input or reactive draft update measures it again.
    const floor = expanded() ? 240 : 22;
    // Keep the prompt and its controls inside short windows. The expanded
    // editor may use more room, but must never consume the whole viewport.
    const viewportCeiling = Math.max(floor, Math.floor(window.innerHeight * 0.45));
    const ceiling = Math.min(modeCeiling, viewportCeiling);
    if (ceiling !== lastCeiling) {
      field.style.maxHeight = `${ceiling}px`;
      lastCeiling = ceiling;
      // A new ceiling invalidates the shrink bookkeeping below.
      lastLength = -1;
    }
    // Resetting to `auto` is what lets the field shrink: with a fixed height
    // larger than its content, `scrollHeight` reports the box rather than the
    // text. That reset is also a style write, so it stales layout and makes the
    // measurement below resolve the entire document.
    //
    // It is only needed when the content may have got shorter. While text is
    // being added the box is never taller than the text, so `scrollHeight`
    // already answers with the true content height and the reset buys nothing.
    // Typing forward is the overwhelmingly common case and now skips it.
    const length = field.value.length;
    const mayHaveShrunk = length < lastLength || lastLength < 0;
    if (mayHaveShrunk) field.style.height = "auto";
    lastLength = length;
    const height = Math.max(floor, Math.min(field.scrollHeight || floor, ceiling));
    // Most keystrokes land inside the current line and change no height at all.
    if (height !== lastHeight) {
      field.style.height = `${height}px`;
      lastHeight = height;
    }
    setPromptHeight(height);
  }

  // `rows` is only the intrinsic fallback. Wrapped height comes from the
  // textarea's measured scrollHeight above; guessing one line per 92
  // characters made ordinary typing jump the composer at arbitrary thresholds.
  const visibleRows = createMemo(() => {
    const explicitLines = Math.max(1, draft().split("\n").length);
    const floor = expanded() ? 11 : 1;
    const modeCeiling = expanded() ? 18 : 7;
    const viewportCeiling = Math.max(floor, Math.floor((window.innerHeight * 0.45) / 22));
    return Math.max(floor, Math.min(explicitLines, modeCeiling, viewportCeiling));
  });

  /*
   * The field owns its own text while you are typing in it.
   *
   * `value={draft()}` made this fully controlled, so every keystroke went out
   * to the prefs store and came back as a fresh `value` written onto the
   * element — measured on the running app as 10 `dom:attr=` writes for 8
   * keystrokes. Assigning `value` resets the browser's native undo history,
   * which is why Cmd-Z and Ctrl-Z did nothing here: there was never more than
   * one state to go back to.
   *
   * The store is still the source of truth, and a draft that changes for a
   * reason other than typing — switching tabs, a restored session, `remember("")`
   * after a send — still lands, because those genuinely differ from what the
   * field holds. Typing does not, so the undo stack survives it.
   */
  createEffect(() => {
    const text = draft();
    if (field && field.value !== text) field.value = text;
    // Measured like a typed one: a restored long prompt has to size the field
    // the same way. The microtask lets the write above land first.
    expanded();
    queueMicrotask(() => resize());
  });

  return (
    <div class="flex flex-col gap-1.5">
      <Show when={!agentReady()}>
        <div
          role="alert"
          class="flex items-start gap-3 rounded-xl border border-error/38 bg-error/8 px-3 py-2.5"
        >
          <Icon name="shield" class="relative top-0.5 shrink-0 text-[14px] text-error" />
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-[11.5px] text-error">{tx("Agent setup required")}</p>
            <p class="mt-0.5 text-[11px] text-az-body leading-[1.45]">{agentBlockedReason()}</p>
          </div>
          <Button
            type="button"
            onClick={() => actions.openSettings()}
            class="shrink-0 rounded-lg border border-error/30 px-2.5 py-1 text-[10.5px] text-az-body hover:border-error hover:text-error"
          >
            {tx("Open Settings")}
          </Button>
        </div>
      </Show>
      {/* Cost guidance comes first so the action is read before the two figures
          it explains. */}
      <Show when={showCostAlert()}>
        {(_) => {
          const est = () => costEstimate()!;
          const table = () => state.pricing!;
          const compactUsd = () => compactionCost(table(), estimateModel(), est().contextTokens);
          const thinkingPerThousand = () => thinkingCostPerThousand(table(), estimateModel());
          return (
            <div
              class={`flex flex-col gap-1.5 rounded-xl border px-3 py-2 text-[11.5px] leading-[1.5] ${
                est().severity === "high"
                  ? "border-error/40 bg-error/8 text-error"
                  : "border-warning/40 bg-warning/8 text-warning"
              }`}
            >
              <div class="flex items-start gap-2">
                <Icon name="gauge" class="relative top-0.5 shrink-0 text-[13px]" />
                <Show
                  when={!isCompactCommand()}
                  fallback={
                    <div class="min-w-0 flex-1 text-az-body">
                      <span class="font-semibold">
                        {tx("Compacting this session is projected at {cost}.", {
                          cost: costLabel(est().total),
                        })}
                      </span>{" "}
                      {tx(
                        "It reads the whole conversation and writes a summary, including the learning pass. It runs against the session, so the drafted text is not sent.",
                      )}
                      <div class="mt-1 text-az-muted">
                        {tx(
                          "Projected retained context: about {kept} tokens from {before}, before standing rules.",
                          {
                            kept: compactedContextTokens(est().contextTokens).toLocaleString(),
                            before: est().contextTokens.toLocaleString(),
                          },
                        )}
                      </div>
                    </div>
                  }
                >
                  <div class="min-w-0 flex-1 text-az-body">
                    <span class="font-semibold">
                      {tx("This turn is projected at {cost}.", { cost: costLabel(est().total) })}
                    </span>{" "}
                    <Show when={isContextSwitch()}>
                      {estimateAgent() !== props.contextAgent
                        ? tx(
                            "Switching providers attaches the conversation to the target agent and creates a cold context charge of about {cost}.",
                            { cost: costLabel(est().contextCost) },
                          )
                        : tx(
                            "Changing models invalidates the prompt cache and creates a cold context charge of about {cost}.",
                            { cost: costLabel(est().contextCost) },
                          )}
                    </Show>
                    <Show when={isEffortSwitch()}>
                      {tx(
                        "Changing Claude effort can rebuild the long-session prompt cache. This estimate conservatively prices that context rewrite at about {cost}.",
                        { cost: costLabel(est().contextCost) },
                      )}
                    </Show>
                    <Show
                      when={
                        !isColdContext() && est().contextCost > est().inputCost + est().outputCost
                      }
                    >
                      {tx(
                        "Most of it ({cost}) is the conversation being resent every turn, not this message.",
                        { cost: costLabel(est().contextCost) },
                      )}
                    </Show>
                    <ul class="mt-1 list-disc space-y-0.5 pl-4 text-az-muted">
                      <Show when={props.extraThinking && thinkingPerThousand() !== null}>
                        <li>
                          {tx(
                            "Extra Thinking is adaptive; each additional 1K thinking tokens costs about {cost} at this model's output rate.",
                            { cost: costLabel(thinkingPerThousand()!) },
                          )}
                        </li>
                      </Show>
                      <Show when={props.onCompact && est().contextTokens > 0}>
                        <li>
                          {tx(
                            "Compact this session (~{cost} once, including the learning pass) to shrink the resent context.",
                            { cost: costLabel(compactUsd()) },
                          )}
                        </li>
                      </Show>
                      <li>
                        {tx(
                          "Or start a fresh session if the history no longer helps the next task.",
                        )}
                      </li>
                      <li>
                        {tx(
                          "Fork item-sized work into a fresh child chat to avoid resending this long conversation.",
                        )}
                      </li>
                    </ul>
                  </div>
                </Show>
                <Button
                  type="button"
                  onClick={dismissCostAlert}
                  aria-label={tx("Dismiss")}
                  class="shrink-0 rounded p-0.5 text-az-faint transition-colors hover:text-az-body"
                >
                  <Icon name="x" class="text-[12px]" />
                </Button>
              </div>
              <Show when={prefs.costWarningDismissals > 0}>
                <div class="flex justify-end">
                  <Show
                    when={confirmDisableCostWarning()}
                    fallback={
                      <Button
                        type="button"
                        onClick={() => setConfirmDisableCostWarning(true)}
                        class="text-[10.5px] text-az-muted underline decoration-current/40 underline-offset-2 hover:text-az-body"
                      >
                        {tx("Permanently disable this warning")}
                      </Button>
                    }
                  >
                    <div class="flex items-center gap-2 text-[10.5px] text-az-muted">
                      <span>{tx("Disable cost warnings permanently?")}</span>
                      <Button
                        type="button"
                        onClick={() => {
                          setPrefs("costWarningsDisabled", true);
                          setConfirmDisableCostWarning(false);
                        }}
                        class="rounded border border-error/40 px-2 py-0.5 font-medium text-error hover:bg-error/10"
                      >
                        {tx("Confirm")}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => setConfirmDisableCostWarning(false)}
                        class="text-az-muted hover:text-az-body"
                      >
                        {tx("Cancel")}
                      </Button>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          );
        }}
      </Show>
      <Show when={props.usage || costEstimate()?.priced}>
        <div class="flex min-h-[24px] items-center justify-end gap-2 px-1">
          <Show when={props.onCompact && compactPressure() && state.pricing}>
            <Button
              type="button"
              onClick={runCompact}
              aria-label={props.agent === "codex" ? tx("Freshen context") : tx("Compact context")}
              title={
                props.agent === "codex"
                  ? tx("Keep a bounded handoff, then start the next Codex turn in a fresh session.")
                  : tx("Learn what must survive, then compact this Claude session.")
              }
              class={`rounded-md border px-2.5 py-1 font-semibold text-[10.5px] transition-colors ${
                compactPressure() === "red"
                  ? "border-error/55 bg-error/15 text-error hover:bg-error/25"
                  : compactPressure() === "orange"
                    ? "border-warning/70 bg-warning/20 text-warning hover:bg-warning/30"
                    : "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
              }`}
            >
              {props.agent === "codex" ? tx("Freshen") : tx("Compact")}{" "}
              {costLabel(compactionCost(state.pricing!, estimateModel(), props.contextTokens ?? 0))}{" "}
              ›
            </Button>
          </Show>
          {/* Accent, not grey: the context fill is a number worth reading, and
              the owner asked for it coloured like the controls rather than dim
              chrome. */}
          <Show when={props.usage}>
            <span class="font-medium font-mono text-[10.5px] text-accent">{props.usage}</span>
          </Show>
          {/* The live estimate for the next turn: a projection, not a charge —
              the real cost comes back on the turn and the header shows it then.
              Coloured by severity so an expensive turn reads as expensive
              before Enter, not after. */}
          <Show when={costEstimate()?.priced}>
            {(_) => {
              const est = () => costEstimate()!;
              return (
                // A labelled chip, not a bare dim number, so the estimate is
                // findable at a glance next to the context readout. Icon +
                // "est" + the dollar figure; accent by default, warning/error
                // when the turn is projected pricey. Shown even with an empty
                // draft — the context-resend cost alone is worth seeing before
                // you type.
                <span
                  title={tx(
                    "Estimated cost of the next turn (≈{ctx}k context + prompt + reply). A projection, not a charge — the real cost is shown on the turn.",
                    { ctx: Math.round((est().contextTokens ?? 0) / 1000) },
                  )}
                  class={`flex items-center gap-1 rounded-full border px-2 py-px font-mono font-semibold text-[10.5px] ${
                    est().severity === "high"
                      ? "border-error/40 bg-error/10 text-error"
                      : est().severity === "warning"
                        ? "border-warning/40 bg-warning/10 text-warning"
                        : "border-accent/35 bg-accent/10 text-accent"
                  }`}
                >
                  <Icon name="gauge" class="text-[11px]" />
                  {tx("est {cost}", { cost: costLabel(est().total) })}
                </span>
              );
            }}
          </Show>
        </div>
      </Show>
      <div
        class={`az-ring az-ring-composer rounded-[17px] ${writing() ? "az-ring-drift" : ""} ${
          props.size === "lg" ? "az-ring-strong rounded-[19px]" : ""
        }`}
      >
        <div
          /*
            Less room under the controls than over the prompt: the text needs
            air above it, the controls only need to clear the edge. Even spacing
            made the row look adrift in the box rather than seated at its foot.
          */
          class={`flex flex-col gap-2.5 bg-az-inset ${
            props.size === "lg" ? "rounded-[18px] p-[18px] pb-2.5" : "rounded-2xl p-[15px] pb-2"
          }`}
        >
          <AttachmentPills
            paths={attachments()}
            onRemove={(path) =>
              setAttachments((current) => current.filter((existing) => existing !== path))
            }
          />
          <QuestionReplyPill
            question={props.replyQuestion}
            number={props.replyQuestionNumber}
            onRemove={props.onCancelQuestionReply}
          />
          <div
            data-prompt-viewport
            class="min-w-0 overflow-hidden"
            style={{ height: `${promptHeight()}px` }}
          >
            <Textarea
              ref={field}
              autofocus={props.autofocus}
              rows={visibleRows()}
              wrap="soft"
              placeholder={props.placeholder}
              aria-label={props.placeholder}
              onBlur={stopDrift}
              onInput={(event) => {
                remember(event.currentTarget.value);
                resize();
                keepDrifting();
              }}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline. Standard for a chat box,
                // and the reason this is a textarea rather than an input.
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                void submit();
              }}
              class={`az-scroll block max-h-full min-h-0 w-full min-w-0 resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 text-base-content leading-[1.45] shadow-none [overflow-wrap:anywhere] placeholder:text-az-faint focus:bg-transparent focus:shadow-none focus:outline-none ${
                props.size === "lg" ? "text-[15px]" : "text-[14.5px]"
              }`}
            />
          </div>

          <Show when={advanced()}>
            <div class="rounded-lg border border-az-hairline bg-base-300/45 px-3 py-2">
              <div class="mb-1 font-semibold text-[10px] text-az-faint uppercase tracking-[0.08em]">
                {tx("Prompt Syntax preview")}
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
          <div
            data-composer-controls
            /*
              The row may wrap: on a narrow window the model and effort controls
              drop below the posture controls, which is better than clipping
              them. Its height is pinned to one control so that when it does not
              wrap it cannot be taller than the buttons in it either — an
              over-tall row centres its groups and opens a band of dead space
              above and below them that reads as the composer having lost its
              alignment.
            */
            class="flex min-h-[24px] flex-wrap items-center gap-2.5"
          >
            <div data-composer-primary-controls class="flex shrink-0 items-center gap-2.5">
              <Button
                type="button"
                onClick={toggleAdvanced}
                aria-pressed={advanced()}
                title={tx("Parse Prompt Syntax controls before sending")}
                class={`flex h-[24px] items-center rounded-full border px-2.5 font-medium text-[11px] transition-colors ${
                  advanced()
                    ? "border-primary/35 bg-primary/15 text-primary"
                    : "border-az-hairline-strong text-az-muted hover:text-base-content"
                }`}
              >
                {tx("Advanced")}
              </Button>

              <PillMenu
                label={tx("Permission")}
                value={props.permission}
                options={(props.permissions ?? PERMISSION_ORDER).map((permission) => ({
                  value: permission,
                  label: permissionLabel(permission),
                  hint: permissionHint(permission),
                }))}
                onChange={props.onPermissionChange}
              />

              <Button
                type="button"
                onClick={() => void attach()}
                // Greyed on a build whose backend lacks the picker, per the house
                // convention — a button that silently does nothing is the bug this
                // replaces.
                disabled={!isLive("chooseAttachments")}
                title={tx("Attach files — their paths go into the prompt")}
                aria-label={tx("Attach files")}
                class="flex size-[24px] items-center justify-center rounded-full border border-az-hairline-strong text-az-body transition-colors hover:border-primary/30 hover:text-az-title disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name="plus" class="text-[16px]" />
              </Button>

              <Button
                type="button"
                onClick={toggleExpanded}
                aria-pressed={expanded()}
                aria-label={tx(expanded() ? "Restore the prompt size" : "Expand the prompt")}
                title={tx(expanded() ? "Restore the prompt size" : "Expand the prompt")}
                class={`flex size-[24px] items-center justify-center rounded-full border transition-colors ${
                  expanded()
                    ? "border-primary/35 bg-primary/15 text-primary"
                    : "border-az-hairline-strong text-az-body hover:border-primary/30 hover:text-az-title"
                }`}
              >
                <Icon name={expanded() ? "chevron-down" : "chevron-up"} class="text-[15px]" />
              </Button>
            </div>

            <div
              data-composer-secondary-controls
              /*
                One line, always, and no `min-w-0`.
                
                These controls still need to drop below the posture controls on
                a narrow window at the largest interface size, but that break
                belongs to the parent row, which moves this group down whole.
                Breaking *inside* the group is what went wrong: it left the
                model and effort pills on one line and the send button on the
                next, so the group stood two rows tall, the posture controls
                beside it centred against that height and sat visibly lower,
                and a band of dead space opened underneath. Reproduced at the
                XL interface size at every width the composer actually gets.

                `min-w-0` is what let it happen. With it the group may shrink
                below its contents, so the parent keeps it on the first line
                and it wraps within itself; without it the parent sees its true
                width and breaks the line instead.
              */
              class="ml-auto flex max-w-full shrink-0 flex-nowrap items-center justify-end gap-2.5"
            >
              {/*
            Extra Thinking, next to the model it qualifies. Only Claude has a
            lever, so for any other agent the control is disabled rather than
            gone: hiding it would make the row jump as you switch models and
            leave no hint the option exists. Off sends `thinking(false)`, which
            the backend maps to Claude's disable switch.
          */}
              <Button
                type="button"
                onClick={() => props.onExtraThinkingChange?.(!props.extraThinking)}
                disabled={props.agent !== "claude"}
                aria-pressed={props.agent === "claude" && props.extraThinking}
                title={
                  props.agent === "claude"
                    ? tx(
                        "Extra Thinking: let the model reason before it answers. Off disables thinking for this tab's runs.",
                      )
                    : tx("Extra Thinking applies to Claude only.")
                }
                class={`flex h-[24px] items-center gap-1.5 rounded-full border px-2.5 font-medium text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  props.agent === "claude" && props.extraThinking
                    ? "border-primary/35 bg-primary/15 text-primary"
                    : "border-az-hairline-strong text-az-muted hover:text-base-content"
                }`}
              >
                <Icon name="sparkles" class="text-[11px]" />
                {tx("Extra Thinking")}
              </Button>

              <PillMenu
                label={tx("Model")}
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
                  label={tx("Effort")}
                  variant="outline"
                  value={props.effort}
                  options={props.efforts.map((effort) => ({ value: effort, label: effort }))}
                  onChange={(effort) => props.onEffortChange?.(effort)}
                />
              </Show>

              {/*
                Send and its reserved Stop slot are one flex item, not two.
                Stop is `invisible` while idle but still occupies space, so as
                a separate item it could be the only thing on a wrapped line —
                a line with nothing visible on it, which is what made the two
                halves of this row fall out of alignment with an empty band
                between them. Together they always carry the send button.
              */}
              <div class="flex shrink-0 items-center gap-2.5">
                {/* While a run is live, the provider capability decides whether
                this interrupts the open turn or queues for the next one. */}
                <Button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!canSend()}
                  aria-label={
                    props.isRunning
                      ? props.canFollowUp
                        ? tx("Send into the running turn")
                        : tx("Queue after the running turn")
                      : tx("Send")
                  }
                  title={
                    !agentReady()
                      ? agentBlockedReason()
                      : props.isRunning
                        ? props.canFollowUp
                          ? tx(
                              "Delivered into the running turn; the agent takes it at its next step",
                            )
                          : tx("Queued until the running turn finishes")
                        : undefined
                  }
                  class="flex size-[24px] items-center justify-center rounded-full bg-primary text-primary-content transition-colors hover:bg-az-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon name="arrow-up" class="text-[17px]" />
                </Button>
                {/*
                Always rendered, only hidden when idle: mounting the Stop button
                on run-start (and unmounting on stop) reflowed this wrap row and
                slid the send button left-right every turn. Reserving its slot
                keeps the send button fixed; `invisible` also drops it from the
                tab order so an idle composer has no dead control.
              */}
                <Button
                  type="button"
                  onClick={() => props.onStop?.()}
                  // No handler means the backend cannot stop this run; a Stop
                  // that only pretended would be worse than a disabled one.
                  disabled={!props.onStop}
                  aria-label={tx("Stop the run")}
                  tabindex={props.isRunning ? undefined : -1}
                  class={`flex size-[24px] items-center justify-center rounded-full border border-primary/40 bg-base-300 transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-40 ${
                    props.isRunning ? "" : "invisible"
                  }`}
                >
                  <span class="size-[11px] rounded-[3px] bg-primary" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
