import { describe, expect, it } from "vitest";
import { sortItems, sortProjects } from "~/lib/itemSort";
import type { Project, ProjectItem, ProjectStatus } from "~/types";

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

  it("reverses rows that share a status or timestamp", () => {
    const tiedStatus = [item("first", "planning", 0), item("last", "planning", 1)];
    expect(sortItems(tiedStatus, "status", "asc").map((row) => row.id)).toEqual(["first", "last"]);
    expect(sortItems(tiedStatus, "status", "desc").map((row) => row.id)).toEqual(["last", "first"]);

    const tiedTime = tiedStatus.map((row) => ({ ...row, updatedAt: "2026-08-07T03:00:00Z" }));
    expect(sortItems(tiedTime, "time", "desc").map((row) => row.id)).toEqual(["last", "first"]);
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

describe("Home project sorting", () => {
  const project = (id: string, order: number): Project => ({
    id,
    name: id,
    status: "active",
    order,
    dirs: [],
    pinned: false,
    moderatorEnabled: false,
    forkedFrom: null,
    sessionId: null,
    sessions: {},
    lastActivityAt: "",
  });

  it("orders project groups by aggregate turns with durable order as the tie break", () => {
    const projects = [project("zero", 0), project("busy-later", 2), project("busy-earlier", 1)];
    const turns = { "busy-later": 7, "busy-earlier": 7 };

    expect(sortProjects(projects, "turns", "asc", turns).map((row) => row.id)).toEqual([
      "zero",
      "busy-earlier",
      "busy-later",
    ]);
    expect(sortProjects(projects, "turns", "desc", turns).map((row) => row.id)).toEqual([
      "busy-later",
      "busy-earlier",
      "zero",
    ]);
  });
});
