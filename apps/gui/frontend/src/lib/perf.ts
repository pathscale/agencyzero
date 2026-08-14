/**
 * Application internal performance: a table of what things cost, kept live.
 *
 * Modelled on the profiler in `web3.trading-backend`: one global map keyed by
 * name, each entry holding count, min, max and a running total, updated in
 * place. The write path is a map lookup and five number operations, which is
 * cheap enough to leave switched on rather than reach for when something is
 * already slow.
 *
 * It replaces per-event log lines. Those answer "what did this one take", which
 * is the wrong question once a thing happens hundreds of times: a tab switch,
 * a command, a timeline rebuild. A table answers how often, how bad at worst,
 * and what it usually is, which is what a decision needs.
 *
 * Nothing here formats or renders. Reading is `snapshot()`, called when someone
 * opens the panel, so the collector never does work for a table nobody is
 * looking at.
 */

export type PerfEntry = {
  name: string;
  count: number;
  /** Milliseconds. */
  min: number;
  max: number;
  total: number;
  /** The most recent sample, which is what a slider or a keypress just cost. */
  last: number;
};

const entries = new Map<string, PerfEntry>();
let startedAt = Date.now();

/**
 * Record one sample.
 *
 * Deliberately takes a duration rather than wrapping the work: several of the
 * things worth measuring here span a frame boundary or an await, and a wrapper
 * would have to lie about where they end.
 */
export function record(name: string, ms: number): void {
  const existing = entries.get(name);
  if (existing === undefined) {
    entries.set(name, { name, count: 1, min: ms, max: ms, total: ms, last: ms });
    return;
  }
  existing.count += 1;
  existing.total += ms;
  existing.last = ms;
  if (ms < existing.min) existing.min = ms;
  if (ms > existing.max) existing.max = ms;
}

/** Time a synchronous call and record it. Returns whatever the work returned. */
export function measure<T>(name: string, work: () => T): T {
  const from = performance.now();
  try {
    return work();
  } finally {
    record(name, performance.now() - from);
  }
}

/** A stopwatch, for work that finishes somewhere the caller cannot wrap. */
export function start(name: string): () => void {
  const from = performance.now();
  let stopped = false;
  return () => {
    // Guarded because these are handed to frame callbacks and event handlers,
    // where firing twice is a normal outcome rather than a bug worth throwing
    // over. A double stop would otherwise record a second, much larger sample.
    if (stopped) return;
    stopped = true;
    record(name, performance.now() - from);
  };
}

/** Every entry, worst total first: the order a reader wants them in. */
export function snapshot(): { since: number; entries: PerfEntry[] } {
  return {
    since: startedAt,
    entries: [...entries.values()].sort((left, right) => right.total - left.total),
  };
}

export function reset(): void {
  entries.clear();
  startedAt = Date.now();
}
