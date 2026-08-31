/**
 * The shape of `schema.generated.json`, which the `wt-schema` crate writes.
 *
 * A hand-written mirror rather than a generated one: the file is small, and a
 * second code generator to keep in step would cost more than it saves. The
 * crate's tests are what stop the JSON drifting from the schema; these types
 * are what stop the drawing drifting from the JSON.
 */

/** How the edge came to be known. See the crate's `relate` module. */
export type EdgeOrigin = "inferred" | "overlay";

/**
 * Whether the reference is always populated. WorkTable columns are not
 * nullable, so an absent reference is the empty string, and `optional` means
 * the source documents it as often empty.
 */
export type EdgeKind = "required" | "optional";

export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly primary_key: boolean;
  readonly generator: string | null;
  readonly optional: boolean;
  readonly index_backend: string | null;
  /** The `//` comment block above the column in the Rust source. */
  readonly doc: string;
}

export interface SchemaIndex {
  readonly name: string;
  readonly column: string;
  readonly unique: boolean;
  readonly backend: string | null;
}

export interface SchemaOperation {
  readonly name: string;
  readonly columns: readonly string[];
  readonly by: string;
}

export interface SchemaQueries {
  readonly updates: readonly SchemaOperation[];
  readonly deletes: readonly SchemaOperation[];
  readonly in_place: readonly SchemaOperation[];
}

export interface SchemaTable {
  /** The Rust identifier, e.g. `AgentIoRow`. */
  readonly name: string;
  /** The snake_case name the store uses, e.g. `agent_io_row`. */
  readonly table_name: string;
  readonly file: string;
  /** The `//!` module header. */
  readonly doc: string;
  readonly persist: boolean | null;
  readonly version: number | null;
  readonly partition_by: { readonly name: string; readonly type: string } | null;
  readonly page_size: number | null;
  /** In declaration order, which is the order rkyv writes them on disk. */
  readonly columns: readonly SchemaColumn[];
  readonly indexes: readonly SchemaIndex[];
  readonly queries: SchemaQueries;
}

export interface SchemaRelationship {
  readonly from_table: string;
  readonly from_column: string;
  readonly to_table: string;
  readonly to_column: string;
  readonly kind: EdgeKind;
  readonly origin: EdgeOrigin;
  readonly note: string;
}

export interface SchemaUnresolved {
  readonly table: string;
  readonly column: string;
  readonly suggestions: readonly string[];
}

export interface Schema {
  readonly tables: readonly SchemaTable[];
  readonly relationships: readonly SchemaRelationship[];
  readonly unresolved: readonly SchemaUnresolved[];
}
