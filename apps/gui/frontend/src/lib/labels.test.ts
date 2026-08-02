import { describe, expect, test } from "vitest";
import { ITEM_LADDER, nextStatus } from "~/lib/labels";
import type { ProjectStatus } from "~/types";

describe("the manual item status cycle", () => {
  test("includes every stored state and wraps", () => {
    const every: ProjectStatus[] = [
      "new",
      "pending",
      "planning",
      "active",
      "questions",
      "shipped",
      "finished",
      "canceled",
    ];
    expect(ITEM_LADDER).toEqual(every);
    expect(every.map(nextStatus)).toEqual([...every.slice(1), "new"]);
  });
});
