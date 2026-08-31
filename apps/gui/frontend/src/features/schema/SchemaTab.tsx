import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Button } from "~/components/Button";
import { tx } from "~/stores/i18n";
import { type LaidOutBox, layout } from "./layout";
import generated from "./schema.generated.json";
import type { Schema, SchemaTable } from "./types";

/**
 * The store's shape, drawn: every `worktable!` in `apps/gui/src/db/schema`, its
 * columns, and the references between them.
 *
 * # Read-only, deliberately
 *
 * This draws the schema; it does not edit it. WorkTable persists rows with
 * rkyv, positionally, and nothing on disk records which columns produced them,
 * so a table whose columns change reads every existing row through the new
 * layout without an error anywhere, every field shifted by one. That is not a
 * hypothetical: it happened to `project_item` on 2026-08-01, and
 * `docs/store-recovery.md` is the account of the afternoon it cost. A designer
 * that writes a `worktable!` must also drive `SCHEMA_FINGERPRINT` and the
 * migration, or it is a data-loss tool with a nice diagram.
 *
 * # Where the edges come from
 *
 * The DSL declares no foreign keys, and `project_id` is a `String` like any other
 * column. So the edges are proposed by the reader from naming and corrected by
 * hand in `schema.overlay.json`, and the two are drawn differently on purpose:
 * a solid line is a convention holding up, a dashed one is somebody's decision.
 * Rendering them identically would claim a certainty nobody has.
 *
 * The data is a committed JSON file rather than a Tauri command, so the diagram
 * renders in the browser fixture with no build and no instance, and a schema
 * change arrives in review as a diff of the drawing's input. Regenerate with
 * `scripts/generate-schema.sh` after touching `apps/gui/src/db/schema`.
 */
const schema = generated as unknown as Schema;

const MIN_SCALE = 0.35;
const MAX_SCALE = 2.2;

/** Short type badge: `String` is most of the store, so it is worth shrinking. */
function typeLabel(type: string, optional: boolean): string {
  const short = type === "String" ? "str" : type;
  return optional ? `${short}?` : short;
}

export function SchemaTab(): JSX.Element {
  const [compact, setCompact] = createSignal(true);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [hovered, setHovered] = createSignal<string | null>(null);
  const [scale, setScale] = createSignal(0.8);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });

  const diagram = createMemo(() => layout(schema, { compact: compact() }));

  const selectedTable = createMemo<SchemaTable | null>(() => {
    const name = selected();
    if (!name) return null;
    return schema.tables.find((table) => table.table_name === name) ?? null;
  });

  /** Edges touching the focused table, so hovering a box lights up its family. */
  const focused = createMemo(() => hovered() ?? selected());

  const isLit = (from: string, to: string): boolean => {
    const name = focused();
    return name === null || from === name || to === name;
  };

  const reset = (): void => {
    setScale(0.8);
    setPan({ x: 0, y: 0 });
  };

  let dragging: { x: number; y: number; panX: number; panY: number } | null = null;

  const onPointerDown = (event: PointerEvent): void => {
    // Only a drag on empty canvas pans; a drag that starts on a box would
    // otherwise swallow the click that selects it.
    if ((event.target as Element).closest("[data-table]")) return;
    dragging = { x: event.clientX, y: event.clientY, panX: pan().x, panY: pan().y };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    setPan({
      x: dragging.panX + (event.clientX - dragging.x),
      y: dragging.panY + (event.clientY - dragging.y),
    });
  };

  const onPointerUp = (): void => {
    dragging = null;
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale() * (event.deltaY < 0 ? 1.1 : 0.9)));
    setScale(next);
  };

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-3">
      <header class="flex shrink-0 flex-wrap items-center gap-2">
        <div class="min-w-0">
          <div class="font-medium text-[12.5px] text-az-title">{tx("Store schema")}</div>
          <div class="text-[10.5px] text-az-muted">
            {tx("{tables} tables, {references} references, read from {path}", {
              tables: schema.tables.length,
              references: schema.relationships.length,
              path: "apps/gui/src/db/schema",
            })}
          </div>
        </div>
        <div class="flex flex-1 items-center justify-end gap-1.5">
          <Button
            class="rounded-lg border border-az-hairline px-2.5 py-1 text-[11px]"
            aria-label={compact() ? tx("Show all columns") : tx("Show key columns only")}
            aria-pressed={compact() ? "false" : "true"}
            onClick={() => {
              setCompact((value) => !value);
            }}
          >
            {compact() ? tx("All columns") : tx("Key columns")}
          </Button>
          <Button
            class="rounded-lg border border-az-hairline px-2.5 py-1 text-[11px]"
            aria-label={tx("Reset the diagram view")}
            onClick={reset}
          >
            {tx("Reset view")}
          </Button>
        </div>
      </header>

      <div class="flex min-h-0 min-w-0 flex-1 gap-2">
        <svg
          class="az-scroll min-h-0 min-w-0 flex-1 touch-none rounded-panel border border-az-hairline bg-az-sunken"
          role="img"
          aria-label={tx("WorkTable schema diagram")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <title>{tx("WorkTable schema diagram")}</title>
          <defs>
            <marker
              id="az-schema-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" class="fill-az-muted" />
            </marker>
          </defs>

          <g transform={`translate(${pan().x} ${pan().y}) scale(${scale()})`}>
            <For each={diagram().edges}>
              {(edge) => (
                <path
                  d={edge.path}
                  fill="none"
                  class={
                    isLit(edge.relationship.from_table, edge.relationship.to_table)
                      ? "stroke-az-muted"
                      : "stroke-az-hairline"
                  }
                  stroke-width={1.2}
                  // An overlay edge is a person's decision rather than a naming
                  // convention, and the dash is the only thing saying so.
                  stroke-dasharray={edge.relationship.origin === "overlay" ? "5 3" : undefined}
                  stroke-opacity={edge.relationship.kind === "optional" ? 0.55 : 1}
                  marker-end="url(#az-schema-arrow)"
                >
                  <title>
                    {`${edge.relationship.from_table}.${edge.relationship.from_column} → ` +
                      `${edge.relationship.to_table}.${edge.relationship.to_column}` +
                      ` (${edge.relationship.kind}, ${edge.relationship.origin})` +
                      (edge.relationship.note ? `\n${edge.relationship.note}` : "")}
                  </title>
                </path>
              )}
            </For>

            <For each={diagram().boxes}>
              {(box) => (
                <TableBox
                  box={box}
                  selected={selected() === box.table.table_name}
                  onSelect={() => setSelected(box.table.table_name)}
                  onHover={setHovered}
                />
              )}
            </For>
          </g>
        </svg>

        <Show when={selectedTable()}>
          {(table) => (
            <aside
              class="az-scroll w-[320px] shrink-0 overflow-y-auto rounded-panel border border-az-hairline bg-base-100 p-3.5"
              aria-label={tx("Details for {table}", { table: table().table_name })}
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="truncate font-mono font-semibold text-[12.5px] text-az-title">
                    {table().table_name}
                  </div>
                  <div class="truncate text-[10px] text-az-muted">
                    {table().name} · {table().file}
                  </div>
                </div>
                <Button
                  class="rounded-lg border border-az-hairline px-2 py-0.5 text-[10.5px]"
                  aria-label={tx("Close table details")}
                  onClick={() => setSelected(null)}
                >
                  {tx("Close")}
                </Button>
              </div>

              <Show when={table().doc}>
                <p class="mt-2.5 whitespace-pre-wrap text-[10.5px] text-az-muted leading-relaxed">
                  {table().doc}
                </p>
              </Show>

              <Section title={tx("Columns")}>
                <For each={table().columns}>
                  {(column) => (
                    <div class="rounded-lg border border-az-hairline px-2.5 py-1.5">
                      <div class="flex items-baseline justify-between gap-2">
                        <span class="truncate font-mono text-[11px] text-az-strong">
                          {column.name}
                          <Show when={column.primary_key}>
                            <span class="ml-1 text-[9px] text-primary">{tx("PK")}</span>
                          </Show>
                        </span>
                        <span class="shrink-0 font-mono text-[10px] text-az-muted">
                          {typeLabel(column.type, column.optional)}
                        </span>
                      </div>
                      <Show when={column.doc}>
                        <p class="mt-1 whitespace-pre-wrap text-[10px] text-az-muted leading-snug">
                          {column.doc}
                        </p>
                      </Show>
                    </div>
                  )}
                </For>
              </Section>

              <Show when={table().indexes.length > 0}>
                <Section title={tx("Indexes")}>
                  <For each={table().indexes}>
                    {(index) => (
                      <div class="rounded-lg border border-az-hairline px-2.5 py-1.5 font-mono text-[10.5px] text-az-strong">
                        {tx("{name} on {column}", { name: index.name, column: index.column })}
                        <Show when={index.unique}>
                          <span class="ml-1 text-[9px] text-primary">{tx("UNIQUE")}</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </Section>
              </Show>

              <Show
                when={
                  table().queries.updates.length +
                    table().queries.deletes.length +
                    table().queries.in_place.length >
                  0
                }
              >
                <Section title={tx("Queries")}>
                  <For
                    each={[
                      ...table().queries.updates.map((op) => ({ kind: tx("update"), op })),
                      ...table().queries.in_place.map((op) => ({ kind: tx("in place"), op })),
                      ...table().queries.deletes.map((op) => ({ kind: tx("delete"), op })),
                    ]}
                  >
                    {(entry) => (
                      <div class="rounded-lg border border-az-hairline px-2.5 py-1.5">
                        <div class="font-mono text-[10.5px] text-az-strong">
                          {entry.op.name}({entry.op.columns.join(", ")})
                        </div>
                        <div class="mt-0.5 font-mono text-[9.5px] text-az-muted">
                          {tx("{kind} by {column}", { kind: entry.kind, column: entry.op.by })}
                        </div>
                      </div>
                    )}
                  </For>
                </Section>
              </Show>

              <Section title={tx("References")}>
                <For
                  each={schema.relationships.filter(
                    (edge) =>
                      edge.from_table === table().table_name ||
                      edge.to_table === table().table_name,
                  )}
                >
                  {(edge) => (
                    <div class="rounded-lg border border-az-hairline px-2.5 py-1.5">
                      <div class="font-mono text-[10.5px] text-az-strong">
                        {edge.from_table}.{edge.from_column} → {edge.to_table}.{edge.to_column}
                      </div>
                      <div class="mt-0.5 text-[9.5px] text-az-muted">
                        {edge.kind} ·{" "}
                        {edge.origin === "overlay"
                          ? tx("declared in the overlay")
                          : tx("inferred from naming")}
                      </div>
                      <Show when={edge.note}>
                        <p class="mt-1 text-[10px] text-az-muted leading-snug">{edge.note}</p>
                      </Show>
                    </div>
                  )}
                </For>
              </Section>
            </aside>
          )}
        </Show>
      </div>

      <footer class="flex shrink-0 flex-wrap items-center gap-3 text-[10px] text-az-muted">
        <span class="flex items-center gap-1.5">
          <svg width="26" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="26" y2="3" class="stroke-az-muted" stroke-width="1.2" />
          </svg>
          {tx("inferred from naming")}
        </span>
        <span class="flex items-center gap-1.5">
          <svg width="26" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="26"
              y2="3"
              class="stroke-az-muted"
              stroke-width="1.2"
              stroke-dasharray="5 3"
            />
          </svg>
          {tx("declared in the overlay")}
        </span>
        <span>{tx("faded line: often empty, never enforced")}</span>
        <span class="ml-auto">{tx("drag to pan, scroll to zoom, click a table for detail")}</span>
      </footer>
    </div>
  );
}

function Section(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="mt-3">
      <div class="mb-1.5 font-medium text-[10px] text-az-muted uppercase tracking-wide">
        {props.title}
      </div>
      <div class="flex flex-col gap-1.5">{props.children}</div>
    </div>
  );
}

function TableBox(props: {
  box: LaidOutBox;
  selected: boolean;
  onSelect: () => void;
  onHover: (name: string | null) => void;
}): JSX.Element {
  return (
    /*
     * A <button> is not valid SVG content, and the box has to be a <g> so its
     * rect and text move together. The role plus the label is what makes it
     * addressable by name, which is how docs/ui-verification.md says to reach
     * a control.
     */
    // biome-ignore lint/a11y/useSemanticElements: a <button> cannot hold SVG
    <g
      data-table={props.box.table.table_name}
      class="cursor-pointer"
      role="button"
      tabindex={0}
      aria-label={tx("Table {table}", { table: props.box.table.table_name })}
      onClick={props.onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") props.onSelect();
      }}
      onPointerEnter={() => props.onHover(props.box.table.table_name)}
      onPointerLeave={() => props.onHover(null)}
    >
      <rect
        x={props.box.x}
        y={props.box.y}
        width={props.box.width}
        height={props.box.height}
        rx={8}
        class={props.selected ? "fill-base-100 stroke-primary" : "fill-base-100 stroke-az-hairline"}
        stroke-width={props.selected ? 1.8 : 1}
      />
      <rect
        x={props.box.x}
        y={props.box.y}
        width={props.box.width}
        height={30}
        rx={8}
        class="fill-base-200/60"
      />
      <text
        x={props.box.x + 10}
        y={props.box.y + 19}
        class="fill-az-title font-mono"
        font-size="11.5"
        font-weight="600"
      >
        {props.box.table.table_name}
      </text>

      <For each={props.box.rows}>
        {(row) => (
          <>
            <text
              x={props.box.x + 10}
              y={row.y + 3.5}
              class={row.isPrimaryKey ? "fill-primary font-mono" : "fill-az-strong font-mono"}
              font-size="10"
            >
              {row.column.name}
            </text>
            <text
              x={props.box.x + props.box.width - 10}
              y={row.y + 3.5}
              text-anchor="end"
              class="fill-az-muted font-mono"
              font-size="9"
            >
              {typeLabel(row.column.type, row.column.optional)}
              {row.isPrimaryKey ? " PK" : row.isIndexed ? " IX" : ""}
            </text>
          </>
        )}
      </For>

      <Show when={props.box.hiddenColumns > 0}>
        <text
          x={props.box.x + 10}
          y={props.box.y + props.box.height - 1}
          class="fill-az-muted font-mono italic"
          font-size="9"
        >
          {tx("+{count} more", { count: props.box.hiddenColumns })}
        </text>
      </Show>
    </g>
  );
}
