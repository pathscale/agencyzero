import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { EditableTitle } from "~/components/EditableTitle";
import { Icon } from "~/components/Icon";
import { Panel } from "~/components/Panel";
import { Composer } from "~/features/project/Composer";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { TranscriptPane } from "~/features/project/TranscriptPane";
import { clockTime } from "~/lib/format";
import { AGENT_LABELS } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { compactCount, contextUsed, costLabel, usageTotals, withLiveContext } from "~/lib/stats";
import { QUEUE_REASONS, useWorkspace } from "~/stores/workspace";
import type { Project, PullRequest, Tab } from "~/types";

/**
 * A project tab: the conversation on the left, the accordion on the right.
 *
 * The header carries whatever is true of the whole tab right now — a rate
 * limit, in the provider's own wording — so it is visible without reading back
 * through the transcript.
 */
/** A real, finite count — an absent field is `undefined`, which is not null. */
function isCount(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function ProjectTab(props: { tab: Tab; project: Project }): JSX.Element {
  const { state, actions, promptModels, effortsFor, isLive } = useWorkspace();

  const messages = () => state.messages[props.project.id] ?? [];

  /*
   * The agent that actually ran, not a hardcoded name: the last message that
   * recorded one, falling back to the configured default. Settings can select
   * Codex or Copilot, and a header that always said "Claude" would be lying.
   */
  const agent = () =>
    [...messages()].reverse().find((message) => message.author === "agent")?.agent ??
    state.settings?.defaultAgent ??
    "claude";
  const running = () => state.running[props.project.id] ?? [];
  /*
   * Only shown when something was actually refused. The provider emits a record
   * on healthy runs too, with status `allowed`, and rendering that as an orange
   * warning told you a run was limited when it was not.
   */
  const rateLimit = () => {
    const limit = state.rateLimits[props.project.id];
    return limit?.isBlocking ? limit : undefined;
  };

  /**
   * The composer's usage line: this project's running total.
   *
   * A running total, not the last turn — that is the question being asked at the
   * bottom of a conversation. Additive fields add and context-shaped fields take
   * the latest, per `usageTotals`, because the agent re-sends the whole
   * conversation each turn and summing that counts it once per turn.
   *
   * Every figure is the agent's own. **Nothing here computes a cost**: `costUsd`
   * is what the agent charged for its own turns, and an absent one renders as an
   * em dash rather than as zero.
   */
  const totals = createMemo(() => usageTotals(messages()));

  /** Why the cost reads as it does, for the hover on the header figure. */
  const costTitle = () => {
    const it = totals();
    const partial =
      it.reported < it.turns ? ` ${it.turns - it.reported} turn(s) reported no usage.` : "";
    return `${compactCount(it.tokens)} tokens processed across ${it.turns} turn(s), cache reads included.${partial} Each turn is priced by the agent itself at API list rates — on a subscription plan this measures consumption, not a bill. Nothing here computes a cost.`;
  };

  /**
   * How much of the context window this conversation is using.
   *
   * Only Claude reports a window, so this is absent rather than estimated for
   * the others — `Usage::context_used` returns nothing without both numbers, and
   * a context bar drawn from a guess is exactly the figure someone would act on.
   */
  // The session's history, with the context figures live from the turn in
  // flight — see `withLiveContext`.
  const standing = createMemo(() => withLiveContext(totals(), state.runStatus[props.project.id]));
  const context = createMemo(() => contextUsed(standing()));

  /**
   * What the composer shows where the usage line used to be.
   *
   * The context is the number that matters while you are typing: it says how
   * much room is left for what you are about to say. Cost and turns are history
   * and moved to the header.
   */
  const contextLabel = createMemo(() => {
    const share = context();
    const it = standing();
    if (share === null) {
      // No window reported, so no share can be shown — but the tokens are real.
      return isCount(it.contextTokens) ? `${compactCount(it.contextTokens)} ctx` : "—";
    }
    return `${compactCount(it.contextTokens ?? 0)} / ${compactCount(it.contextWindow ?? 0)} ctx · ${Math.round(share * 100)}%`;
  });

  return (
    <div class="flex min-h-0 min-w-0 flex-1 gap-3">
      <Panel class="relative flex min-w-0 flex-1 flex-col">
        <header class="flex flex-none items-center gap-3 border-az-hairline-soft border-b px-4 py-3">
          <Icon name="messages-square" class="text-[16px] text-az-muted" />
          {/*
            The name owns the row and truncates on its own. Everything after it
            is `shrink-0` and sits to the right of a spacer, so no label can push
            the name around or take width from it.
          */}
          <EditableTitle
            value={props.project.name}
            onRename={(name) => actions.renameProject(props.project.id, name)}
            label="Rename project"
            class="min-w-0 flex-1 font-semibold text-[14.5px] text-az-title"
            inputClass="font-semibold text-[14.5px]"
          />
          {/*
            Turns and cost live here rather than under the prompt. They describe
            the conversation as a whole, which is what this label already names,
            and moving them up leaves the composer row for the controls that act
            on the next message.
          */}
          <span class="flex shrink-0 items-center gap-2 rounded-full border border-az-hairline bg-base-300 px-2.5 py-0.5 font-mono text-[11px] text-az-muted">
            conversation · {AGENT_LABELS[agent()]}
            <Show when={totals().turns > 0}>
              <span class="text-az-faint">·</span>
              <span>
                {totals().turns} turn{totals().turns === 1 ? "" : "s"}
              </span>
              <span class="text-az-faint">·</span>
              {/* The session's summed consumption — where the tokens went. The
                  context readout under the composer answers a different
                  question (how full the window is), so both exist. */}
              <span title={costTitle()}>{compactCount(totals().tokens)} tok</span>
              <span class="text-az-faint">·</span>
              <span title={costTitle()}>{costLabel(totals().costUsd)}</span>
              <Show when={totals().reported < totals().turns}>
                <span class="text-az-faint" title="Some turns reported no usage">
                  (partial)
                </span>
              </Show>
            </Show>
          </span>

          <SessionChip sessionId={props.project.sessionId} />

          <Show when={rateLimit()}>
            {(limit) => (
              <div class="mr-1.5 flex items-center gap-[7px] rounded-full border border-warning/34 bg-warning/15 px-2.5 py-1 text-[11.5px]">
                <Icon name="pause" class="text-[12px] text-warning" />
                <span class="font-semibold text-warning">{limit().message}</span>
                <Show when={clockTime(limit().resetsAt)}>
                  {(at) => <span class="text-az-body">· resets {at()}</span>}
                </Show>
              </div>
            )}
          </Show>
        </header>

        <TranscriptPane
          project={props.project}
          messages={messages()}
          streaming={state.streaming[props.project.id] ?? ""}
        />

        <div class="flex flex-none flex-col gap-2.5 px-4 pt-2 pb-4">
          {/* PRs this project's runs have cut, tracked like Claude Desktop's
              chips: state, diff stats, CI — with a way to wave each away. */}
          <Show when={(state.pullRequests[props.project.id] ?? []).some((pr) => !pr.dismissed)}>
            <div class="flex flex-col gap-1">
              <For
                each={(state.pullRequests[props.project.id] ?? []).filter((pr) => !pr.dismissed)}
              >
                {(pr) => <PrChip pr={pr} />}
              </For>
            </div>
          </Show>
          {/* Prompts waiting their turn, each with its way out. Above the
              composer so the words are visibly held, not vanished. */}
          <Show when={(state.queued[props.project.id] ?? []).length > 0}>
            <div class="flex flex-col gap-1">
              <For each={state.queued[props.project.id]}>
                {(prompt, index) => (
                  <div class="flex items-center gap-2 rounded-[11px] border border-primary/14 border-dashed bg-az-inset px-3 py-1.5 text-[12px]">
                    <Icon name="history" class="shrink-0 text-[12px] text-az-faint" />
                    <span class="min-w-0 flex-1 truncate text-az-body">{prompt.body}</span>
                    {/* Why, not just that. A wait with no stated cause reads as
                        the message having been swallowed. */}
                    <span class="shrink-0 text-[10.5px] text-az-faint">
                      {QUEUE_REASONS[prompt.reason]}
                    </span>
                    <button
                      type="button"
                      onClick={() => actions.removeQueued(props.project.id, index())}
                      aria-label="Drop this queued message"
                      class="shrink-0 text-az-faint transition-colors hover:text-error"
                    >
                      <Icon name="x" class="text-[12px]" />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Composer
            draftKey={props.tab.key}
            onCompact={() => actions.compactProject(props.project.id)}
            available={state.commands[props.project.id]}
            autofocus
            placeholder="Ask, or type / for commands…"
            model={props.tab.model}
            modelOptions={promptModels()}
            efforts={effortsFor(props.tab.model)}
            effort={props.tab.effort}
            /*
             * This was missing entirely: the effort menu rendered and called
             * an optional handler nobody passed, so picking "low" changed
             * nothing. The bug read as "low cannot be selected".
             */
            onEffortChange={(effort) =>
              actions.setTabModel(props.tab.key, props.tab.model, props.tab.permission, effort)
            }
            permission={props.tab.permission}
            usage={contextLabel()}
            /*
             * The full turn, not just its visible parts: `runStatus` exists
             * from the accepted send to `run:stopped`, covering the quiet
             * stretches where no tool row and no text would otherwise read
             * as idle. The older signals stay as belt for replayed state.
             */
            isRunning={
              props.project.id in state.runStatus ||
              running().length > 0 ||
              (state.streaming[props.project.id] ?? "") !== ""
            }
            /*
             * Only offered when the backend can actually stop the run. An
             * ungated Stop routed to the mock, which emitted `run:stopped`
             * while the real agent kept working — the worst kind of button.
             */
            onStop={
              isLive("cancelRun")
                ? () =>
                    void actions.cancelRun(props.project.id).catch((cause) => {
                      log.warn(`stop: ${describeError(cause)}`);
                    })
                : undefined
            }
            onModelChange={(model) =>
              actions.setTabModel(props.tab.key, model, props.tab.permission)
            }
            onPermissionChange={(permission) =>
              actions.setTabModel(props.tab.key, props.tab.model, permission)
            }
            onSend={(body) => actions.send(props.project.id, body)}
          />
        </div>
      </Panel>

      <ProjectPanel project={props.project} />
    </div>
  );
}

/**
 * One tracked pull request, in the shape of Claude Desktop's chip.
 *
 * Open: PR icon, number, repo and branch, then +adds −dels and the CI word.
 * Merged goes purple and says so; closed dims. The body click copies the URL —
 * the webview has no external-browser bridge yet, and a copied URL pastes
 * anywhere. × dismisses the chip; the row stays in the store.
 */
function PrChip(props: { pr: PullRequest }): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [copied, setCopied] = createSignal(false);
  const merged = () => props.pr.state === "MERGED";
  const closed = () => props.pr.state === "CLOSED";

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.pr.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_400);
    } catch (cause) {
      log.warn(`could not copy the PR URL: ${describeError(cause)}`);
    }
  };

  const CI_TONE: Record<string, string> = {
    pass: "bg-success/15 text-success",
    fail: "bg-error/15 text-error",
    pending: "bg-warning/15 text-warning",
  };

  return (
    <div
      class={`flex items-center gap-2.5 rounded-[11px] border px-3 py-2 text-[12px] ${
        merged()
          ? "border-az-pr/40 bg-az-pr/12"
          : closed()
            ? "border-az-hairline bg-base-300 opacity-70"
            : "border-az-hairline-strong bg-az-inset"
      }`}
    >
      <Icon
        name={merged() ? "git-merge" : "git-pull-request"}
        class={`shrink-0 text-[14px] ${merged() ? "text-az-pr-strong" : closed() ? "text-az-muted" : "text-success"}`}
      />
      {/*
       * The row opens the PR. Copying it was the only thing a click did, which
       * made the commonest action — go look at it — a two-step through the
       * clipboard and a browser address bar.
       */}
      <button
        type="button"
        onClick={() =>
          void actions
            .openExternal(props.pr.url)
            .catch((cause) => log.warn(`could not open the PR: ${describeError(cause)}`))
        }
        title={`Open ${props.pr.url}`}
        class="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span class={`shrink-0 font-semibold ${merged() ? "text-az-pr-strong" : "text-az-strong"}`}>
          #{props.pr.number}
        </span>
        <span class="shrink-0 text-az-muted">{props.pr.repo}</span>
        <Show when={props.pr.branch}>
          <span class="min-w-0 truncate font-mono text-[11px] text-az-body">{props.pr.branch}</span>
        </Show>
        <Show when={copied()}>
          <span class="shrink-0 text-[10.5px] text-success">copied</span>
        </Show>
      </button>
      <Show
        when={merged()}
        fallback={
          <>
            <Show when={props.pr.additions + props.pr.deletions > 0}>
              <span class="shrink-0 font-mono text-[11px]">
                <span class="text-success">+{props.pr.additions}</span>{" "}
                <span class="text-error">−{props.pr.deletions}</span>
              </span>
            </Show>
            <Show when={props.pr.ci !== "unknown" && props.pr.ci !== "none"}>
              <button
                type="button"
                onClick={() =>
                  isLive("refreshPullRequest") && actions.refreshPullRequest(props.pr.id)
                }
                title="CI rollup — click to re-check"
                class={`shrink-0 rounded-md px-[7px] py-px font-semibold text-[10.5px] ${CI_TONE[props.pr.ci] ?? "bg-base-300 text-az-muted"}`}
              >
                CI {props.pr.ci}
              </button>
            </Show>
            <Show when={closed()}>
              <span class="shrink-0 font-semibold text-[11px] text-az-muted">Closed</span>
            </Show>
          </>
        }
      >
        <span class="shrink-0 font-semibold text-[11.5px] text-az-pr-strong">Merged</span>
      </Show>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy the link to PR ${props.pr.number}`}
        title={copied() ? "Copied" : "Copy the link"}
        class="shrink-0 rounded-md p-1 text-az-faint transition-colors hover:text-az-body"
      >
        <Icon name={copied() ? "check" : "copy"} class="text-[12px]" />
      </button>
      <button
        type="button"
        onClick={() => void actions.dismissPullRequest(props.pr.id)}
        aria-label={`Dismiss PR ${props.pr.number}`}
        class="shrink-0 text-az-faint transition-colors hover:text-base-content"
      >
        <Icon name="x" class="text-[13px]" />
      </button>
    </div>
  );
}

/**
 * The agent's own session id, with a copy button.
 *
 * Same dim treatment as the "conversation · Claude" chip beside it, because it
 * is the same kind of fact: what this tab *is*, rather than what it is doing.
 *
 * Shown truncated — a session id is a uuid and the header has a project name to
 * fit — but the whole thing is what gets copied, and the title carries it in
 * full for a hover. Absent until the first run: `Event::Started` is what names
 * it, so a project that has never run has nothing honest to show.
 */
function SessionChip(props: { sessionId: string | null }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  let revert: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(revert));

  const copy = async (id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      clearTimeout(revert);
      revert = setTimeout(() => setCopied(false), 1_400);
    } catch (cause) {
      // Clipboard access can be refused. Saying nothing would leave the button
      // looking like it worked.
      log.warn(`could not copy the session id: ${describeError(cause)}`);
    }
  };

  /*
   * Deliberately not a pill. The header already carries one, and a second
   * bordered chip competed with the project name for attention when it is only
   * ever a reference you copy. Dim mono text, no border, and it never grows:
   * eight characters plus a copy button, with the whole id on hover.
   */
  return (
    <Show
      when={props.sessionId}
      fallback={
        <span class="shrink-0 font-mono text-[10.5px] text-az-faint">session · none yet</span>
      }
    >
      {(id) => (
        <span
          title={id()}
          class="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-az-faint"
        >
          <span class="text-az-faint">session ·</span>
          {id().slice(0, 8)}
          <button
            type="button"
            onClick={() => void copy(id())}
            aria-label="Copy session id"
            class="flex size-[18px] items-center justify-center rounded transition-colors hover:bg-white/8 hover:text-az-body"
          >
            <Icon name={copied() ? "check" : "copy"} class="text-[10px]" />
          </button>
        </span>
      )}
    </Show>
  );
}
