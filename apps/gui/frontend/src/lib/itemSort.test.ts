import { describe, expect, it } from "vitest";
import { sortItems } from "~/lib/itemSort";
import type { ProjectItem, ProjectStatus } from "~/types";

function item(id: string, status: ProjectStatus, order: number, updatedAt?: string): ProjectItem {
  return { id, projectId: "project", title: id, status, order, reference: null, updatedAt };
}

describe("item sorting", () => {
  const rows = [
    item("active", "active", 0, "2026-08-07T02:00:00Z"),
    item("new", "new", 1, "2026-08-07T03:00:00Z"),
    item("legacy-b", "planning", 3),
    item("legacy-a", "planning", 2),
  ];

  it("uses the workflow ladder rather than alphabetical status words", () => {
    expect(sortItems(rows, "status", "asc").map((row) => row.id)).toEqual([
      "new",
      "legacy-a",
      "legacy-b",
      "active",
    ]);
  });

  it("reverses known times but keeps unknown history last and stable", () => {
    expect(sortItems(rows, "time", "desc").map((row) => row.id)).toEqual([
      "new",
      "active",
      "legacy-b",
      "legacy-a",
    ]);
  });

  it("sorts an all-legacy list instead of leaving both directions identical", () => {
    const legacy = [item("first", "planning", 0), item("last", "planning", 1)];

    expect(sortItems(legacy, "time", "asc").map((row) => row.id)).toEqual(["first", "last"]);
    expect(sortItems(legacy, "time", "desc").map((row) => row.id)).toEqual(["last", "first"]);
  });
});
