/**
 * The cost estimate and its guidance, computed locally from the backend's
 * price table.
 *
 * The number by the Send button updates as you type and on every model switch,
 * so it has to be instant — a Tauri round-trip per keystroke would lag the
 * composer. The backend owns the prices (one place to update); this module owns
 * the arithmetic, kept a mirror of `apps/gui/src/pricing.rs`.
 *
 * Every figure here is a projection. Nothing is priced until it runs, and the
 * real cost a turn reports afterwards always wins over the guess. The estimate
 * answers one question the real cost answers too late: is the next turn about
 * to be expensive, and what can I do about it.
 */
import type { PriceRow, PricingTable } from "~/types";

export type Severity = "low" | "warning" | "high";

export interface CostEstimate {
  /** False when the model isn't in the table — show "no price on file", not "$0.00". */
  priced: boolean;
  /** The resent conversation, mostly cache-served — the per-turn cost of a long session. */
  contextCost: number;
  /** The new prompt at full input price. */
  inputCost: number;
  /** The projected reply at output price — where the verbosity setting bites. */
  outputCost: number;
  /** context + input + output, the projected total for this one turn. */
  total: number;
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  severity: Severity;
  /** A model or provider switch cannot reuse the previous prompt cache. */
  coldContext: boolean;
}

/**
 * Roughly how many tokens a piece of text is. No tokenizer is shipped for
 * either provider and the real count comes back after the turn, so this is the
 * standard chars/4 rule of thumb — it errs high on code, the safe direction for
 * a "will this be expensive" warning.
 */
export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 4);
}

/**
 * Longest-key-first substring match, so `gpt-5.4-mini` resolves before
 * `gpt-5.4` and a dated/suffixed id (`claude-opus-4-8`, `gpt-5.6-terra-2026`)
 * still prices. The table arrives already ordered; we honour that order.
 */
function priceFor(table: PricingTable, model: string): PriceRow | undefined {
  const id = model.toLowerCase();
  return table.rows.find((row) => id.includes(row.key));
}

/**
 * How much output to assume. The app can't know the reply length in advance,
 * and under-guessing output (the priciest tokens) would make the estimate read
 * low exactly when a turn is about to be expensive — so this is a deliberately
 * generous fixed projection.
 */
export const ASSUMED_OUTPUT_TOKENS = 8_000;

/**
 * Estimate the next turn's cost.
 *
 * @param contextTokens size of the conversation the agent will resend, from the
 *   last turn's reported `contextTokens`; 0 on a fresh session. Billed as a
 *   cache read because on turn N>1 the prefix is warm.
 */
export function estimate(
  table: PricingTable,
  model: string,
  prompt: string,
  contextTokens: number,
  expectedOutput: number = ASSUMED_OUTPUT_TOKENS,
  coldContext = false,
): CostEstimate {
  const price = priceFor(table, model);
  if (!price) {
    return {
      priced: false,
      contextCost: 0,
      inputCost: 0,
      outputCost: 0,
      total: 0,
      contextTokens,
      inputTokens: estimateTokens(prompt),
      outputTokens: expectedOutput,
      severity: "low",
      coldContext,
    };
  }

  const perMillion = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;
  const inputTokens = estimateTokens(prompt);
  const contextRate = coldContext ? price.input * table.cacheWriteMultiple : price.cacheRead;
  const contextCost = perMillion(contextTokens, contextRate);
  const inputCost = perMillion(inputTokens, price.input);
  const outputCost = perMillion(expectedOutput, price.output);
  const total = contextCost + inputCost + outputCost;

  const severity: Severity =
    total >= table.highUsd ? "high" : total >= table.warnUsd ? "warning" : "low";

  return {
    priced: true,
    contextCost,
    inputCost,
    outputCost,
    total,
    contextTokens,
    inputTokens,
    outputTokens: expectedOutput,
    severity,
    coldContext,
  };
}

/**
 * The cost of running `/compact` once: read the whole conversation (warm, so
 * cache-read) and write a summary. Makes "compacting has a cost" concrete, and
 * lets the alert say whether a compaction pays for itself against the per-turn
 * context cost it removes.
 */
export function compactionCost(
  table: PricingTable,
  model: string,
  contextTokens: number,
  learnsFirst = true,
): number {
  const price = priceFor(table, model);
  if (!price) return 0;
  const SUMMARY_TOKENS = 4_000;
  const onePass =
    (contextTokens * price.cacheRead) / 1_000_000 + (SUMMARY_TOKENS * price.output) / 1_000_000;
  return onePass * (learnsFirst ? 2 : 1);
}

/** Additional cost for each 1K thinking tokens, billed at the model's output rate. */
export function thinkingCostPerThousand(table: PricingTable, model: string): number | null {
  const price = priceFor(table, model);
  return price ? price.output / 1_000 : null;
}

/**
 * The one-off cold-write cost of starting a fresh session: a new prefix is
 * billed at input × the cache-write premium, then later turns read it cheaply.
 * The counterweight to "keep continuing", whose context read is paid every turn.
 */
export function coldPrefixCost(table: PricingTable, model: string, prefixTokens: number): number {
  const price = priceFor(table, model);
  if (!price) return 0;
  return (prefixTokens * price.input * table.cacheWriteMultiple) / 1_000_000;
}

/**
 * Estimate what a *finished* turn cost, from the token figures it reported.
 *
 * For Claude this is never needed — the turn carries a real `costUsd`. It is
 * the Codex path: `agent-abstraction` reports Codex tokens but no cost, so a
 * dollar figure by a Codex reply can only be an estimate, and it is labelled as
 * one. Decomposed from what a turn reports: `cacheReads` at the cache rate,
 * the rest of the context at input rate, and the output (total processed minus
 * everything on the input side) at output rate. Returns null when the model
 * isn't priced or there is nothing to price.
 */
export function estimateTurnCost(
  table: PricingTable,
  model: string,
  usage: { tokens: number; contextTokens: number | null; cacheReads: number | null },
): number | null {
  const price = priceFor(table, model);
  if (!price) return null;
  const context = usage.contextTokens ?? 0;
  const cached = Math.min(usage.cacheReads ?? 0, context);
  const freshInput = Math.max(context - cached, 0);
  // Everything processed that wasn't input-side is the reply.
  const output = Math.max(usage.tokens - context, 0);
  const cost =
    (cached * price.cacheRead + freshInput * price.input + output * price.output) / 1_000_000;
  return cost > 0 ? cost : null;
}

/** A compact "$0.0042" / "$1.23" / "$12" label — precision scales with size. */
export function costLabel(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}
