/** Display helpers. Everything here is presentation only — no model logic. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "2 min ago" / "yesterday" — the Recent list and the agent-probe footer.
 *
 * Deliberately coarse: the exact second is never the point, and a ticking
 * relative timestamp is noise in a window you leave open all day.
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";

  const delta = now - then;
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`;
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.floor(delta / DAY);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** "0:41" — the elapsed counter on a running tool call. */
export function elapsed(startedAtIso: string, now = Date.now()): string {
  const started = Date.parse(startedAtIso);
  if (Number.isNaN(started)) return "0:00";

  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "41.2s" / "2m 14s" — how long a finished tool call took. */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * The right-hand meta on a task-log row: a duration when it succeeded, the
 * exit code when it did not. A failure's exit code is the useful number, and
 * "exit 101" reads at a glance where "0.4s" does not.
 */
export function taskMeta(entry: { durationMs: number | null; exitCode: number | null }): string {
  if (entry.exitCode !== null && entry.exitCode !== 0) return `exit ${entry.exitCode}`;
  if (entry.durationMs !== null) return duration(entry.durationMs);
  return "—";
}

/**
 * "18.7k tok · $0.017" for the composer.
 *
 * Usage is nullable on purpose: absent means "the agent did not report", which
 * is not the same as zero, so it renders as an em dash rather than "0 tok".
 */
export function usageLabel(
  usage: { tokens: number; costUsd: number | null; premiumRequests: number | null } | null,
): string {
  if (!usage) return "—";

  const tokens =
    usage.tokens >= 1000 ? `${(usage.tokens / 1000).toFixed(1)}k tok` : `${usage.tokens} tok`;

  if (usage.costUsd !== null) return `${tokens} · $${usage.costUsd.toFixed(3)}`;
  // Copilot bills in premium requests rather than dollars.
  if (usage.premiumRequests !== null) return `${tokens} · ${usage.premiumRequests} premium`;
  return tokens;
}

/** "resets 14:20" on the rate-limit pill. */
export function clockTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
