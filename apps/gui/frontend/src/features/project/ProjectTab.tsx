import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { EditableTitle } from "~/components/EditableTitle";
import { Icon } from "~/components/Icon";
import { Panel } from "~/components/Panel";
import { Composer } from "~/features/project/Composer";
import { ProjectPanel } from "~/features/project/ProjectPanel";
import { TranscriptPane } from "~/features/project/TranscriptPane";
import { countdown } from "~/lib/format";
import { AGENT_LABELS, rateLimitLabel } from "~/lib/labels";
import { describeError, log } from "~/lib/log";
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
import { QUEUE_REASONS, useNow, useWorkspace } from "~/stores/workspace";
import type { Agent, Project, PullRequest, Tab } from "~/types";

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
  const { state, actions, promptModels, effortsFor, permissionsFor, capabilitiesFor, isLive } =
    useWorkspace();
  const now = useNow();

  const messages = () => state.messages[props.project.id] ?? [];

  /*
   * The agent that actually ran, not a hardcoded name: the last message that
   * recorded one, falling back to the tab's next provider. A project can be
   * switched before its next reply, and a header hardcoded to Claude would lie.
   */
  const agent = () =>
    [...messages()].reverse().find((message) => message.author === "agent")?.agent ??
    props.tab.agent;
  const running = () => state.running[props.project.id] ?? [];
  const canFollowUp = () => {
    const runningAgent = state.runStatus[props.project.id]?.agent;
    const agent = runningAgent ?? props.tab.agent;
    return (
      (runningAgent === undefined || runningAgent === props.tab.agent) &&
      (capabilitiesFor(agent)?.liveFollowUp ?? false)
    );
  };
  /*
   * A refusal, or a warning that one is coming. Not the heartbeat: the provider
   * emits a record on healthy runs too, with status `allowed`, and rendering
   * that as an orange warning told you a run was limited when it was not.
   *
   * The warning used to be dropped here along with the heartbeat, which threw
   * away the one report you can still act on. A refusal is news after the fact.
   */
  const rateLimit = () => {
    const selectedAgent = state.runStatus[props.project.id]?.agent ?? props.tab.agent;
    const limit = state.rateLimits[props.project.id]?.[selectedAgent];
    return limit?.isBlocking || limit?.isWarning ? limit : undefined;
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
  const likelyCacheBreak = createMemo(() => cacheBreak(tabMessages()));

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

  /** Warm the 7-day readout as it fills: above 90% is error, above 70% warning. */
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
    if (props.tab.agent === "claude") {
      const window = state.claudeUsage?.sevenDay;
      if (!window) return null;
      const percent = Math.min(100, Math.max(0, window.utilization));
      const used = percent.toFixed(0);
      const reset = window.resetsAt ? countdown(window.resetsAt, now()) : "";
      return {
        label: `Claude 7d ${used}%`,
        title: reset ? `Resets in ${reset}` : "",
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
    const used = reported === null ? "not reported" : `${reported}%`;
    const reset = window.resetsAt ? countdown(window.resetsAt, now()) : "";
    return {
      label: `Codex 7d ${used}${reported === null ? "" : " used"}`,
      title: reset ? `Resets in ${reset}` : "",
      severity: severityFor(reported),
    };
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
            label={tx("Rename project")}
            class="min-w-0 flex-1 font-semibold text-[14.5px] text-az-title"
            inputClass="font-semibold text-[14.5px]"
          />
          {/*
            Turns and cost live here rather than under the prompt. They describe
            the conversation as a whole, which is what this label already names,
            and moving them up leaves the composer row for the controls that act
            on the next message.
          */}
          <span class="flex min-w-0 shrink items-center gap-2 overflow-hidden rounded-full border border-az-hairline bg-base-300 px-2.5 py-0.5 font-mono text-[11px] text-az-muted">
            <span class="shrink-0 font-semibold text-az-body">{AGENT_LABELS[agent()]}</span>
            <Show when={totals().turns > 0}>
              <span class="text-az-faint">·</span>
              <span>
                {totals().turns} {tx("turn")}
              </span>
              <span class="text-az-faint">·</span>
              {/* The session's summed consumption — where the tokens went. The
                  context readout under the composer answers a different
                  question (how full the window is), so both exist. */}
              <span title={costTitle()}>
                {compactCount(totals().tokens)} {tx("tok")}
              </span>
              <span class="text-az-faint">·</span>
              <span title={costTitle()}>{costLabel(totals().costUsd)}</span>
              <Show when={totals().reported < totals().turns}>
                <span class="text-az-faint" title={tx("Some turns reported no usage")}>
                  {tx("(partial)")}
                </span>
              </Show>
            </Show>
            <Show when={providerUsage()}>
              {(usage) => (
                <>
                  <span class="text-az-faint">·</span>
                  {/* The 7-day window is the number that decides whether you can
                      keep working today, so it is not left flat grey: it warms
                      toward warning as it fills and goes error past 90%. */}
                  <span
                    class={`font-semibold ${
                      usage().severity === "high"
                        ? "text-error"
                        : usage().severity === "mid"
                          ? "text-warning"
                          : "text-az-body"
                    }`}
                    title={usage().title}
                  >
                    {usage().label}
                  </span>
                </>
              )}
            </Show>
          </span>

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

          <Show when={rateLimit()}>
            {(limit) => (
              /*
               * One line, in words, and nothing else.
               *
               * It read `allowed_warning (seven_day) · resets 21:00`, which is
               * the provider's status word, the provider's window name and a
               * time, wrapped onto two lines in a pill. Three facts where one
               * was wanted: whether to slow down. The window and the reset are
               * dropped, and `whitespace-nowrap` is what keeps the pill on one
               * line however narrow the header gets.
               */
              <div class="mr-1.5 flex items-center gap-[7px] whitespace-nowrap rounded-full border border-warning/34 bg-warning/15 px-2.5 py-1 text-[11.5px]">
                <Icon name="pause" class="text-[12px] text-warning" />
                <span class="font-semibold text-warning">{rateLimitLabel(limit().message)}</span>
              </div>
            )}
          </Show>

          {/*
            The sidebar toggle lives at the far right of the header, hard against
            the panel edge the sidebar attaches to, so the control that shows and
            hides the right column sits next to that column rather than beside the
            project name where it acted on something far away.
          */}
          <button
            type="button"
            onClick={() => setPrefs("projectPanelVisible", (visible) => !visible)}
            aria-pressed={prefs.projectPanelVisible}
            aria-label={tx(
              prefs.projectPanelVisible ? "Hide the project sidebar" : "Show the project sidebar",
            )}
            title={tx(
              prefs.projectPanelVisible ? "Hide the project sidebar" : "Show the project sidebar",
            )}
            class={`flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors ${
              prefs.projectPanelVisible
                ? "border-primary/25 bg-primary/10 text-primary"
                : "border-az-hairline text-az-muted hover:text-base-content"
            }`}
          >
            <Icon name="layout-grid" class="text-[13px]" />
          </button>
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
                      aria-label={tx("Drop this queued message")}
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
            onCompact={
              capabilitiesFor(props.tab.agent)?.commands
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
            onExtraThinkingChange={(enabled) => actions.setTabExtraThinking(props.tab.key, enabled)}
            permission={props.tab.permission}
            permissions={permissionsFor(props.tab.agent)}
            usage={contextLabel()}
            /* The warm context the next turn will resend, so the composer can
               price it live as you type. From the tab's running totals. */
            contextTokens={standing().contextTokens ?? 0}
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
            onSend={(body, study) => actions.send(props.project.id, body, study)}
          />
        </div>
      </Panel>

      <Show when={prefs.projectPanelVisible}>
        <ProjectPanel project={props.project} />
      </Show>
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
      <button
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
                title={tx("CI rollup — click to re-check")}
                class={`shrink-0 rounded-md px-[7px] py-px font-semibold text-[10.5px] ${CI_TONE[props.pr.ci] ?? "bg-base-300 text-az-muted"}`}
              >
                {tx("CI")} {props.pr.ci}
              </button>
            </Show>
            <Show when={closed()}>
              <span class="shrink-0 font-semibold text-[11px] text-az-muted">{tx("Closed")}</span>
            </Show>
          </>
        }
      >
        <span class="shrink-0 font-semibold text-[11.5px] text-az-pr-strong">{tx("Merged")}</span>
      </Show>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={tx("Copy the link to PR {number}", { number: props.pr.number })}
        title={copied() ? tx("Copied") : tx("Copy the link")}
        class="shrink-0 rounded-md p-1 text-az-faint transition-colors hover:text-az-body"
      >
        <Icon name={copied() ? "check" : "copy"} class="text-[12px]" />
      </button>
      <ReviewButtons pr={props.pr} />
      <button
        type="button"
        onClick={() => void actions.dismissPullRequest(props.pr.id)}
        aria-label={tx("Dismiss PR {number}", { number: props.pr.number })}
        class="shrink-0 text-az-faint transition-colors hover:text-base-content"
      >
        <Icon name="x" class="text-[13px]" />
      </button>
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
function ReviewButtons(props: { pr: PullRequest }): JSX.Element {
  const { actions, isLive } = useWorkspace();
  const [pending, setPending] = createSignal<Agent | null>(null);

  const review = (agent: Agent): void => {
    setPending(agent);
    void actions
      .reviewPullRequest(props.pr.projectId, props.pr.url, agent)
      .catch((cause) => log.error(`the review failed: ${describeError(cause)}`))
      .finally(() => setPending(null));
  };

  const REVIEWERS = [
    { agent: "claude", icon: "sparkles" },
    { agent: "codex", icon: "gauge" },
    { agent: "copilot", icon: "git-pull-request" },
  ] as const;

  return (
    <Show when={isLive("reviewPullRequest")}>
      <span class="flex shrink-0 items-center gap-1">
        <span class="text-[10.5px] text-az-faint">{tx("Review")}</span>
        <For each={REVIEWERS}>
          {(reviewer) => (
            <button
              type="button"
              disabled={pending() !== null}
              onClick={() => review(reviewer.agent)}
              title={tx("Review with {agent}", { agent: AGENT_LABELS[reviewer.agent] })}
              aria-label={tx("Review with {agent}", { agent: AGENT_LABELS[reviewer.agent] })}
              class="flex size-[22px] shrink-0 items-center justify-center rounded-md text-az-faint transition-colors hover:bg-white/5 hover:text-az-body disabled:opacity-40"
            >
              <Icon
                name={pending() === reviewer.agent ? "history" : reviewer.icon}
                class={`text-[12px] ${pending() === reviewer.agent ? "animate-spin" : ""}`}
              />
            </button>
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
          <button
            type="button"
            onClick={() => void copy(id())}
            aria-label={tx("Copy session id")}
            class="flex size-[18px] items-center justify-center rounded transition-colors hover:bg-white/8 hover:text-az-body"
          >
            <Icon name={copied() ? "check" : "copy"} class="text-[10px]" />
          </button>
        </span>
      )}
    </Show>
  );
}
