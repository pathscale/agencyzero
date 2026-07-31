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
  // Tested for being a number rather than for not being null, for the same
  // reason as `usageLabel` below: these arrive as JSON, an absent field is
  // `undefined`, and `undefined !== null` passes a null check while failing
  // every arithmetic that follows it.
  if (typeof entry.exitCode === "number" && entry.exitCode !== 0) return `exit ${entry.exitCode}`;
  if (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)) {
    return duration(entry.durationMs);
  }
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

  /*
   * Every field is checked for being a number rather than for not being null,
   * and that is not defensive noise. `usage` arrives as a JSON blob from a row
   * a previous build wrote, so a field can be missing outright — and `undefined
   * !== null` is true, which sent `.toFixed()` a value it could not format.
   *
   * The throw happened *during render*, so it did not merely blank the usage
   * chip: it took the transcript, and with it the window, which then sat on
   * "Loading workspace…" with nothing to say. A malformed number is worth an em
   * dash, never a dead workspace.
   */
  const count =
    typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : 0;
  const tokens = count >= 1000 ? `${(count / 1000).toFixed(1)}k tok` : `${count} tok`;

  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)) {
    return `${tokens} · $${usage.costUsd.toFixed(3)}`;
  }
  // Copilot bills in premium requests rather than dollars.
  if (typeof usage.premiumRequests === "number" && Number.isFinite(usage.premiumRequests)) {
    return `${tokens} · ${usage.premiumRequests} premium`;
  }
  return tokens;
}

/**
 * Whether a stop reason describes the provider having a bad moment rather than
 * the run being wrong.
 *
 * A 529/5xx from the API is weather: the prompt was fine, the session is fine,
 * and resending is the whole remedy. Painting it in the same red as a real
 * failure teaches people to ignore red. Matched on the status code the agent
 * quotes and on the words the API uses for itself, because the stop string is
 * assembled by the vendor CLI and has no stable shape to parse.
 */
export function isTransientStop(stop: string): boolean {
  return (
    /\(status 5\d\d\)|API Error: 5\d\d/i.test(stop) ||
    /overloaded|internal server error|service unavailable|try again in a moment/i.test(stop)
  );
}

/** "resets 14:20" on the rate-limit pill. */
export function clockTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * "2h 14m" — time left until `iso`, for the usage panel's reset countdowns.
 *
 * A countdown rather than a clock time: a deadline you have to subtract from
 * the current time is a deadline you misread. Minute-coarse, matching the
 * minute tick that redraws it, and `Math.ceil` so the last partial minute
 * reads as "1m" rather than a premature "now".
 */
export function countdown(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";

  const delta = at - now;
  if (delta <= 0) return "now";

  const minutes = Math.ceil(delta / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Bytes as a person reads them: `2.3 MB`, `412 KB`.
 *
 * Decimal units rather than binary, because this sits next to a disk figure the
 * OS also reports decimally — a table Finder calls 2.3 MB should not read 2.2
 * here. One decimal place above a megabyte, none below: `412.4 KB` is precision
 * nobody acts on.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}
