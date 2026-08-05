import { createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { tx } from "~/stores/i18n";
import { useWorkspace } from "~/stores/workspace";
import type { UsageAnalytics, UsageDay, UsageModel } from "~/types";

/** The four token classes, each with a stable label and bar colour. */
const TOKEN_CLASSES = [
  { key: "input", tone: "bg-primary" },
  { key: "output", tone: "bg-success" },
  { key: "cacheRead", tone: "bg-info" },
  { key: "cacheWrite", tone: "bg-warning" },
] as const;

/** Compact token count, e.g. 610000 becomes "610.0K", 2820000 becomes "2.8M". */
function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Token usage over time, opened by the gauge as a real tab you can leave open.
 *
 * Read once on mount, the same as the Cost section: the usage ledger only
 * grows when a run finishes, and this is not a screen left open while runs
 * happen. Everything is drawn with plain divs and inline bars, no chart
 * library, so it stays inside the app's own visual tokens.
 */
export function AnalyticsTab(): JSX.Element {
  const { actions } = useWorkspace();
  const [data, setData] = createSignal<UsageAnalytics | null>(null);

  onMount(() => {
    void actions
      .getUsageAnalytics()
      .then(setData)
      .catch(() => setData(null));
  });

  return (
    <div class="az-scroll flex min-w-0 flex-1 justify-center rounded-panel border border-az-hairline bg-az-sunken">
      <div class="flex w-full max-w-[820px] flex-col gap-3 px-6 pt-5.5 pb-7">
        <div class="flex items-baseline gap-2.5 pb-0.5">
          <h1 class="font-semibold text-[18px] text-az-title tracking-[-.01em]">
            {tx("Analytics")}
          </h1>
          <span class="text-[11.5px] text-az-muted">
            {tx("token usage, summed from the usage ledger")}
          </span>
        </div>

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
              <StatTiles usage={usage()} />
              <CacheEfficiency usage={usage()} />
              <DaySeries days={usage().days} />
              <ModelBreakdown models={usage().models} />
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

/** The six headline totals, in a responsive grid of tiles. */
function StatTiles(props: { usage: UsageAnalytics }): JSX.Element {
  const tiles = createMemo(() => [
    { label: tx("Total cost"), value: dollars(props.usage.totalUsd) },
    { label: tx("Input"), value: tokens(props.usage.totalInputTokens) },
    { label: tx("Output"), value: tokens(props.usage.totalOutputTokens) },
    { label: tx("Cache read"), value: tokens(props.usage.totalCacheReadTokens) },
    { label: tx("Cache write"), value: tokens(props.usage.totalCacheWriteTokens) },
    { label: tx("Turns"), value: `${props.usage.turns}` },
  ]);

  return (
    <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      <For each={tiles()}>
        {(tile) => (
          <div class="rounded-xl border border-az-hairline bg-base-100 px-3.5 py-3">
            <div class="text-[11px] text-az-muted">{tile.label}</div>
            <div class="mt-1 font-mono font-semibold text-[17px] text-az-strong">{tile.value}</div>
          </div>
        )}
      </For>
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
    () => props.usage.totalCacheReadTokens / Math.max(1, props.usage.totalCacheWriteTokens),
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
                {tokens(model.cacheWriteTokens)}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
