import { countdown } from "~/lib/format";
import type { QuotaWindow } from "~/types";

/**
 * Formatting for the account-usage rows in Settings.
 *
 * This file once held a per-project "Claude usage" panel fed by in-run
 * rate-limit heartbeats. That was a dead end — Claude does not put its
 * per-window percentages on the wire (see `docs/agent-usage-surface.md`), so
 * the lines mostly read "no report yet". Durable spend now lives in the
 * usage-ledger table and Settings' Cost section; what remains here serves the
 * Account usage placeholder until the provider interface is exposed.
 */

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

/** "62% used · resets in 2h 14m", the Settings placeholder's row value. */
export function windowValue(window: QuotaWindow, now: number): string {
  const used =
    window.usedFraction !== null ? `${Math.round(window.usedFraction * 100)}% used` : "no figure";
  const left = countdown(window.resetsAt, now);
  return left ? `${used} · resets in ${left}` : used;
}
