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
  /** Summed: the new work each turn did. */
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
 * This mirrors `agent_abstraction::Usage::accumulate`, which exists because the
 * obvious loop is wrong:
 *
 * - **Summed** — `tokens`, `reasoningTokens`, `costUsd`, `premiumRequests`.
 *   New work each turn.
 * - **Latest** — `contextTokens`, `cacheReads`, `contextWindow`. These are
 *   already cumulative: the agent re-sends the whole conversation every turn and
 *   reports it, mostly as cache reads. Summing them counts the same conversation
 *   once per turn, and the error grows with the session.
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
    if (isNumber(usage.reasoningTokens)) totals.reasoningTokens += usage.reasoningTokens;
    if (isNumber(usage.costUsd)) totals.costUsd = (totals.costUsd ?? 0) + usage.costUsd;
    if (isNumber(usage.premiumRequests)) {
      totals.premiumRequests = (totals.premiumRequests ?? 0) + usage.premiumRequests;
    }

    // Latest wins for the context-shaped figures.
    if (isNumber(usage.contextTokens)) totals.contextTokens = usage.contextTokens;
    if (isNumber(usage.contextWindow)) totals.contextWindow = usage.contextWindow;
    if (isNumber(usage.cacheReads)) totals.cacheReads = usage.cacheReads;
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
