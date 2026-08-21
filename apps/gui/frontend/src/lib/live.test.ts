/**
 * The guard exists to stop a late `.then()` writing into a disposed scope,
 * which Solid 2 rejects as `REACTIVE_WRITE_IN_OWNED_SCOPE` and then escalates
 * to `REACTIVITY_HALTED`, freezing the whole app. So the test that matters is
 * the disposal one: resolve after `dispose()` and assert nothing ran.
 */

import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { whileMounted } from "./live";

describe("whileMounted", () => {
  it("runs the callback while the owner is alive", () => {
    createRoot((dispose) => {
      const alive = whileMounted();
      const seen: string[] = [];
      alive((value: string) => seen.push(value))("landed");
      expect(seen).toEqual(["landed"]);
      dispose();
    });
  });

  it("drops a callback that arrives after disposal", () => {
    let guarded: (value: string) => void = () => undefined;
    const seen: string[] = [];

    createRoot((dispose) => {
      const alive = whileMounted();
      guarded = alive((value: string) => seen.push(value));
      dispose();
    });

    // The promise this stands in for resolved after the pane was torn down.
    guarded("late");
    expect(seen).toEqual([]);
  });

  it("passes every argument through untouched", () => {
    createRoot((dispose) => {
      const alive = whileMounted();
      let got: unknown[] = [];
      alive((...args: unknown[]) => {
        got = args;
      })(1, "two", { three: true });
      expect(got).toEqual([1, "two", { three: true }]);
      dispose();
    });
  });

  it("gates every callback made from one gate, not just the first", () => {
    const seen: string[] = [];
    let first: () => void = () => undefined;
    let second: () => void = () => undefined;

    createRoot((dispose) => {
      const alive = whileMounted();
      first = alive(() => seen.push("first"));
      second = alive(() => seen.push("second"));
      dispose();
    });

    first();
    second();
    expect(seen).toEqual([]);
  });
});
