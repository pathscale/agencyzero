import type { Message, RateLimit } from "~/types";

/**
 * Usage totals, added up from the turns that actually reported them.
 *
 * # Where the numbers come from
 *
 * Every figure is the agent's own, reported per finished turn as
 * `Outcome::usage` and stored on the message. **Nothing here computes a cost**;
 * `costUsd` is what the agent charged, and the crate is explicit that it never
 * infers one from a local price table.
 *
 * These are therefore this app's runs, not your account. Work done in another
 * client does not appear here — the account-level figures come from
 * `account_usage` instead. See `docs/agent-usage-surface.md`.
 */
export interface UsageTotals {
  /** Agent replies counted, whether or not they reported usage. */
  turns: number;
  /** Turns that reported usage. Below `turns` means the totals are partial. */
  reported: number;
  /** Summed: everything each turn processed, cache included. */
  tokens: number;
  /** Summed. */
  reasoningTokens: number;
  /** **Latest, not summed** — see the note on the fields below. */
  contextTokens: number | null;
  contextWindow: number | null;
  cacheReads: number | null;
  /** Null when no turn reported a cost, which is not the same as zero. */
  costUsd: number | null;
  premiumRequests: number | null;
}

const EMPTY: UsageTotals = {
  turns: 0,
  reported: 0,
  tokens: 0,
  reasoningTokens: 0,
  contextTokens: null,
  contextWindow: null,
  cacheReads: null,
  costUsd: null,
  premiumRequests: null,
};

/** True when the value is a real, finite number rather than a missing field. */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Add up the agent turns in `messages`.
 *
 * # Two kinds of field, and mixing them up inflates the numbers
 *
 * This follows `agent_abstraction::Usage::accumulate`, which exists because the
 * obvious loop is wrong:
 *
 * - **Summed** — `tokens`, `cacheReads`, `reasoningTokens`, `costUsd`,
 *   `premiumRequests`. What each turn processed and was charged for.
 * - **Latest** — `contextTokens`, `contextWindow`. Already cumulative: the
 *   agent re-sends the whole conversation every turn and reports its size.
 *   Summing them counts the same conversation once per turn, and the error
 *   grows with the session.
 *
 * `cacheReads` sits with the summed fields, and not — as it did here, and as
 * `accumulate` did before 0.4 — with the cumulative ones. A turn's cache figure
 * is not the conversation's size: Claude's terminal record already sums the
 * reads of every call in the turn, so it is billing-shaped and adds up across
 * turns. Taking the latest reported one turn's reads as the whole session's.
 *
 * Only `author: "agent"` counts. A user message has no usage, and counting it as
 * a turn would double every conversation.
 *
 * Cost stays null unless at least one turn priced itself: summing absent costs
 * into `0` would report a free session, and the crate is explicit that a guessed
 * cost is worse than no cost.
 */
export function usageTotals(messages: readonly Message[]): UsageTotals {
  const totals: UsageTotals = { ...EMPTY };

  for (const message of messages) {
    if (message.author !== "agent") continue;
    totals.turns += 1;

    const usage = message.usage;
    if (!usage) continue;
    totals.reported += 1;

    // Field by field, because rows written by older builds carry the crate's
    // own shape and every field can be absent. See `usageLabel`.
    if (isNumber(usage.tokens)) totals.tokens += usage.tokens;
    if (isNumber(usage.cacheReads)) totals.cacheReads = (totals.cacheReads ?? 0) + usage.cacheReads;
    if (isNumber(usage.reasoningTokens)) totals.reasoningTokens += usage.reasoningTokens;
    if (isNumber(usage.costUsd)) totals.costUsd = (totals.costUsd ?? 0) + usage.costUsd;
    if (isNumber(usage.premiumRequests)) {
      totals.premiumRequests = (totals.premiumRequests ?? 0) + usage.premiumRequests;
    }

    // Latest wins for the context-shaped figures.
    if (isNumber(usage.contextTokens)) totals.contextTokens = usage.contextTokens;
    if (isNumber(usage.contextWindow)) totals.contextWindow = usage.contextWindow;
  }

  return totals;
}

/**
 * Share of the context window in use, 0..1.
 *
 * Null unless the agent reported both the tokens and the window — today that
 * means Claude. Never derived from anything else: a context bar drawn from a
 * guess is exactly the number someone would act on.
 */
export function contextUsed(totals: UsageTotals): number | null {
  if (!isNumber(totals.contextTokens) || !isNumber(totals.contextWindow)) return null;
  if (totals.contextWindow <= 0) return null;
  return totals.contextTokens / totals.contextWindow;
}

/** Every project's messages, flattened, for the window-wide totals. */
export function allMessages(byProject: Record<string, Message[]>): Message[] {
  return Object.values(byProject).flat();
}

/** "1.2k" / "18.7k" / "412" — a token count at a glance. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

/** "$0.017" / "—" when nothing priced itself. */
export function costLabel(costUsd: number | null): string {
  return isNumber(costUsd) ? `$${costUsd.toFixed(3)}` : "—";
}

/** The three Claude limits the usage panel keeps a permanent line for. */
export type ClaudeWindowKind = "session" | "weekly" | "fable";

/**
 * Which fixed usage line a provider report belongs to, from its own wording —
 * "allowed (five_hour)", "opus_weekly", "weekly limit reached". Fable/Opus is
 * tested first because its window names contain "weekly" too. Null means the
 * wording names no window this panel models; the report is still shown, on a
 * line of its own.
 */
export function claudeWindowKind(text: string): ClaudeWindowKind | null {
  const wording = text.toLowerCase();
  if (/fable|opus/.test(wording)) return "fable";
  if (/five_hour|five-hour|5h|session/.test(wording)) return "session";
  if (/week|seven_day|7d/.test(wording)) return "weekly";
  return null;
}

/**
 * The quota windows the provider has actually told us about.
 *
 * Deduplicated by window — "five_hour" and "weekly" are separate limits and both
 * can be live — keeping the latest report for each. There is no way to ask for
 * these: they arrive only when a run happens to hit one, so an empty list means
 * "nothing has been reported", never "nothing is in force".
 */
export function quotaWindows(limits: readonly RateLimit[]): { window: string; limit: RateLimit }[] {
  const byWindow = new Map<string, RateLimit>();
  for (const limit of limits) {
    // The crate folds the window into the message; anything without one is
    // still worth showing, under its own wording.
    const key = limit.message || "limit";
    byWindow.set(key, limit);
  }
  return [...byWindow.entries()].map(([window, limit]) => ({ window, limit }));
}
