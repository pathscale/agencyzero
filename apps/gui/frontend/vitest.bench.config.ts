/**
 * Benchmarks, kept out of the default run.
 *
 * `vitest.config.ts` includes only `*.test.ts`/`*.spec.ts`, so a `*.bench.ts`
 * file costs CI nothing and runs on request: `bun run bench`. They print
 * numbers rather than asserting them, because a threshold tight enough to mean
 * something fails on a busy machine and one loose enough to pass proves
 * nothing.
 */
import base from "./vitest.config";

export default {
  ...base,
  test: { ...base.test, include: ["src/**/*.bench.ts"] },
};
