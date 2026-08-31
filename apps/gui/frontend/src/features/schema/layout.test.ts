/**
 * The layout, checked against the real schema rather than a fixture.
 *
 * The drawing itself cannot be asserted, since that is what ps-qa is for, but
 * everything that makes it readable is arithmetic: boxes must not overlap,
 * every reference must reach a box, and an edge must run right-to-left so the
 * direction carries meaning without anyone reading an arrowhead.
 */

import { describe, expect, it } from "vitest";
import { depths, layout } from "./layout";
import generated from "./schema.generated.json";
import type { Schema } from "./types";

const schema = generated as unknown as Schema;

describe("schema layout", () => {
  it("puts the tables that reference nothing in the first column", () => {
    const depth = depths(schema);
    expect(depth.get("project")).toBe(0);
    expect(depth.get("kv")).toBe(0);
    // Everything with a project_id is at least one step out.
    expect(depth.get("message")).toBeGreaterThan(0);
    // `message_chunk` points at `message`, which points at `project`.
    expect(depth.get("message_chunk")).toBeGreaterThan(depth.get("message") ?? 0);
  });

  it("draws every table exactly once", () => {
    const diagram = layout(schema, { compact: true });
    expect(diagram.boxes).toHaveLength(schema.tables.length);
    const names = new Set(diagram.boxes.map((box) => box.table.table_name));
    expect(names.size).toBe(schema.tables.length);
  });

  it("never overlaps two boxes", () => {
    for (const compact of [true, false]) {
      const { boxes } = layout(schema, { compact });
      for (const a of boxes) {
        for (const b of boxes) {
          if (a === b) continue;
          const apart =
            a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y;
          expect(apart, `${a.table.table_name} overlaps ${b.table.table_name}`).toBe(true);
        }
      }
    }
  });

  it("routes every relationship, and always right to left", () => {
    const { edges } = layout(schema, { compact: true });
    expect(edges).toHaveLength(schema.relationships.length);
    for (const edge of edges) {
      expect(
        edge.fromX,
        `${edge.relationship.from_table} → ${edge.relationship.to_table} runs backwards`,
      ).toBeGreaterThan(edge.toX);
      expect(edge.path.startsWith("M ")).toBe(true);
    }
  });

  it("keeps every structural column visible when compact", () => {
    const { boxes } = layout(schema, { compact: true });
    const sources = new Set(
      schema.relationships.map((edge) => `${edge.from_table}.${edge.from_column}`),
    );
    for (const box of boxes) {
      const shown = new Set(box.rows.map((row) => row.column.name));
      expect(box.rows.some((row) => row.isPrimaryKey)).toBe(true);
      for (const column of box.table.columns) {
        if (sources.has(`${box.table.table_name}.${column.name}`)) {
          expect(shown, `${box.table.table_name}.${column.name} was hidden`).toContain(column.name);
        }
      }
    }
  });

  it("says how many columns a compact box is not showing", () => {
    const { boxes } = layout(schema, { compact: true });
    const studyEvent = boxes.find((box) => box.table.table_name === "study_event");
    expect(studyEvent).toBeDefined();
    expect(studyEvent?.hiddenColumns).toBe(
      (studyEvent?.table.columns.length ?? 0) - (studyEvent?.rows.length ?? 0),
    );
    expect(studyEvent?.hiddenColumns).toBeGreaterThan(0);

    // The full view hides nothing, by definition.
    const full = layout(schema, { compact: false });
    for (const box of full.boxes) expect(box.hiddenColumns).toBe(0);
  });
});
