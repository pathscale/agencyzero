import { createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { tx } from "~/stores/i18n";
import { useWorkspace } from "~/stores/workspace";
import type {
  UsageAgentValue,
  UsageAnalytics,
  UsageDay,
  UsageModel,
  UsageProject,
  UsageSession,
} from "~/types";

/** The four token classes, each with a stable label and bar colour. */
const TOKEN_CLASSES = [
  { key: "input", tone: "bg-primary" },
  { key: "output", tone: "bg-success" },
  { key: "cacheRead", tone: "bg-info" },
  { key: "cacheWrite", tone: "bg-warning" },
] as const;

const ANALYTICS_TABS = [
  { key: "efficiency", label: "Efficiency" },
  { key: "largest", label: "Largest turn" },
  { key: "value", label: "Value" },
  { key: "sessions", label: "Sessions" },
  { key: "daily", label: "Daily" },
  { key: "projects", label: "Projects" },
  { key: "models", label: "Models" },
] as const;

type AnalyticsTabKey = (typeof ANALYTICS_TABS)[number]["key"];

/** Compact token count, e.g. 610000 becomes "610.0K", 2820000 becomes "2.8M". */
function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function effectiveCacheWrites(reported: number, estimated: number): number {
  return reported + estimated;
}

function cacheWrites(reported: number, estimated: number): string {
  return `${estimated > 0 ? "~" : ""}${tokens(effectiveCacheWrites(reported, estimated))}`;
}

/**
 * Token usage over time, opened by the gauge as a real tab you can leave open.
 *
 * Loads when opened and refreshes only on explicit request. The durable ledger
 * can grow large, so a background timer would turn an occasional report into
 * permanent database work. Everything is drawn with plain divs and inline
 * bars, no chart library.
 */
export function AnalyticsTab(): JSX.Element {
  const { actions } = useWorkspace();
  const [data, setData] = createSignal<UsageAnalytics | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<AnalyticsTabKey>("efficiency");

  const selectTabFromKeyboard = (
    event: KeyboardEvent & { currentTarget: HTMLButtonElement },
    index: number,
  ): void => {
    const last = ANALYTICS_TABS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % ANALYTICS_TABS.length
        : event.key === "ArrowLeft"
          ? (index + last) % ANALYTICS_TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;

    event.preventDefault();
    setActiveTab(ANALYTICS_TABS[next].key);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      .item(next)
      .focus();
  };

  const refresh = async (): Promise<void> => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      setData(await actions.getUsageAnalytics());
    } finally {
      setRefreshing(false);
    }
  };

  onMount(() => {
    void refresh().catch(() => setData(null));
  });

  return (
    <div class="az-scroll flex min-w-0 flex-1 justify-center rounded-panel border border-az-hairline bg-az-sunken">
      <div class="flex w-full max-w-[1120px] flex-col gap-2.5 px-6 pt-5.5 pb-7">
        <Show
          when={data()}
          fallback={
            <div class="flex flex-1 items-center justify-center py-16 text-[12.5px] text-az-muted">
              {tx("Loading usage…")}
            </div>
          }
        >
          {(usage) => (
            <>
              <HeadlineRow usage={usage()} refreshing={refreshing()} onRefresh={refresh} />

              <div
                role="tablist"
                aria-label={tx("Analytics sections")}
                class="flex items-center gap-1 overflow-x-auto rounded-lg border border-az-hairline bg-base-200/55 p-1"
              >
                <For each={ANALYTICS_TABS}>
                  {(tab, index) => {
                    const selected = () => activeTab() === tab.key;
                    return (
                      <button
                        id={`analytics-tab-${tab.key}`}
                        type="button"
                        role="tab"
                        aria-selected={selected()}
                        aria-controls={`analytics-panel-${tab.key}`}
                        tabIndex={selected() ? 0 : -1}
                        onClick={() => setActiveTab(tab.key)}
                        onKeyDown={(event) => selectTabFromKeyboard(event, index())}
                        class={`shrink-0 rounded-md px-3 py-1.5 font-medium text-[11.5px] transition-colors ${
                          selected()
                            ? "bg-base-100 text-az-title shadow-sm"
                            : "text-az-muted hover:bg-base-100/55 hover:text-az-strong"
                        }`}
                      >
                        {tx(tab.label)}
                      </button>
                    );
                  }}
                </For>
              </div>

              <div
                id={`analytics-panel-${activeTab()}`}
                role="tabpanel"
                aria-labelledby={`analytics-tab-${activeTab()}`}
                class="min-w-0"
              >
                <Show when={activeTab() === "efficiency"}>
                  <Show when={usage().importedTurns > 0}>
                    <p class="mb-2 text-[10.5px] text-az-muted">
                      {tx("imported usage coverage", {
                        recovered: usage().reconstructedTurns,
                        total: usage().importedTurns,
                      })}
                    </p>
                  </Show>
                  <CacheEfficiency usage={usage()} />
                </Show>
                <Show when={activeTab() === "largest"}>
                  <LargestTurn usage={usage()} />
                </Show>
                <Show when={activeTab() === "value"}>
                  <AgentValue agents={usage().agents} />
                </Show>
                <Show when={activeTab() === "sessions"}>
                  <SessionBreakdown sessions={usage().sessions} />
                </Show>
                <Show when={activeTab() === "daily"}>
                  <DaySeries days={usage().days} />
                </Show>
                <Show when={activeTab() === "projects"}>
                  <ProjectBreakdown projects={usage().projects} total={usage().totalUsd} />
                </Show>
                <Show when={activeTab() === "models"}>
                  <ModelBreakdown models={usage().models} />
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

/** Outcome-per-dollar comparison using durable completions, not visible rows. */
function AgentValue(props: { agents: UsageAgentValue[] }): JSX.Element {
  return (
    <Show when={props.agents.length > 0}>
      <div class="rounded-xl border border-az-hairline bg-base-100 px-4 py-3.5">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="font-medium text-[12.5px] text-az-title">{tx("Outcome per dollar")}</h2>
          <span class="text-[10.5px] text-az-muted">
            {tx("captured completions and attributed turns only")}
          </span>
        </div>
        <div class="mt-3 grid gap-2 sm:grid-cols-2">
          <For each={props.agents}>
            {(agent) => (
              <div class="rounded-lg border border-az-hairline px-3 py-2.5">
                <div class="flex items-baseline justify-between gap-2">
                  <span class="font-semibold text-[12px] text-az-strong">
                    {agent.agent === "codex"
                      ? "Codex"
                      : agent.agent === "claude"
                        ? "Claude"
                        : agent.agent}
                  </span>
                  <span class="font-mono text-[12px] text-primary">
                    {agent.costPerCompletedItem === null
                      ? "—"
                      : `${dollars(agent.costPerCompletedItem)} / ${tx("finished item")}`}
                  </span>
                </div>
                <div class="mt-1.5 font-mono text-[10.5px] text-az-muted">
                  {agent.completedItems} {tx("finished")} · {agent.turns} {tx("turns")} ·{" "}
                  {tokens(agent.processedTokens)} {tx("processed")}
                </div>
                <div class="mt-1 text-[10.5px] text-az-faint">
                  {dollars(agent.effectiveCostUsd)} {tx("effective cost")}
                  {agent.estimatedCostUsd > 0 ? ` · ${tx("includes local estimates")}` : ""}
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

/** Provider-native sessions, newest first, without guessing historical ownership. */
function SessionBreakdown(props: { sessions: UsageSession[] }): JSX.Element {
  return (
    <Show when={props.sessions.length > 0}>
      <div class="rounded-xl border border-az-hairline bg-base-100 px-4 py-3.5">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="font-medium text-[12.5px] text-az-title">{tx("Per session")}</h2>
          <span class="text-[10.5px] text-az-muted">{tx("captured from this build onward")}</span>
        </div>
        <div class="mt-3 flex flex-col gap-2.5">
          <For each={props.sessions}>
            {(session) => (
              <div class="rounded-lg border border-az-hairline px-3 py-2.5">
                <div class="flex items-baseline gap-2 text-[11.5px]">
                  <span class="min-w-0 flex-1 truncate text-az-strong">{session.projectName}</span>
                  <span class="font-mono text-[10.5px] text-az-muted">{session.agent}</span>
                  <span class="font-mono text-[11px] text-az-title">
                    {dollars(session.costUsd)}
                  </span>
                </div>
                <div class="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-az-muted">
                  <span title={session.sessionId || tx("Provider supplied no session id")}>
                    {session.sessionId ? session.sessionId.slice(0, 8) : tx("no session id")}
                  </span>
                  <span>·</span>
                  <span>{session.model}</span>
                  <span>·</span>
                  <span>
                    {session.turns} {tx("turns")}
                  </span>
                  <span class="ml-auto text-az-strong">
                    {tokens(session.processedTokens)} {tx("processed")}
                  </span>
                  <Show when={session.estimatedCacheWriteTokens > 0}>
                    <span class="text-warning" title={tx("estimated from adjacent cache reads")}>
                      ~{tokens(session.estimatedCacheWriteTokens)} {tx("write")}
                    </span>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

/** Cost ownership by project, sorted by spend with a share bar. */
function ProjectBreakdown(props: { projects: UsageProject[]; total: number }): JSX.Element {
  return (
    <div class="rounded-xl border border-az-hairline bg-base-100 px-4 py-3.5">
      <h2 class="font-medium text-[12.5px] text-az-title">{tx("Per project")}</h2>
      <div class="mt-3 flex flex-col gap-3">
        <For each={props.projects}>
          {(project) => {
            const share = () => (project.costUsd / Math.max(props.total, 0.000001)) * 100;
            return (
              <div>
                <div class="flex items-baseline gap-2 text-[11.5px]">
                  <span class="min-w-0 flex-1 truncate text-az-strong" title={project.projectId}>
                    {project.projectName}
                  </span>
                  <span class="font-mono text-[10.5px] text-az-muted">
                    {project.turns} {tx("turns")}
                  </span>
                  <span class="w-[58px] text-right font-mono text-az-strong">
                    {dollars(project.costUsd)}
                  </span>
                </div>
                <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-base-300">
                  <div class="h-full rounded-full bg-primary" style={{ width: `${share()}%` }} />
                </div>
                <div class="mt-1 flex justify-between font-mono text-[9.5px] text-az-faint">
                  <span>{share().toFixed(1)}%</span>
                  <span>
                    {tx("in")} {tokens(project.inputTokens)} · {tx("out")}{" "}
                    {tokens(project.outputTokens)} · {tx("read")} {tokens(project.cacheReadTokens)}{" "}
                    · {tx("write")}{" "}
                    {cacheWrites(project.cacheWriteTokens, project.estimatedCacheWriteTokens)}
                  </span>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/** Every total in one scannable row instead of a wall of summary cards. */
function HeadlineRow(props: {
  usage: UsageAnalytics;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
}): JSX.Element {
  // Every headline number carries a colour, none left flat grey. Cost,
  // processed and turns are the figures the owner scans for, so they take the
  // accent; the four token components take the same hues as the day-series
  // legend so the tiles and the bars read as one system.
  const tiles = createMemo(() => [
    {
      label: tx("Total cost"),
      value: `${props.usage.estimatedCostUsd > 0 ? "~" : ""}${dollars(props.usage.totalUsd)}`,
      tone: "text-primary",
    },
    { label: tx("Input"), value: tokens(props.usage.totalInputTokens), tone: "text-primary" },
    { label: tx("Output"), value: tokens(props.usage.totalOutputTokens), tone: "text-success" },
    {
      label: tx("Cache read"),
      value: tokens(props.usage.totalCacheReadTokens),
      tone: "text-info",
    },
    {
      label: tx("Cache write"),
      value: cacheWrites(props.usage.totalCacheWriteTokens, props.usage.estimatedCacheWriteTokens),
      tone: "text-warning",
    },
    {
      label: tx("Processed"),
      value: tokens(props.usage.totalProcessedTokens),
      tone: "text-primary",
    },
    { label: tx("Turns"), value: `${props.usage.turns}`, tone: "text-accent" },
  ]);

  return (
    <div class="overflow-x-auto rounded-xl border border-az-hairline bg-base-100">
      <div class="grid min-w-[930px] grid-cols-[132px_repeat(7,minmax(0,1fr))_42px] items-stretch">
        <div class="flex flex-col justify-center px-3.5 py-2.5">
          <h1 class="font-semibold text-[16px] text-az-title tracking-[-.01em]">
            {tx("Analytics")}
          </h1>
          <span class="truncate text-[9.5px] text-az-muted">{tx("usage ledger")}</span>
        </div>
        <For each={tiles()}>
          {(tile) => (
            <div class="flex min-w-0 flex-col justify-center border-az-hairline border-l px-2.5 py-2.5">
              <div class="truncate text-[9.5px] text-az-muted">{tile.label}</div>
              <div class={`mt-0.5 truncate font-bold font-mono text-[15px] ${tile.tone}`}>
                {tile.value}
              </div>
            </div>
          )}
        </For>
        <button
          type="button"
          aria-label={tx("Refresh")}
          title={tx("Refresh")}
          onClick={() => void props.onRefresh()}
          disabled={props.refreshing}
          class="flex items-center justify-center border-az-hairline border-l text-primary transition-colors hover:bg-primary/8 disabled:cursor-wait disabled:opacity-55"
        >
          <Icon name="refresh-cw" class={`text-[13px] ${props.refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>
    </div>
  );
}

/**
 * The read to write ratio, the key metric.
 *
 * Cache reads are far cheaper than fresh input, so a high read to write ratio
 * is what tells you the prompt cache is being hit rather than rebuilt. A ratio
 * that collapses is a cache miss, and it is where the money goes.
 */
function CacheEfficiency(props: { usage: UsageAnalytics }): JSX.Element {
  const ratio = createMemo(
    () =>
      props.usage.totalCacheReadTokens /
      Math.max(
        1,
        effectiveCacheWrites(
          props.usage.totalCacheWriteTokens,
          props.usage.estimatedCacheWriteTokens,
        ),
      ),
  );

  return (
    <div class="rounded-xl border border-az-hairline bg-base-100 px-4 py-4">
      <div class="flex items-baseline gap-3">
        <span class="font-mono font-semibold text-[28px] text-az-strong">
          {ratio().toFixed(1)}
          <span class="ml-1 font-normal text-[13px] text-az-muted">{tx(": 1")}</span>
        </span>
        <span class="font-medium text-[12.5px] text-az-title">
          {tx("cache read : write ratio")}
        </span>
      </div>
      <p class="mt-1.5 text-[11px] text-az-muted leading-[1.55]">
        {tx(
          "reads are roughly 10% the price of input, so a high read:write ratio means caching is working; a low one means the cache is being rebuilt (a miss) instead of hit.",
        )}
      </p>
      <Show when={props.usage.estimatedCacheWriteTokens > 0}>
        <p class="mt-1 text-[10.5px] text-az-faint">
          {tx("Sol cache write estimate", {
            tokens: tokens(props.usage.estimatedCacheWriteTokens),
          })}
        </p>
      </Show>
    </div>
  );
}

/**
 * The single heaviest turn, spelled out.
 *
 * This is the panel that answers "is one request enormous?" directly: it names
 * the biggest turn and its decomposition. If this number is small but the bill
 * is large, the spend is many ordinary turns, not one runaway request — and the
 * lever is fewer/cheaper turns, not compaction. If it is large, the context is
 * bloated and compaction is the lever.
 */
function LargestTurn(props: { usage: UsageAnalytics }): JSX.Element {
  return (
    <Show when={props.usage.largestTurn}>
      {(turn) => (
        <div class="rounded-xl border border-az-hairline bg-base-100 px-4 py-3.5">
          <div class="flex items-baseline justify-between gap-3">
            <span class="font-medium text-[12.5px] text-az-title">{tx("Largest single turn")}</span>
            <span class="font-mono text-[11px] text-az-muted">{turn().model}</span>
          </div>
          <div class="mt-1 flex items-baseline gap-2">
            <span class="font-mono font-semibold text-[24px] text-az-strong">
              {tokens(turn().processedTokens)}
            </span>
            <span class="text-[12px] text-az-muted">{tx("tokens processed")}</span>
            <span class="ml-auto font-mono text-[13px] text-az-title">
              {dollars(turn().costUsd)}
            </span>
          </div>
          <div class="mt-1.5 font-mono text-[11px] text-az-muted">
            {tx("in")} {tokens(turn().inputTokens)} · {tx("read")} {tokens(turn().cacheReadTokens)}{" "}
            · {tx("write")} {tokens(turn().cacheWriteTokens)} · {tx("out")}{" "}
            {tokens(turn().outputTokens)}
            <Show when={turn().estimatedCacheWriteTokens > 0}>
              {` · ${tx("estimated write")} ~${tokens(turn().estimatedCacheWriteTokens)}`}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

/** The widest single stack across the days, so every day's bar shares one scale. */
function dayTotal(day: UsageDay): number {
  return day.inputTokens + day.outputTokens + day.cacheReadTokens + day.cacheWriteTokens;
}

/**
 * One horizontal bar per day, oldest to newest, decomposed into the four token
 * classes side by side. Every bar shares the busiest day's scale, so their
 * lengths are comparable rather than each normalised to itself.
 */
function DaySeries(props: { days: UsageDay[] }): JSX.Element {
  const scale = createMemo(() => Math.max(1, ...props.days.map(dayTotal)));

  const parts = (day: UsageDay) => [
    { key: "input", tone: "bg-primary", value: day.inputTokens },
    { key: "output", tone: "bg-success", value: day.outputTokens },
    { key: "cacheRead", tone: "bg-info", value: day.cacheReadTokens },
    { key: "cacheWrite", tone: "bg-warning", value: day.cacheWriteTokens },
  ];

  return (
    <div class="rounded-xl border border-az-hairline bg-base-100 px-4 py-3.5">
      <div class="flex items-center justify-between">
        <h2 class="font-medium text-[12.5px] text-az-title">{tx("Per day")}</h2>
        <Legend />
      </div>
      <div class="mt-3 flex flex-col gap-2.5">
        <For each={props.days}>
          {(day) => (
            <div class="flex items-center gap-3">
              <span class="w-[52px] shrink-0 font-mono text-[11px] text-az-muted">
                {day.day.slice(5)}
              </span>
              <div class="flex h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-base-300">
                <For each={parts(day)}>
                  {(part) => (
                    <div
                      class={part.tone}
                      style={{ width: `${(part.value / scale()) * 100}%` }}
                      title={`${part.key}: ${tokens(part.value)}`}
                    />
                  )}
                </For>
              </div>
              <span class="w-[52px] shrink-0 text-right font-mono text-[11px] text-az-strong">
                {dollars(day.costUsd)}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** The colour key shared by the day series and the legend that labels it. */
function Legend(): JSX.Element {
  const label: Record<(typeof TOKEN_CLASSES)[number]["key"], string> = {
    input: tx("input"),
    output: tx("output"),
    cacheRead: tx("cache read"),
    cacheWrite: tx("cache write"),
  };
  return (
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <For each={TOKEN_CLASSES}>
        {(cls) => (
          <span class="flex items-center gap-1.5 text-[10.5px] text-az-muted">
            <span class={`size-2 rounded-[3px] ${cls.tone}`} />
            {label[cls.key]}
          </span>
        )}
      </For>
    </div>
  );
}

/** One row per model: its cost and the four token classes, plainly tabulated. */
function ModelBreakdown(props: { models: UsageModel[] }): JSX.Element {
  return (
    <div class="rounded-xl border border-az-hairline bg-base-100 px-4 py-3.5">
      <h2 class="font-medium text-[12.5px] text-az-title">{tx("Per model")}</h2>
      <div class="mt-3 flex flex-col gap-2">
        <div class="grid grid-cols-6 gap-2 border-az-hairline border-b pb-1.5 text-[10.5px] text-az-muted">
          <span class="col-span-1">{tx("Model")}</span>
          <span class="text-right">{tx("Cost")}</span>
          <span class="text-right">{tx("Input")}</span>
          <span class="text-right">{tx("Output")}</span>
          <span class="text-right">{tx("Cache read")}</span>
          <span class="text-right">{tx("Cache write")}</span>
        </div>
        <For each={props.models}>
          {(model) => (
            <div class="grid grid-cols-6 items-center gap-2 text-[11.5px]">
              <span class="col-span-1 min-w-0 truncate text-az-strong">{model.model}</span>
              <span class="text-right font-mono text-az-strong">{dollars(model.costUsd)}</span>
              <span class="text-right font-mono text-az-body">{tokens(model.inputTokens)}</span>
              <span class="text-right font-mono text-az-body">{tokens(model.outputTokens)}</span>
              <span class="text-right font-mono text-az-body">{tokens(model.cacheReadTokens)}</span>
              <span class="text-right font-mono text-az-body">
                {cacheWrites(model.cacheWriteTokens, model.estimatedCacheWriteTokens)}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
