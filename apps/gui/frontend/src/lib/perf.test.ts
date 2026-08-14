import { beforeEach, describe, expect, it } from "vitest";
import { record, reset, snapshot, start } from "~/lib/perf";

describe("internal performance table", () => {
  beforeEach(() => reset());

  it("aggregates repeated samples rather than keeping each one", () => {
    record("tab switch", 10);
    record("tab switch", 30);
    record("tab switch", 20);

    const [entry] = snapshot().entries;
    expect(entry.name).toBe("tab switch");
    expect(entry.count).toBe(3);
    expect(entry.min).toBe(10);
    expect(entry.max).toBe(30);
    expect(entry.total).toBe(60);
    // The last sample is kept separately: it is what the thing just did, which
    // an average over a whole session hides.
    expect(entry.last).toBe(20);
  });

  /*
   * Worst total first, not worst single sample. Something costing 2ms four
   * hundred times is a bigger problem than something costing 200ms once, and
   * ordering by max would bury it.
   */
  it("orders by total cost", () => {
    record("rare but slow", 200);
    for (let index = 0; index < 400; index += 1) record("cheap but constant", 2);

    expect(snapshot().entries.map((entry) => entry.name)).toEqual([
      "cheap but constant",
      "rare but slow",
    ]);
  });

  /*
   * `start` handles work that finishes in a frame callback or an event handler,
   * where being called twice is a normal outcome. A second stop would otherwise
   * record a much larger sample measured from the same origin.
   */
  it("ignores a stopwatch stopped twice", () => {
    const stop = start("pane build");
    stop();
    stop();

    expect(snapshot().entries[0].count).toBe(1);
  });

  it("reports nothing before anything is measured", () => {
    expect(snapshot().entries).toEqual([]);
  });
});
