//! Persistence, laid out the way `api.support.cafe` lays it out.
//!
//! Three layers, kept apart on purpose:
//!
//! | Layer | Where | What it holds |
//! |---|---|---|
//! | **Schema** | [`schema`] | One `worktable!` per entity: columns, indexes, and the queries that entity supports. Plus `From<Row>` conversions to the wire types. Nothing else. |
//! | **Tables** | [`tables`] | Opening every table against a directory, and holding them together as one value the app can carry. |
//! | **Usage** | the commands in `crate::main` | Reads and writes, expressed as calls into the generated queries. No `worktable!` and no engine setup. |
//!
//! The separation is what keeps a schema change from rippling: a new column or a
//! new index is one file in `schema/`, and `tables.rs` only changes when a table
//! is added or removed.
//!
//! **The `worktable!` macro emits code naming `eyre`, `rkyv`, `derive_more`,
//! `futures` and `uuid` by bare path**, so those are direct dependencies of this
//! crate even though nothing here imports them.

pub mod schema;
pub mod tables;
