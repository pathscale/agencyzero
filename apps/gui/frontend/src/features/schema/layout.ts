/**
 * Placing the boxes and routing the edges. Pure, so it can be tested without
 * a renderer.
 *
 * # Why layered, and why the hub is on the left
 *
 * This schema is a hub: fifteen of seventeen tables carry a `project_id`. A
 * force-directed drawing of that is a hairball, and a grid is a lie about
 * which way the references point. Layering by reference depth puts what
 * everything depends on in the first column and its dependents to the right,
 * so every edge runs the same way and the direction carries meaning without
 * anyone reading an arrowhead.
 */

import type { Schema, SchemaColumn, SchemaRelationship, SchemaTable } from "./types";

/** Geometry, in the diagram's own units. One unit is one CSS pixel at 100%. */
export const BOX_WIDTH = 236;
export const HEADER_HEIGHT = 30;
export const ROW_HEIGHT = 19;
/** Room under the last row so the box does not look clipped. */
export const BOX_PADDING = 8;
export const COLUMN_GAP = 132;
export const ROW_GAP = 26;
export const MARGIN = 24;

export interface LaidOutRow {
  readonly column: SchemaColumn;
  /** Centre of the row, relative to the diagram origin. */
  readonly y: number;
  readonly isPrimaryKey: boolean;
  /** This column is the source of at least one relationship. */
  readonly isReference: boolean;
  /** A declared index covers this column. */
  readonly isIndexed: boolean;
}

export interface LaidOutBox {
  readonly table: SchemaTable;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly LaidOutRow[];
  /** Columns not drawn, when the view is compact. */
  readonly hiddenColumns: number;
  readonly depth: number;
}

export interface LaidOutEdge {
  readonly relationship: SchemaRelationship;
  /** An SVG cubic path from the source's left edge to the target's right. */
  readonly path: string;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}

export interface Diagram {
  readonly boxes: readonly LaidOutBox[];
  readonly edges: readonly LaidOutEdge[];
  readonly width: number;
  readonly height: number;
}

export interface LayoutOptions {
  /**
   * Draw only the columns that carry structure: the primary key, anything a
   * relationship starts from, and anything an index covers. `study_event` has
   * nineteen columns and two of them are edges; the full box is a wall of text
   * that makes the shape harder to see, not easier.
   */
  readonly compact: boolean;
}

/**
 * How far a table is from something nothing references onward.
 *
 * `project` and `kv` reference nothing, so they are depth 0. A table is one
 * deeper than the deepest thing it points at. Cycles are broken by refusing to
 * re-enter a table already on the stack: the answer is then arbitrary, but the
 * layout still terminates, which matters more than being right about a shape
 * this schema does not have.
 */
export function depths(schema: Schema): ReadonlyMap<string, number> {
  const targets = new Map<string, string[]>();
  for (const table of schema.tables) targets.set(table.table_name, []);
  for (const edge of schema.relationships) {
    if (edge.from_table === edge.to_table) continue;
    targets.get(edge.from_table)?.push(edge.to_table);
  }

  const resolved = new Map<string, number>();
  const visiting = new Set<string>();

  const walk = (name: string): number => {
    const known = resolved.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0;
    visiting.add(name);
    let depth = 0;
    for (const target of targets.get(name) ?? []) {
      depth = Math.max(depth, walk(target) + 1);
    }
    visiting.delete(name);
    resolved.set(name, depth);
    return depth;
  };

  for (const table of schema.tables) walk(table.table_name);
  return resolved;
}

function visibleColumns(
  table: SchemaTable,
  references: ReadonlySet<string>,
  compact: boolean,
): readonly SchemaColumn[] {
  if (!compact) return table.columns;
  const indexed = new Set(table.indexes.map((index) => index.column));
  return table.columns.filter(
    (column) =>
      column.primary_key ||
      indexed.has(column.name) ||
      references.has(`${table.table_name}.${column.name}`),
  );
}

/** Place every table and route every edge. */
export function layout(schema: Schema, options: LayoutOptions): Diagram {
  const depthOf = depths(schema);
  const references = new Set(
    schema.relationships.map((edge) => `${edge.from_table}.${edge.from_column}`),
  );

  const byDepth = new Map<number, SchemaTable[]>();
  for (const table of schema.tables) {
    const depth = depthOf.get(table.table_name) ?? 0;
    const column = byDepth.get(depth);
    if (column) column.push(table);
    else byDepth.set(depth, [table]);
  }

  const boxes: LaidOutBox[] = [];
  const orderedDepths = [...byDepth.keys()].sort((a, b) => a - b);

  for (const depth of orderedDepths) {
    const tables = (byDepth.get(depth) ?? [])
      .slice()
      .sort((a, b) => a.table_name.localeCompare(b.table_name));
    const x = MARGIN + depth * (BOX_WIDTH + COLUMN_GAP);
    let y = MARGIN;
    for (const table of tables) {
      const columns = visibleColumns(table, references, options.compact);
      const indexed = new Set(table.indexes.map((index) => index.column));
      const rows: LaidOutRow[] = columns.map((column, i) => ({
        column,
        y: y + HEADER_HEIGHT + i * ROW_HEIGHT + ROW_HEIGHT / 2,
        isPrimaryKey: column.primary_key,
        isReference: references.has(`${table.table_name}.${column.name}`),
        isIndexed: indexed.has(column.name),
      }));
      const height = HEADER_HEIGHT + columns.length * ROW_HEIGHT + BOX_PADDING;
      boxes.push({
        table,
        x,
        y,
        width: BOX_WIDTH,
        height,
        rows,
        hiddenColumns: table.columns.length - columns.length,
        depth,
      });
      y += height + ROW_GAP;
    }
  }

  const boxByName = new Map(boxes.map((box) => [box.table.table_name, box]));
  const edges: LaidOutEdge[] = [];

  for (const relationship of schema.relationships) {
    const from = boxByName.get(relationship.from_table);
    const to = boxByName.get(relationship.to_table);
    if (!from || !to) continue;

    const fromRow = from.rows.find((row) => row.column.name === relationship.from_column);
    const toRow = to.rows.find((row) => row.column.name === relationship.to_column);
    // A compact box may not be drawing the row the edge starts from; anchor on
    // the box's own middle rather than dropping the edge, so the reference is
    // still visible.
    const fromY = fromRow ? fromRow.y : from.y + from.height / 2;
    const toY = toRow ? toRow.y : to.y + to.height / 2;

    // Source is always at least one column right of its target, so the edge
    // leaves the left face and arrives at the right face.
    const fromX = from.x;
    const toX = to.x + to.width;
    const reach = Math.max(40, (fromX - toX) / 2);
    const path = `M ${fromX} ${fromY} C ${fromX - reach} ${fromY}, ${toX + reach} ${toY}, ${toX} ${toY}`;

    edges.push({ relationship, path, fromX, fromY, toX, toY });
  }

  const width = boxes.reduce((max, box) => Math.max(max, box.x + box.width), 0) + MARGIN;
  const height = boxes.reduce((max, box) => Math.max(max, box.y + box.height), 0) + MARGIN;
  return { boxes, edges, width, height };
}
