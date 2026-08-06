import { describe, expect, test } from "vitest";
import { ITEM_LADDER, nextStatus } from "~/lib/labels";
import type { ProjectStatus } from "~/types";

describe("the manual item status cycle", () => {
  test("ITEM_LADDER still names every stored state, for display", () => {
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
  });

  test("the marker click cycles the working states and never lands on a terminal one", () => {
    // The click cycle loops within the visible working set: shipped wraps back
    // to new, and the two terminal states are not part of it, so a click can
    // never push a row into finished/canceled where it would drop out of view
    // and read as a delete. Explicit actions and agent directives may still
    // choose either terminal state.
    const working: ProjectStatus[] = [
      "new",
      "pending",
      "planning",
      "active",
      "questions",
      "shipped",
    ];
    expect(working.map(nextStatus)).toEqual([...working.slice(1), "new"]);
    // A terminal state re-enters the cycle rather than advancing to the other
    // terminal state.
    expect(nextStatus("finished")).toBe("new");
    expect(nextStatus("canceled")).toBe("new");
  });
});
