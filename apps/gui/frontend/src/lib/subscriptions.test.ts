import { describe, expect, it } from "vitest";
import { installSubscriptions, type SubscriptionFactory } from "~/lib/subscriptions";

describe("installSubscriptions", () => {
  it("starts every independent registration before waiting for acknowledgements", async () => {
    const releases: (() => void)[] = [];
    let started = 0;
    const factories: SubscriptionFactory[] = Array.from({ length: 4 }, () => async () => {
      started += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return () => undefined;
    });

    const installed = installSubscriptions(factories);
    await Promise.resolve();
    expect(started).toBe(4);
    for (const release of releases) release();
    await expect(installed).resolves.toHaveLength(4);
  });

  it("removes successful listeners when any registration fails", async () => {
    const removed: string[] = [];
    await expect(
      installSubscriptions([
        async () => () => removed.push("first"),
        async () => {
          throw new Error("registration refused");
        },
        async () => () => removed.push("third"),
      ]),
    ).rejects.toThrow("registration refused");
    expect(removed).toEqual(["first", "third"]);
  });

  it("treats an undefined rejection reason as a failure", async () => {
    const refused = Promise.reject(undefined);
    await expect(installSubscriptions([() => refused])).rejects.toBeUndefined();
  });
});
