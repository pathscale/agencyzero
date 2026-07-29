import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  untrack,
} from "solid-js";
import { SectionPanel } from "~/components/Panel";
import { countdown } from "~/lib/format";
import { type ClaudeWindowKind, claudeWindowKind } from "~/lib/stats";
import { prefs, togglePanelSection } from "~/stores/prefs";
import { isLimitLive, useWorkspace } from "~/stores/workspace";
import type { QuotaWindow, RateLimit } from "~/types";

/**
 * A clock that ticks once a minute.
 *
 * The totals are reactive already and would update the instant a run finished.
 * The tick is what keeps the displayed figures — and the reset countdowns —
 * settling on a readable cadence instead of twitching mid-run.
 */
function useMinuteClock(): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(timer));
  return now;
}

/**
 * The three Claude limits worth a permanent line: the 5-hour session window,
 * the weekly account window, and the weekly Fable/Opus cap. Fixed rather than
 * derived from reports, so the panel has a stable shape — a line that appears
 * only once you have hit its limit is a line you never learn to read.
 */
const CLAUDE_LINES: { kind: ClaudeWindowKind; label: string }[] = [
  { kind: "session", label: "Current session" },
  { kind: "weekly", label: "Weekly" },
  { kind: "fable", label: "Fable" },
];

type LineReport = {
  value: string;
  tone: "normal" | "hot" | "blocked" | "empty";
  title: string;
};

/**
 * Claude account usage, at the top of the project's right-hand column.
 *
 * **Claude only, and account only.** Per-project spend lives by the composer,
 * where the conversation it describes is; the other agents' account figures
 * live in Settings until their interface is properly exposed.
 *
 * Three fixed lines with a countdown each — a deadline you have to subtract
 * from the current time is a deadline you misread. Claude reports quota only
 * *during* a run (the percentages its `/usage` screen shows are not on the
 * wire), so before the first run each line says "no report yet" rather than
 * showing a zero it cannot know.
 */
export function UsagePanel(): JSX.Element {
  const { state, actions } = useWorkspace();
  const minute = useMinuteClock();

  /*
   * Re-asked on the minute, because a quota moves while the window is open.
   *
   * **The dependency list is exactly `minute()` and `boot.status`, and that is
   * deliberate.** `refreshQuota` writes `state.quota`, so reading it inside the
   * tracked scope makes the effect retrigger itself the instant its own write
   * lands — a quota call every few milliseconds, each one spawning a `codex
   * app-server` process. `untrack` is what stops the write feeding the read.
   *
   * Not before boot is ready, either: this panel mounts while `selectApi()` is
   * still in flight, and an unguarded call throws "workspace used before the
   * backend was selected".
   */
  createEffect(() => {
    minute();
    if (state.boot.status !== "ready") return;

    untrack(() => {
      const worthAsking =
        state.quota === null || state.quota.agents.some((agent) => agent.supported);
      if (worthAsking) void actions.refreshQuota();
    });
  });

  /** The best report per line: a refusal beats a figure beats a heartbeat. */
  const reports = createMemo<{
    byKind: Partial<Record<ClaudeWindowKind, LineReport>>;
    /**
     * Live refusals whose wording names no window. They cannot be filed under
     * a fixed line, and a refusal that quietly disappears is the one failure
     * mode this panel is not allowed to have — so they get lines of their own.
     */
    extras: { label: string; report: LineReport }[];
  }>(() => {
    const now = minute();
    const byKind: Partial<Record<ClaudeWindowKind, LineReport>> = {};
    const extras: { label: string; report: LineReport }[] = [];

    // Account windows, should Claude ever learn to answer `account_usage`.
    const claude = state.quota?.agents.find((agent) => agent.agent === "claude");
    for (const window of claude?.windows ?? []) {
      const kind = claudeWindowKind(window.window);
      if (kind) byKind[kind] = windowReport(window, now);
    }

    /*
     * In-run reports, which are all Claude says today, read from the
     * per-window map: the plan is account-wide, so whichever project a report
     * arrived on, it holds here — and a weekly report survives a later
     * five-hour one instead of being overwritten.
     */
    for (const [key, limit] of Object.entries(state.quotaWindows)) {
      if (!isLimitLive(limit, now)) continue;
      const kind = claudeWindowKind(limit.message);
      if (kind) {
        // A refusal outranks whatever else this line had to say.
        if (limit.isBlocking || !byKind[kind]) byKind[kind] = limitReport(limit, now);
      } else if (limit.isBlocking) {
        extras.push({ label: key, report: limitReport(limit, now) });
      }
    }

    return { byKind, extras };
  });

  return (
    <SectionPanel
      icon="gauge"
      title="Claude usage"
      isOpen={prefs.panelSections.usage}
      onToggle={() => togglePanelSection("usage")}
      class="flex-none"
    >
      <div class="flex flex-col gap-[3px] px-3.5 py-2.5">
        <For each={CLAUDE_LINES}>
          {(line) => (
            <UsageLine
              label={line.label}
              report={
                reports().byKind[line.kind] ?? {
                  value: "no report yet",
                  tone: "empty",
                  title:
                    "Claude reports quota only during a run — this fills in after the next one.",
                }
              }
            />
          )}
        </For>
        <For each={reports().extras}>
          {(extra) => <UsageLine label={extra.label} report={extra.report} />}
        </For>
      </div>
    </SectionPanel>
  );
}

/** One row: label left, state and countdown right, full detail on hover. */
function UsageLine(props: { label: string; report: LineReport }): JSX.Element {
  return (
    <div
      title={props.report.title}
      class="flex items-baseline gap-2 font-mono text-[11px] leading-[1.6]"
    >
      <span
        class={`min-w-0 flex-1 truncate ${
          props.report.tone === "blocked" ? "text-error" : "text-az-muted"
        }`}
      >
        {props.label}
      </span>
      <span
        class={`shrink-0 ${
          props.report.tone === "blocked"
            ? "text-error"
            : props.report.tone === "hot"
              ? "text-warning"
              : props.report.tone === "empty"
                ? "text-az-faint"
                : "text-az-body"
        }`}
      >
        {props.report.value}
      </span>
    </div>
  );
}

/** "62% · resets in 2h 14m" — everything one account window has to say. */
function windowReport(window: QuotaWindow, now: number): LineReport {
  const used =
    window.usedFraction !== null ? `${Math.round(window.usedFraction * 100)}%` : "no figure";
  const left = countdown(window.resetsAt, now);
  return {
    value: left ? `${used} · resets in ${left}` : used,
    tone: (window.usedFraction ?? 0) >= 0.9 ? "hot" : "normal",
    title: windowTitle("claude", window),
  };
}

/** What an in-run rate-limit report can say: state and deadline, no fraction. */
function limitReport(limit: RateLimit, now: number): LineReport {
  const left = countdown(limit.resetsAt, now);
  if (limit.isBlocking) {
    return {
      value: left ? `limited · clears in ${left}` : "limited",
      tone: "blocked",
      title: limit.message,
    };
  }
  return {
    value: left ? `ok · resets in ${left}` : "ok",
    tone: "normal",
    title: `${limit.message} — the provider reports a state here, not a percentage.`,
  };
}

/** Everything the provider said about one window, for the hover. */
export function windowTitle(agent: string, window: QuotaWindow): string {
  const parts = [`${agent} · ${window.window}`];
  if (window.usedFraction !== null) {
    parts.push(`${Math.round(window.usedFraction * 100)}% used`);
  }
  if (window.windowMinutes) parts.push(`${Math.round(window.windowMinutes / 60)}h window`);
  if (window.resetsAt) parts.push(`resets ${window.resetsAt}`);
  return parts.join(" · ");
}

/** "62% · resets in 2h 14m", the Settings placeholder's row value. */
export function windowValue(window: QuotaWindow, now: number): string {
  const used =
    window.usedFraction !== null ? `${Math.round(window.usedFraction * 100)}%` : "no figure";
  const left = countdown(window.resetsAt, now);
  return left ? `${used} · resets in ${left}` : used;
}
