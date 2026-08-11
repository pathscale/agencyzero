/**
 * How the streaming parse scales with reply length.
 *
 * Not part of the default suite: `vitest.config.ts` includes only
 * `*.test.ts`/`*.spec.ts`, so this runs on request and costs CI nothing.
 *
 * ```sh
 * bunx vitest run --include "src/**\/*.bench.ts"
 * ```
 *
 * It exists because every figure in `docs/js-engine-big-problem.md` is
 * arithmetic from reading source, and a plan built on arithmetic put a step
 * that wins nothing first. This measures the JS half directly: `MessageBody`
 * re-parses `props.body` on every token, so a reply of L characters arriving in
 * 4-character deltas calls `splitBlocks` L/4 times over a growing prefix.
 *
 * What it does not cover: the Boa string concatenation, and the DOM write. Both
 * are outside the frontend and neither can be reached from jsdom. This is the
 * parse only, which is the part the incremental-parse work has to move.
 */
import { describe, it } from "vitest";
import { createStreamingSplitter, splitBlocks } from "~/features/project/MessageBody";

/** A reply shaped like the ones agents actually send: prose, blank lines, no fences. */
function reply(chars: number): string {
  const paragraph =
    "The scan completed against the prod snapshot and the results are consistent " +
    "with the previous run, with one exception noted below that is worth reading " +
    "before the next deploy goes out to the fleet.";
  const parts: string[] = [];
  let total = 0;
  while (total < chars) {
    parts.push(paragraph);
    total += paragraph.length + 2;
  }
  return parts.join("\n\n").slice(0, chars);
}

/** Total time to parse every prefix, as a streaming render does. */
function streamCost(body: string, delta: number, parse: (body: string) => unknown): number {
  const started = performance.now();
  for (let at = delta; at <= body.length; at += delta) {
    parse(body.slice(0, at));
  }
  return performance.now() - started;
}

describe("streaming parse cost", () => {
  it("reports how the parse scales with reply length", () => {
    const DELTA = 4;
    const sizes = [5_000, 10_000, 20_000, 40_000];

    // One warm pass, discarded: the first call pays JIT and allocation costs
    // that belong to the harness rather than to the curve. Same discipline the
    // renderer benchmarks needed, where the first run after a launch read
    // several milliseconds high.
    streamCost(reply(2_000), DELTA, splitBlocks);

    const rows: string[] = [];
    let lastFull = 0;
    let lastIncremental = 0;
    for (const size of sizes) {
      const body = reply(size);
      const full = streamCost(body, DELTA, splitBlocks);
      const incremental = streamCost(body, DELTA, createStreamingSplitter());
      rows.push(
        [
          String(size).padStart(6),
          `${full.toFixed(1).padStart(8)} ms`,
          lastFull ? `x${(full / lastFull).toFixed(2)}` : "     ",
          `${incremental.toFixed(1).padStart(8)} ms`,
          lastIncremental ? `x${(incremental / lastIncremental).toFixed(2)}` : "     ",
          `${(full / incremental).toFixed(1)}x faster`,
        ].join("  "),
      );
      lastFull = full;
      lastIncremental = incremental;
    }

    // Printed rather than asserted. A threshold here would either be so loose it
    // proves nothing or so tight it fails on a busy machine; the number is for
    // reading, and the ratio columns are the shape. Doubling the body costs
    // about 4x when the work is quadratic and about 2x when it is linear.
    //
    // Printing *is* the output of a benchmark, which is the one place the
    // no-console rule does not apply.
    // biome-ignore lint/suspicious/noConsole: a benchmark reports by printing
    console.log(
      `\nstreaming reply, ${DELTA}-char deltas\n` +
        ` chars        full          incremental        gain\n${rows.join("\n")}\n`,
    );
  }, 120_000);
});
