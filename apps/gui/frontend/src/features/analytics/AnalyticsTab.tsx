import { Tabs } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { Button } from "~/components/Button";
import { Icon } from "~/components/Icon";
import { duration } from "~/lib/format";
import { whileMounted } from "~/lib/live";
import { tx } from "~/stores/i18n";
import { useWorkspace } from "~/stores/workspace";
import type {
  UsageAgentValue,
  UsageAnalytics,
  UsageDay,
  UsageItem,
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
  { key: "value", label: "Value" },
  { key: "items", label: "Items" },
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
  const [refreshGeneration, setRefreshGeneration] = createSignal(0);
  const [activeTab, setActiveTab] = createSignal<AnalyticsTabKey>("value");
  const alive = whileMounted();

  const refresh = async (): Promise<void> => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      const next = await actions.getUsageAnalytics();
      alive(setData)(next);
      alive(() => setRefreshGeneration((generation) => generation + 1))();
    } finally {
      alive(setRefreshing)(false);
    }
  };

  onSettled(() => {
    void refresh().catch(alive(() => setData(null)));
  });

  return (
    <div class="az-scroll flex min-w-0 flex-1 justify-center rounded-panel border border-az-hairline bg-az-sunken">
      <div class="flex w-full max-w-[1120px] flex-col gap-2.5 px-6 pt-5.5 pb-7">
        <Show
          when={data()}
          fallback={
            <div class="flex flex-1 items-center justify-center py-16 text-az-muted text-ui-label-lg">
              {tx("Loading usage…")}
            </div>
          }
        >
          {(usage) => (
            <>
              <HeadlineRow
                usage={usage()}
                refreshing={refreshing()}
                refreshGeneration={refreshGeneration()}
                onRefresh={refresh}
              />

              <Tabs.Root
                id="analytics-sections"
                selectedKey={activeTab()}
                onSelectionChange={(key) => setActiveTab(key as AnalyticsTabKey)}
                class="gap-0"
              >
                <Tabs.List
                  aria-label={tx("Analytics sections")}
                  class="flex shrink-0 items-center gap-1 overflow-x-auto rounded-lg border border-az-hairline bg-base-200/55 p-1"
                >
                  <For each={ANALYTICS_TABS}>
                    {(tab) => {
                      const selected = () => activeTab() === tab.key;
                      return (
                        <Tabs.Tab
                          id={tab.key}
                          aria-label={tx(tab.label)}
                          class={`shrink-0 rounded-md px-3 py-1.5 font-medium text-ui-detail transition-colors ${
                            selected()
                              ? "bg-base-100 text-az-title shadow-sm"
                              : "text-az-muted hover:bg-base-100/55 hover:text-az-strong"
                          }`}
                        >
                          {tx(tab.label)}
                        </Tabs.Tab>
                      );
                    }}
                  </For>
                </Tabs.List>

                <Tabs.Panel id={activeTab()} class="min-w-0 p-0">
                  <Show when={activeTab() === "value"}>
                    <AgentValue agents={usage().agents} />
                  </Show>
                  <Show when={activeTab() === "sessions"}>
                    <SessionBreakdown sessions={usage().sessions} />
                  </Show>
                  <Show when={activeTab() === "items"}>
                    <ItemBreakdown items={usage().items} />
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
                </Tabs.Panel>
              </Tabs.Root>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

function agentTime(ms: number): string {
  if (ms < 60 * 60_000) return duration(ms);
  const hours = Math.floor(ms / (60 * 60_000));
  const minutes = Math.round((ms % (60 * 60_000)) / 60_000);
  return `${hours}h ${minutes}m`;
}

/** Actual provider runtime attributed to each item, longest-running first. */
function ItemBreakdown(props: { items: UsageItem[] }): JSX.Element {
  return (
    <div class="rounded-xl border border-az-hairline bg-base-100 px-4 py-3.5">
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="font-medium text-az-title text-ui-label-lg">{tx("Per item")}</h2>
        <span class="text-az-muted text-ui-caption-sm">
          {tx("measured agent-active time from captured runs")}
        </span>
      </div>
      <Show
        when={props.items.length > 0}
        fallback={
          <div class="py-8 text-center text-az-muted text-ui-detail">
            {tx("No item-linked runs yet")}
          </div>
        }
      >
        <div class="mt-3 flex flex-col gap-2">
          <For each={props.items}>
            {(item) => (
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-az-hairline px-3 py-2.5">
                <div class="min-w-0">
                  <div class="truncate text-az-strong text-ui-detail" title={item.itemId}>
                    {item.itemTitle}
                  </div>
                  <div class="mt-1 truncate font-mono text-az-muted text-ui-tiny">
                    {item.projectName} · {item.agents.join(", ") || "—"} · {item.turns}{" "}
                    {tx("turns")}
                    {item.completed ? ` · ${tx("finished")}` : ""}
                  </div>
                </div>
                <div class="text-right">
                  <div class="font-mono font-semibold text-primary text-ui-label">
                    {agentTime(item.durationMs)}
                  </div>
                  <div class="mt-0.5 text-az-muted text-ui-micro">{tx("agent time")}</div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** Outcome-per-dollar comparison using durable completions, not visible rows. */
function AgentValue(props: { agents: UsageAgentValue[] }): JSX.Element {
  return (
    <Show when={props.agents.length > 0}>
      <div class="rounded-xl border border-az-hairline bg-base-100 px-4 py-3.5">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="font-medium text-az-title text-ui-label-lg">{tx("Outcome per dollar")}</h2>
          <span class="text-az-muted text-ui-caption-sm">
            {tx("captured completions and attributed turns only")}
          </span>
        </div>
        <div class="mt-3 grid gap-2 sm:grid-cols-2">
          <For each={props.agents}>
            {(agent) => (
              <div class="rounded-lg border border-az-hairline px-3 py-2.5">
                <div class="flex items-baseline justify-between gap-2">
                  <span class="font-semibold text-az-strong text-ui-label">
                    {agent.agent === "codex"
                      ? "Codex"
                      : agent.agent === "claude"
                        ? "Claude"
                        : agent.agent}
                  </span>
                  <span class="font-mono text-primary text-ui-label">
                    {agent.costPerCompletedItem === null
                      ? "—"
                      : `${dollars(agent.costPerCompletedItem)} / ${tx("finished item")}`}
                  </span>
                </div>
                <div class="mt-1.5 font-mono text-az-muted text-ui-caption-sm">
                  {agent.completedItems} {tx("finished")} · {agent.turns} {tx("turns")} ·{" "}
                  {tokens(agent.processedTokens)} {tx("processed")}
                </div>
                <div class="mt-1 text-az-faint text-ui-caption-sm">
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
          <h2 class="font-medium text-az-title text-ui-label-lg">{tx("Per session")}</h2>
          <span class="text-az-muted text-ui-caption-sm">
            {tx("captured from this build onward")}
          </span>
        </div>
        <div class="mt-3 flex flex-col gap-2.5">
          <For each={props.sessions}>
            {(session) => (
              <div class="rounded-lg border border-az-hairline px-3 py-2.5">
                <div class="flex items-baseline gap-2 text-ui-detail">
                  <span class="min-w-0 flex-1 truncate text-az-strong">{session.projectName}</span>
                  <span class="font-mono text-az-muted text-ui-caption-sm">{session.agent}</span>
                  <span class="font-mono text-az-title text-ui-caption">
                    {dollars(session.costUsd)}
                  </span>
                </div>
                <div class="mt-1 flex items-center gap-2 font-mono text-az-muted text-ui-caption-sm">
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
      <h2 class="font-medium text-az-title text-ui-label-lg">{tx("Per project")}</h2>
      <div class="mt-3 flex flex-col gap-3">
        <For each={props.projects}>
          {(project) => {
            const share = () => (project.costUsd / Math.max(props.total, 0.000001)) * 100;
            return (
              <div>
                <div class="flex items-baseline gap-2 text-ui-detail">
                  <span class="min-w-0 flex-1 truncate text-az-strong" title={project.projectId}>
                    {project.projectName}
                  </span>
                  <span class="font-mono text-az-muted text-ui-caption-sm">
                    {project.turns} {tx("turns")}
                  </span>
                  <span class="w-[58px] text-right font-mono text-az-strong">
                    {dollars(project.costUsd)}
                  </span>
                </div>
                <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-base-300">
                  <div class="h-full rounded-full bg-primary" style={{ width: `${share()}%` }} />
                </div>
                <div class="mt-1 flex justify-between font-mono text-az-faint text-ui-micro">
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

function efficiencyRatio(usage: UsageAnalytics): number {
  return (
    usage.totalCacheReadTokens /
    Math.max(1, effectiveCacheWrites(usage.totalCacheWriteTokens, usage.estimatedCacheWriteTokens))
  );
}

function efficiencySignal(usage: UsageAnalytics): { label: string; tone: string } {
  const hasCacheData =
    usage.totalCacheReadTokens > 0 ||
    effectiveCacheWrites(usage.totalCacheWriteTokens, usage.estimatedCacheWriteTokens) > 0;
  if (!hasCacheData) return { label: tx("No cache data"), tone: "text-az-muted" };
  const ratio = efficiencyRatio(usage);
  if (ratio >= 10) return { label: tx("Healthy cache reuse"), tone: "text-success" };
  if (ratio >= 3) return { label: tx("Mixed cache reuse"), tone: "text-warning" };
  return { label: tx("Weak cache reuse"), tone: "text-error" };
}

/** Every total in a compact grid that wraps instead of clipping. */
function HeadlineRow(props: {
  usage: UsageAnalytics;
  refreshing: boolean;
  refreshGeneration: number;
  onRefresh: () => Promise<void>;
}): JSX.Element {
  const tiles = createMemo(() => {
    const largest = props.usage.largestTurn;
    const efficiency = efficiencySignal(props.usage);
    const hasCacheData =
      props.usage.totalCacheReadTokens > 0 ||
      effectiveCacheWrites(
        props.usage.totalCacheWriteTokens,
        props.usage.estimatedCacheWriteTokens,
      ) > 0;
    return [
      {
        label: tx("Total cost"),
        value: `${props.usage.estimatedCostUsd > 0 ? "~" : ""}${dollars(props.usage.totalUsd)}`,
        tone: "text-primary",
      },
      {
        label: tx("Billable traffic"),
        value: tokens(props.usage.totalProcessedTokens),
        tone: "text-primary",
        detail: tx("summed across model calls"),
        title: tx(
          "Cumulative billable token traffic across this turn's model calls: fresh input, repeated cached input, cache writes, and generated output reported so far.",
        ),
      },
      {
        label: tx("Usage records"),
        value: `${props.usage.turns}`,
        tone: "text-accent",
        detail: tx("completed and reconstructed agent runs"),
      },
      { label: tx("Sessions"), value: `${props.usage.sessions.length}`, tone: "text-info" },
      { label: tx("Projects"), value: `${props.usage.projects.length}`, tone: "text-info" },
      {
        label: tx("Efficiency"),
        value: hasCacheData ? `${efficiencyRatio(props.usage).toFixed(1)} : 1` : "—",
        tone: efficiency.tone,
        detail: efficiency.label,
        title: tx(
          "Cache reuse signal: 10:1 or higher is healthy, 3:1 to 10:1 is mixed, and below 3:1 is weak. This does not measure total spend.",
        ),
      },
      {
        label: tx("Largest agent run"),
        value: largest ? tokens(largest.processedTokens) : "—",
        tone: largest ? "text-warning" : "text-az-muted",
        detail: largest
          ? `${largest.model} · ${dollars(largest.costUsd)} · ${tx("across model calls")}`
          : tx("No turns yet"),
        title: largest
          ? tx(
              "One agent run can make many model calls. This is cumulative token traffic, not context-window size.",
            )
          : undefined,
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
        value: cacheWrites(
          props.usage.totalCacheWriteTokens,
          props.usage.estimatedCacheWriteTokens,
        ),
        tone: "text-warning",
        detail:
          props.usage.estimatedCacheWriteTokens > 0
            ? tx("Sol cache write estimate", {
                tokens: tokens(props.usage.estimatedCacheWriteTokens),
              })
            : undefined,
      },
    ];
  });

  return (
    <div class="rounded-xl border border-az-hairline bg-base-100 p-2">
      <div class="mb-1.5 flex min-w-0 items-center gap-3 px-1.5 py-0.5">
        <span
          role="status"
          aria-label={tx("Analytics refresh generation {count}", {
            count: props.refreshGeneration,
          })}
          class="sr-only"
        >
          {tx("Analytics refresh generation {count}", { count: props.refreshGeneration })}
        </span>
        <div class="min-w-0 flex-1">
          <h1 class="font-semibold text-az-title text-ui-title tracking-[-.01em]">
            {tx("Analytics")}
          </h1>
          <div class="flex flex-wrap items-center gap-x-2 text-az-muted text-ui-micro">
            <span>{tx("usage ledger")}</span>
            <Show when={props.usage.importedTurns > 0}>
              <span>
                {tx("imported usage coverage", {
                  recovered: props.usage.reconstructedTurns,
                  total: props.usage.importedTurns,
                })}
              </span>
            </Show>
          </div>
        </div>
        <Button
          id="analytics-refresh"
          type="button"
          aria-label={tx("Refresh analytics")}
          title={tx("Refresh analytics")}
          onClick={() => void props.onRefresh()}
          disabled={props.refreshing}
          class="flex size-8 shrink-0 items-center justify-center rounded-lg text-primary transition-colors hover:bg-az-chip disabled:cursor-wait disabled:opacity-55"
        >
          <Icon
            name="refresh-cw"
            class={`text-ui-body ${props.refreshing ? "animate-spin" : ""}`}
          />
        </Button>
      </div>
      <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <For each={tiles()}>
          {(tile) => (
            <div
              class="flex min-w-0 flex-col justify-center rounded-lg border border-az-hairline bg-az-inset px-2.5 py-2"
              title={tile.title}
            >
              <div class="truncate text-az-muted text-ui-micro">{tile.label}</div>
              <div class={`mt-0.5 truncate font-bold font-mono text-ui-lead ${tile.tone}`}>
                {tile.value}
              </div>
              {/*
                Footnotes wrap; the label and value above still truncate.
                A tile in this grid is about 150px wide, and two of these
                details are whole sentences — the Sol cache-write estimate is
                over a hundred characters. `truncate` gave them one line and
                clipped the rest, so the reading was "~28.7M of Sol cache
                writes inferred from…" with the caveat that the latest turn is
                unknown cut off entirely. That caveat is the point of the
                sentence, so losing it is worse than a taller tile.

                `title` carries the full text for the two that set one, but a
                footnote that can only be read by hovering is not a footnote.
              */}
              <Show when={tile.detail}>
                <div class="mt-0.5 text-az-body text-ui-tiny leading-[1.4]" title={tile.detail}>
                  {tile.detail}
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
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
        <h2 class="font-medium text-az-title text-ui-label-lg">{tx("Per day")}</h2>
        <Legend />
      </div>
      <div class="mt-3 flex flex-col gap-2.5">
        <For each={props.days}>
          {(day) => (
            <div class="flex items-center gap-3">
              <span class="w-[52px] shrink-0 font-mono text-az-muted text-ui-caption">
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
              <span class="w-[52px] shrink-0 text-right font-mono text-az-strong text-ui-caption">
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
          <span class="flex items-center gap-1.5 text-az-muted text-ui-caption-sm">
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
      <h2 class="font-medium text-az-title text-ui-label-lg">{tx("Per model")}</h2>
      <div class="mt-3 flex flex-col gap-2">
        <div class="grid grid-cols-6 gap-2 border-az-hairline border-b pb-1.5 text-az-muted text-ui-caption-sm">
          <span class="col-span-1">{tx("Model")}</span>
          <span class="text-right">{tx("Cost")}</span>
          <span class="text-right">{tx("Input")}</span>
          <span class="text-right">{tx("Output")}</span>
          <span class="text-right">{tx("Cache read")}</span>
          <span class="text-right">{tx("Cache write")}</span>
        </div>
        <For each={props.models}>
          {(model) => (
            <div class="grid grid-cols-6 items-center gap-2 text-ui-detail">
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
