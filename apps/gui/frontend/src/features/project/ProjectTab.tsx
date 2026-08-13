import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Button } from "~/components/Button";
import { EditableTitle } from "~/components/EditableTitle";
import { Icon } from "~/components/Icon";
import { Panel } from "~/components/Panel";
import { Composer } from "~/features/project/Composer";
import { copyText } from "~/features/project/MessageBody";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { noteTranscriptChromeChanged, TranscriptPane } from "~/features/project/TranscriptPane";
import { providerUsageLabel } from "~/features/shell/UsageReadout";
import { AGENT_LABELS } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
import { turnCostTotals } from "~/lib/pricing";
import {
  cacheBreak,
  compactCount,
  contextUsed,
  costLabel,
  usageTotals,
  withLiveContext,
} from "~/lib/stats";
import { tx } from "~/stores/i18n";
import { prefs, setPrefs } from "~/stores/prefs";
import { QUEUE_REASONS, reviewRunKey, useWorkspace } from "~/stores/workspace";
import type { Agent, Project, PullRequest, Tab } from "~/types";

/**
 * A project tab: the conversation on the left, the accordion on the right.
 *
 * The header carries the tab's active model, usage, and native session.
 */
/** A real, finite count — an absent field is `undefined`, which is not null. */
function isCount(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function ProjectTab(props: { tab: Tab; project: Project }): JSX.Element {
  const { state, actions, promptModels, effortsFor, permissionsFor, capabilitiesFor, isLive } =
    useWorkspace();
  /*
   * The footer's height, as a value rather than as a measurement.
   *
   * Each of these decides whether a strip appears below the transcript, and
   * every one of them shortens the scroller when it does. A pinned transcript
   * has to follow the tail down or the newest message ends up cut off under the
   * chrome, which is what "dialogs are not pushing the chat up" looks like.
   *
   * A `ResizeObserver` on the scroller is the natural way to notice, and
   * `TranscriptPane` asks for one, but the engine implements neither
   * `ResizeObserver` nor `MutationObserver` and both calls sit behind
   * `typeof … !== "undefined"`, so they have been dead and silent. Reading the
   * same state the footer renders from is exact, and it cannot go stale the way
   * a hand-maintained pixel offset would.
   */
  createEffect(() => {
    const id = props.project.id;
    void (state.pullRequests[id] ?? []).filter((pr) => !pr.dismissed).length;
    void state.pendingCompact[id];
    void (state.queued[id] ?? []).length;
    void state.streaming[id];
    noteTranscriptChromeChanged();
  });

  const forkInfo = createMemo(() => {
    const link = props.project.forkedFrom;
    if (!link?.itemId) return null;
    const parent = state.projects.find((project) => project.id === link.projectId);
    const item = (state.items[link.projectId] ?? []).find(
      (candidate) => candidate.id === link.itemId,
    );
    return { parent, item, parentId: link.projectId, itemId: link.itemId };
  });

  const hydratedMessages = () => state.messages[props.project.id];
  const messages = () => hydratedMessages() ?? [];
  const replyQuestion = createMemo(() => {
    const selected = prefs.replyQuestionIds[props.project.id];
    if (!selected) return undefined;
    return (state.questions[props.project.id] ?? []).find((question) => question.id === selected);
  });
  const replyQuestionNumber = createMemo(() => {
    const selected = replyQuestion();
    if (!selected) return undefined;
    const ordered = [...(state.questions[props.project.id] ?? [])].sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    );
    const index = ordered.findIndex((question) => question.id === selected.id);
    return index >= 0 ? index + 1 : undefined;
  });
  const contextOwner = createMemo(() =>
    [...messages()]
      .reverse()
      .find(
        (message) =>
          (message.author === "agent" || message.author === "user") && message.model.length > 0,
      ),
  );

  const running = () => state.running[props.project.id] ?? [];
  const canFollowUp = () => {
    const runningAgent = state.runStatus[props.project.id]?.agent;
    const agent = runningAgent ?? props.tab.agent;
    return (
      (runningAgent === undefined || runningAgent === props.tab.agent) &&
      (capabilitiesFor(agent)?.liveFollowUp ?? false)
    );
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
  // Per tab, not per project: a tab is one agent's conversation on this
  // project, so the header cost and token count are that agent's own turns,
  // filtered by the message's agent. A project run with both Claude and Codex
  // used to pool their spend into one figure, which is exactly the fine-grained
  // number this hid. The whole-project total is still available in Analytics.
  const tabMessages = createMemo(() =>
    messages().filter((message) => message.author !== "agent" || message.agent === props.tab.agent),
  );
  const totals = createMemo(() => usageTotals(tabMessages()));
  const costs = createMemo(() => turnCostTotals(state.pricing, tabMessages()));
  const conversationTotals = createMemo(() => usageTotals(messages()));
  const likelyCacheBreak = createMemo(() => cacheBreak(tabMessages()));

  /*
   * The provider usage chip, restored and now behind the experimental profile.
   *
   * It was dropped by a commit meant to remove a *duplicate* usage warning
   * chip, which took the real readout with it, so the countdown quietly stopped
   * existing after 0.5.2. Gated on `claudeUsage` because that capability is
   * only advertised by the experimental build, which makes it the same switch
   * the Settings readout already uses rather than a second notion of what
   * "experimental" means.
   */
  const [usageNow, setUsageNow] = createSignal(Date.now());
  // A minute is finer than the readout, which is stated in hours and days.
  const usageTicker = setInterval(() => setUsageNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(usageTicker));

  /** Warm the readout as it fills: above 90% is error, above 70% warning. */
  const severityFor = (percent: number | null): "low" | "mid" | "high" => {
    if (percent === null) return "low";
    if (percent >= 90) return "high";
    if (percent >= 70) return "mid";
    return "low";
  };

  /** The active tab's provider only, beside the turn count it constrains. */
  const providerUsage = createMemo<{
    label: string;
    title: string;
    severity: "low" | "mid" | "high";
  } | null>(() => {
    if (!isLive("claudeUsage")) return null;

    if (props.tab.agent === "claude") {
      const window = state.claudeUsage?.sevenDay;
      if (!window) return null;
      const percent = Math.min(100, Math.max(0, window.utilization));
      return {
        label: providerUsageLabel("Claude", percent, window.resetsAt, usageNow()),
        title: window.resetsAt ?? "",
        severity: severityFor(percent),
      };
    }

    const windows = state.quota?.agents.find((entry) => entry.agent === "codex")?.windows ?? [];
    const window = windows.reduce<(typeof windows)[number] | null>(
      (longest, candidate) =>
        (candidate.windowMinutes ?? 0) > (longest?.windowMinutes ?? 0) ? candidate : longest,
      null,
    );
    if (!window) return null;
    const reported =
      window.usedFraction !== null && Number.isFinite(window.usedFraction)
        ? Math.round(Math.min(1, Math.max(0, window.usedFraction)) * 100)
        : null;
    return {
      label: providerUsageLabel("Codex", reported, window.resetsAt, usageNow()),
      title: window.resetsAt ?? "",
      severity: severityFor(reported),
    };
  });
  // Boot provides a cheap project turn count before the full transcript is
  // hydrated. Use it to reserve the totals chip immediately; otherwise every
  // tab switch briefly removes the chip and adds it back after listMessages.
  const headerTurns = () =>
    hydratedMessages() === undefined ? (state.turnCounts[props.project.id] ?? 0) : totals().turns;

  /** Why the cost reads as it does, for the hover on the header figure. */
  const costTitle = () => {
    const it = totals();
    const partial =
      it.reported < it.turns ? ` ${it.turns - it.reported} turn(s) reported no usage.` : "";
    const estimate = costs().estimated
      ? " Codex turns are estimated from their exact input, output, and cache split."
      : "";
    return `${compactCount(it.tokens)} tokens processed across ${it.turns} turn(s), cache reads included.${partial}${estimate} On a subscription plan this measures consumption, not a bill.`;
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
    <div class="flex min-h-0 min-w-0 flex-1">
      <div class="relative flex min-h-0 min-w-0 flex-1">
        <Panel class="relative flex min-w-0 flex-1 flex-col">
          <header class="relative flex flex-none items-center gap-3 border-az-hairline-soft border-b px-4 py-3">
            <Icon name="messages-square" class="text-[16px] text-az-muted" />
            {/*
            The name owns the row and truncates on its own. Everything after it
            is `shrink-0` and sits to the right of a spacer, so no label can push
            the name around or take width from it.
          */}
            <Show
              when={forkInfo()}
              fallback={
                <EditableTitle
                  value={props.project.name}
                  onRename={(name) => actions.renameProject(props.project.id, name)}
                  label={tx("Rename project")}
                  class="min-w-0 flex-1 font-semibold text-[14.5px] text-az-title"
                  inputClass="font-semibold text-[14.5px]"
                />
              }
            >
              {(fork) => (
                <div class="flex min-w-0 flex-1 items-center gap-2">
                  <span class="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-semibold text-[10.5px] text-primary uppercase tracking-wide">
                    {tx("Fork")}
                  </span>
                  <Button
                    type="button"
                    onClick={() => {
                      if (!actions.revealItem(fork().itemId)) actions.openProject(fork().parentId);
                    }}
                    title={tx("Return to the parent item")}
                    class="inline-flex min-w-0 items-center gap-1.5 font-semibold text-[14.5px] text-primary transition-colors hover:text-primary/80"
                  >
                    <span class="truncate">
                      {fork().parent?.name ?? tx("Parent project")} ·{" "}
                      {fork().item?.title ?? props.project.name}
                    </span>
                    <Icon name="arrow-up" class="shrink-0 -rotate-90 text-[12px]" />
                  </Button>
                </div>
              )}
            </Show>
            {/*
            Conversation totals float at the chat's top-right. Absolute
            positioning keeps the title row available to the project name while
            leaving next-turn controls in the composer.
            */}
            <span
              data-turn-totals
              aria-hidden={headerTurns() <= 0}
              class={`absolute top-full right-3 z-20 flex w-[270px] max-w-[calc(100%-1.5rem)] items-center gap-1.5 overflow-hidden rounded-b-lg border border-primary/38 border-t-0 bg-base-200 px-3 py-1 font-mono text-[11px] text-az-muted shadow-[0_7px_18px_rgba(0,0,0,0.38)] ${headerTurns() <= 0 ? "invisible" : ""}`}
            >
              {/* No leading agent label: the 7-day readout at the end already says
                "Claude 7d …", so a "Claude ·" prefix here was the same word
                twice. The turn count leads instead. */}
              <span class="w-[58px] shrink-0 font-semibold text-az-body">
                {tx("Turn")} {headerTurns()}
              </span>
              <span class="text-az-faint">·</span>
              {/* The session's summed consumption — where the tokens went. The
                  context readout under the composer answers a different
                  question (how full the window is), so both exist. Coloured
                  accent, not flat grey: these are the numbers worth reading. */}
              <span
                title={costTitle()}
                class="w-[82px] shrink-0 text-right font-semibold text-accent"
              >
                {hydratedMessages() === undefined ? "—" : compactCount(totals().tokens)} {tx("tok")}
              </span>
              <span class="text-az-faint">·</span>
              {/* A leading ~ marks a partial total (some turns reported no
                  usage) without stealing a whole word from a tight header — the
                  hover still explains it. */}
              <span
                title={
                  totals().reported < totals().turns
                    ? tx("Some turns reported no usage")
                    : costTitle()
                }
                class="w-[62px] shrink-0 text-right font-semibold text-accent"
              >
                <Show when={hydratedMessages() !== undefined} fallback="—">
                  {costs().missing > 0 || costs().estimated ? "~" : ""}
                  {costLabel(costs().usd)}
                </Show>
              </span>
            </span>

            <Show when={providerUsage()}>
              {(usage) => (
                <span
                  class={`min-w-0 max-w-[300px] shrink truncate rounded-md border px-2.5 py-1 font-mono font-semibold text-[10.5px] ${
                    usage().severity === "high"
                      ? "border-error/32 bg-error/10 text-error"
                      : usage().severity === "mid"
                        ? "border-warning/32 bg-warning/10 text-warning"
                        : "border-primary/20 bg-az-inset text-az-body"
                  }`}
                  title={usage().title}
                >
                  {usage().label}
                </span>
              )}
            </Show>

            <Show when={likelyCacheBreak()}>
              <span
                title={tx(
                  "The latest comparable turn reported zero cache reads after a substantial cached turn. This can increase usage, but the provider does not expose the cause.",
                )}
                class="shrink-0 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-0.5 text-[11px] text-warning"
              >
                {tx("cache miss?")}
              </span>
            </Show>

            <SessionChip
              sessionId={
                props.tab.agent === "claude"
                  ? (props.project.sessions.claude ?? props.project.sessionId)
                  : (props.project.sessions[props.tab.agent] ?? null)
              }
            />
          </header>

          <TranscriptPane
            project={props.project}
            messages={messages()}
            streaming={state.streaming[props.project.id] ?? ""}
          />

          {/*
            Everything below the transcript that can appear and disappear. Each
            one shortens the scroller, and a pinned transcript has to follow the
            tail down or the newest message is left cut off under this chrome.
            The engine has no `ResizeObserver` to notice for us, so the chrome
            says so itself.
          */}
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
            {/* A compaction held until the run ends. Same strip and same way
              out as a queued prompt, because it is the same promise: the click
              was taken and is waiting, not refused. */}
            <Show when={state.pendingCompact[props.project.id] !== undefined}>
              <div class="flex items-center gap-2 rounded-[11px] border border-primary/14 border-dashed bg-az-inset px-3 py-1.5 text-[12px]">
                <Icon name="history" class="shrink-0 text-[12px] text-az-faint" />
                <span class="min-w-0 flex-1 truncate text-az-body">{tx("Compact")}</span>
                <span class="shrink-0 text-[10.5px] text-az-faint">{QUEUE_REASONS.busy}</span>
                <Button
                  type="button"
                  onClick={() => actions.dropPendingCompact(props.project.id)}
                  aria-label={tx("Drop this queued compaction")}
                  class="shrink-0 text-az-faint transition-colors hover:text-error"
                >
                  <Icon name="x" class="text-[12px]" />
                </Button>
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
                      <Button
                        type="button"
                        onClick={() => actions.removeQueued(props.project.id, index())}
                        aria-label={tx("Drop this queued message")}
                        class="shrink-0 text-az-faint transition-colors hover:text-error"
                      >
                        <Icon name="x" class="text-[12px]" />
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Composer
              draftKey={props.tab.key}
              onChromeChange={noteTranscriptChromeChanged}
              onCompact={
                props.tab.agent === "codex" || capabilitiesFor(props.tab.agent)?.commands
                  ? () => actions.compactProject(props.project.id, props.tab.agent)
                  : undefined
              }
              available={state.commands[props.project.id]?.[props.tab.agent]}
              autofocus
              placeholder={tx("Ask, or type / for commands…")}
              agent={props.tab.agent}
              model={props.tab.model}
              modelOptions={promptModels()}
              efforts={effortsFor(props.tab.agent, props.tab.model)}
              effort={props.tab.effort}
              /*
               * This was missing entirely: the effort menu rendered and called
               * an optional handler nobody passed, so picking "low" changed
               * nothing. The bug read as "low cannot be selected".
               */
              onEffortChange={(effort) =>
                actions.setTabModel(
                  props.tab.key,
                  props.tab.agent,
                  props.tab.model,
                  props.tab.permission,
                  effort,
                )
              }
              extraThinking={props.tab.extraThinking}
              onExtraThinkingChange={(enabled) =>
                actions.setTabExtraThinking(props.tab.key, enabled)
              }
              permission={props.tab.permission}
              permissions={permissionsFor(props.tab.agent)}
              usage={contextLabel()}
              /* The warm context the next turn will resend, so the composer can
               price it live as you type. From the tab's running totals. */
              contextTokens={
                !props.project.sessions[props.tab.agent]
                  ? 0
                  : contextOwner()?.agent !== props.tab.agent
                    ? (conversationTotals().contextTokens ?? 0)
                    : (standing().contextTokens ?? 0)
              }
              contextWindow={standing().contextWindow ?? undefined}
              contextAgent={contextOwner()?.agent as Agent | undefined}
              contextModel={contextOwner()?.model}
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
              canFollowUp={canFollowUp()}
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
              onModelChange={(agent, model) =>
                actions.setTabModel(props.tab.key, agent, model, props.tab.permission)
              }
              onPermissionChange={(permission) =>
                actions.setTabModel(props.tab.key, props.tab.agent, props.tab.model, permission)
              }
              replyQuestion={replyQuestion()}
              replyQuestionNumber={replyQuestionNumber()}
              onCancelQuestionReply={() => actions.clearQuestionReply(props.project.id)}
              onSend={(body, study, replyQuestionId) =>
                actions.send(props.project.id, body, study, replyQuestionId)
              }
            />
          </div>
        </Panel>

        <Show when={!forkInfo()}>
          <ProjectPanelToggle
            visible={prefs.projectPanelVisible}
            onToggle={() => setPrefs("projectPanelVisible", (visible) => !visible)}
          />
        </Show>
      </div>

      <Show when={!forkInfo()}>
        <div
          aria-hidden={!prefs.projectPanelVisible}
          class={`min-h-0 flex-none overflow-hidden ${
            prefs.projectPanelVisible
              ? "ml-4 w-[332px] translate-x-0 opacity-100"
              : "pointer-events-none ml-0 w-0 translate-x-3 opacity-0"
          }`}
        >
          <ProjectPanel project={props.project} agent={props.tab.agent} />
        </div>
      </Show>
    </div>
  );
}

/**
 * The sidebar handle starts at the conversation boundary and occupies the
 * whole gap on its right. The slim rectangular tab uses the same primary blue
 * as Send without becoming a second focal button, and reaches neither panel's
 * scrollbar. The arrow points toward the action: right closes the visible
 * sidebar, left restores the hidden one.
 */
export function ProjectPanelToggle(props: { visible: boolean; onToggle: () => void }): JSX.Element {
  const label = () => tx(props.visible ? "Hide the project sidebar" : "Show the project sidebar");
  return (
    <Button
      type="button"
      onClick={props.onToggle}
      aria-pressed={props.visible}
      aria-label={label()}
      title={label()}
      class="absolute top-1/2 left-full z-20 flex h-9 w-1.5 -translate-y-1/2 items-center justify-center rounded-r-md border border-primary/40 border-l-0 bg-primary/20 text-primary transition-colors duration-200 hover:border-primary/60 hover:bg-primary/30 motion-reduce:transition-none"
    >
      <Icon
        name="chevron-right"
        stroke-width="3.5"
        class={`text-[10px] transition-transform duration-200 motion-reduce:transition-none ${
          props.visible ? "rotate-0" : "rotate-180"
        }`}
      />
    </Button>
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
    // Through `copyText`, not `navigator.clipboard` directly: the API is
    // refused here and rejects rather than degrading, so this button wrote a
    // log line and nothing else. See `copyText` for the fallback it adds.
    if (await copyText(props.pr.url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_400);
      return;
    }
    log.warn("could not copy the PR URL");
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
       * What the row *is*, and nothing that acts. The whole row used to be the
       * button that opened the pull request, so the one obvious action was
       * discoverable only by clicking text that did not look like a link, and
       * every other click on the row went to GitHub whether or not that was
       * what you meant.
       */}
      <div class="flex min-w-0 flex-1 items-center gap-2.5">
        <span class={`shrink-0 font-semibold ${merged() ? "text-az-pr-strong" : "text-az-strong"}`}>
          #{props.pr.number}
        </span>
        <span class="shrink-0 text-az-muted">{props.pr.repo}</span>
        <Show when={props.pr.branch}>
          <span class="min-w-0 truncate font-mono text-[11px] text-az-body">{props.pr.branch}</span>
        </Show>
        <Show when={copied()}>
          <span class="shrink-0 text-[10.5px] text-success">{tx("copied")}</span>
        </Show>
      </div>
      {/* Coloured and underlined, because it leaves the app. */}
      <Button
        type="button"
        onClick={() =>
          void actions
            .openExternal(props.pr.url)
            .catch((cause) => log.warn(`could not open the PR: ${describeError(cause)}`))
        }
        title={tx("Open {url}", { url: props.pr.url })}
        class="shrink-0 cursor-pointer text-primary underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-75"
      >
        {tx("GitHub ›")}
      </Button>
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
              <Button
                type="button"
                onClick={() =>
                  isLive("refreshPullRequest") && actions.refreshPullRequest(props.pr.id)
                }
                title={tx("CI rollup — click to re-check")}
                class={`shrink-0 rounded-md px-[7px] py-px font-semibold text-[10.5px] ${CI_TONE[props.pr.ci] ?? "bg-base-300 text-az-muted"}`}
              >
                {tx("CI")} {props.pr.ci}
              </Button>
            </Show>
            <Show when={closed()}>
              <span class="shrink-0 font-semibold text-[11px] text-az-muted">{tx("Closed")}</span>
            </Show>
          </>
        }
      >
        <span class="shrink-0 font-semibold text-[11.5px] text-az-pr-strong">{tx("Merged")}</span>
      </Show>
      <Button
        type="button"
        onClick={() => void copy()}
        aria-label={tx("Copy the link to PR {number}", { number: props.pr.number })}
        title={copied() ? tx("Copied") : tx("Copy the link")}
        class="shrink-0 rounded-md p-1 text-az-faint transition-colors hover:text-az-body"
      >
        <Icon name={copied() ? "check" : "copy"} class="text-[12px]" />
      </Button>
      <ReviewButtons pr={props.pr} />
      <Button
        type="button"
        onClick={() => void actions.dismissPullRequest(props.pr.id)}
        aria-label={tx("Dismiss PR {number}", { number: props.pr.number })}
        /* `hover:text-base-content` was a stray DaisyUI token in a file that
         * themes off `az-*`, so this control hovered to a colour the theme does
         * not set. Every other dismiss here warms to `error`. */
        class="shrink-0 text-az-faint transition-colors hover:text-error"
      >
        <Icon name="x" class="text-[13px]" />
      </Button>
    </div>
  );
}

/**
 * Submit a PR for review by an agent, inline and read-only.
 *
 * "Review:" then one icon per agent. A click runs that agent headlessly on the
 * PR; the result lands as a review note in the transcript, with a copy button,
 * and is never sent to the Home agent. The clicked icon spins until the run
 * returns, and a run is only offered where the command is live.
 */
export function ReviewButtons(props: { pr: PullRequest }): JSX.Element {
  const { actions, isLive, state } = useWorkspace();

  const isPending = (agent: Agent): boolean =>
    Boolean(state.reviewing[reviewRunKey(props.pr.url, agent)]);

  const review = (agent: Agent): void => {
    if (isPending(agent)) return;
    void actions
      .reviewPullRequest(props.pr.projectId, props.pr.url, agent)
      .catch((cause) => log.error(`the review failed: ${describeError(cause)}`));
  };

  const REVIEWERS = [
    { agent: "claude", icon: "vendor-claude" },
    { agent: "codex", icon: "vendor-openai" },
    { agent: "copilot", icon: "vendor-copilot" },
  ] as const;

  return (
    <Show when={isLive("reviewPullRequest")}>
      <span class="flex shrink-0 items-center gap-1">
        <span class="text-[10.5px] text-az-faint">{tx("Review")}</span>
        <For each={REVIEWERS}>
          {(reviewer) => (
            <Button
              type="button"
              disabled={isPending(reviewer.agent)}
              onClick={() => review(reviewer.agent)}
              title={tx("Review with {agent}", { agent: AGENT_LABELS[reviewer.agent] })}
              aria-label={tx("Review with {agent}", { agent: AGENT_LABELS[reviewer.agent] })}
              aria-busy={isPending(reviewer.agent)}
              data-state={isPending(reviewer.agent) ? "running" : "idle"}
              class={`flex size-[22px] shrink-0 items-center justify-center rounded-md transition-colors ${
                isPending(reviewer.agent)
                  ? "bg-success/15 text-success ring-1 ring-success/45 ring-inset disabled:opacity-100"
                  : "text-az-faint hover:bg-white/5 hover:text-az-body"
              }`}
            >
              <Icon
                name={isPending(reviewer.agent) ? "history" : reviewer.icon}
                class={`text-[12px] ${isPending(reviewer.agent) ? "animate-spin" : ""}`}
              />
            </Button>
          )}
        </For>
      </span>
    </Show>
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
    // Through `copyText`, which falls back when the clipboard API is refused.
    // Calling `navigator.clipboard` directly is why this button did nothing.
    if (await copyText(id)) {
      setCopied(true);
      clearTimeout(revert);
      revert = setTimeout(() => setCopied(false), 1_400);
    } else {
      // Saying nothing would leave the button looking like it worked.
      log.warn("could not copy the session id");
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
        <span class="shrink-0 font-mono text-[10.5px] text-az-faint">
          {tx("session · none yet")}
        </span>
      }
    >
      {(id) => (
        <span
          title={id()}
          class="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-az-faint"
        >
          <span class="text-az-faint">{tx("session ·")}</span>
          {id().slice(0, 8)}
          <Button
            type="button"
            onClick={() => void copy(id())}
            aria-label={tx("Copy session id")}
            class="flex size-[18px] items-center justify-center rounded transition-colors hover:bg-white/8 hover:text-az-body"
          >
            <Icon name={copied() ? "check" : "copy"} class="text-[10px]" />
          </Button>
        </span>
      )}
    </Show>
  );
}
