//! The reader, checked against the GUI's own schema directory.
//!
//! # Why the fingerprint is the assertion
//!
//! Counting tables and columns proves the parser ran. It does not prove it read
//! the right thing: a parser that dropped a column would still report a number,
//! and the number would still be a number.
//!
//! `apps/gui/src/db/fingerprint.rs` states every table's name and column list,
//! in order, as a hand-maintained string that exists precisely so that changing
//! a schema without noticing is impossible. Nothing generates it from these
//! files, so it is an independent statement of the same fact. Reconstructing it
//! from the parse is therefore a real check: a missed column, a reordered one,
//! or a table read under the wrong name all break it, and each of them breaks it
//! by name.
//!
//! It also means this test fails the day someone adds a column and forgets the
//! fingerprint bump, which is the exact mistake that cost this repository a
//! table on 2026-08-01.

use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/wt-schema is two levels below the workspace root")
        .to_path_buf()
}

fn schema_dir() -> PathBuf {
    repo_root().join("apps/gui/src/db/schema")
}

/// The `SCHEMA_FINGERPRINT` constant, reassembled from the `concat!` literals
/// it is written as.
fn gui_fingerprint() -> String {
    let source = std::fs::read_to_string(repo_root().join("apps/gui/src/db/fingerprint.rs"))
        .expect("the GUI's fingerprint module is readable");
    let start = source
        .find("pub const SCHEMA_FINGERPRINT")
        .expect("SCHEMA_FINGERPRINT is declared");
    let body = &source[start..];
    // Not the first `);`: the literals themselves contain one, as in
    // `"kv(key,value,updated_at);"`. The `concat!` closes on its own line.
    let end = body.find("\n);").expect("the concat! is closed");

    let mut out = String::new();
    let mut rest = &body[..end];
    while let Some(open) = rest.find('"') {
        rest = &rest[open + 1..];
        let close = rest.find('"').expect("a string literal is closed");
        out.push_str(&rest[..close]);
        rest = &rest[close + 1..];
    }
    out
}

#[test]
fn reads_every_table_in_the_gui_schema_directory() {
    let schema = wt_schema::read_dir(&schema_dir()).expect("the GUI schema directory parses");

    // One `worktable!` per file, and `mod.rs` declares none.
    assert_eq!(
        schema.tables.len(),
        17,
        "expected 17 tables, found {}",
        schema.tables.len()
    );

    for table in &schema.tables {
        assert!(!table.columns.is_empty(), "{} has no columns", table.name);
        assert!(
            table.primary_key().is_some(),
            "{} declares no primary key",
            table.name
        );
        assert_eq!(
            table.persist,
            Some(true),
            "{} is not marked `persist: true`; every table in this store is persisted",
            table.name
        );
    }
}

#[test]
fn every_parsed_table_matches_the_gui_fingerprint() {
    let schema = wt_schema::read_dir(&schema_dir()).expect("the GUI schema directory parses");
    let fingerprint = gui_fingerprint();

    for table in &schema.tables {
        let segment = table.fingerprint_segment();
        assert!(
            fingerprint.contains(&segment),
            "`{segment}` is not in SCHEMA_FINGERPRINT.\n\
             Either this reader misread {}, or the schema changed without the \
             fingerprint bump that db/fingerprint.rs requires.",
            table.file
        );
    }
}

#[test]
fn the_fingerprint_names_no_table_the_reader_missed() {
    let schema = wt_schema::read_dir(&schema_dir()).expect("the GUI schema directory parses");
    let fingerprint = gui_fingerprint();

    // The fingerprint is `name(cols);` repeated, so counting terminators counts
    // tables. This is the direction the previous test cannot cover: it would
    // pass while the reader quietly skipped a whole file.
    let declared = fingerprint.matches(");").count();
    assert_eq!(
        declared,
        schema.tables.len(),
        "SCHEMA_FINGERPRINT names {declared} tables, the reader found {}",
        schema.tables.len()
    );
}

#[test]
fn comments_above_columns_survive_the_token_stream() {
    let schema = wt_schema::read_dir(&schema_dir()).expect("the GUI schema directory parses");
    let task_log = schema
        .tables
        .iter()
        .find(|t| t.table_name == "task_log")
        .expect("task_log is one of the tables");
    let ok = task_log
        .columns
        .iter()
        .find(|c| c.name == "ok")
        .expect("task_log has an `ok` column");

    // `//` comments are not doc attributes; the lexer drops them, so this only
    // passes because they are recovered by line number.
    assert!(
        ok.doc.contains("-1 unknown"),
        "the comment above `ok` was lost: {:?}",
        ok.doc
    );
    assert!(
        task_log.doc.starts_with("Finished tool calls"),
        "the module header was lost: {:?}",
        task_log.doc
    );
}

#[test]
fn naming_inference_finds_the_project_edges_and_admits_what_it_cannot() {
    let schema = wt_schema::read_dir(&schema_dir()).expect("the GUI schema directory parses");

    let to_project = schema
        .relationships
        .iter()
        .filter(|r| r.to_table == "project" && r.from_column == "project_id")
        .count();
    // Every table but `project` itself and `kv`, the untyped settings blob.
    assert_eq!(
        to_project, 15,
        "expected 15 tables to carry a project_id; found {to_project}"
    );

    // `item_id` really does mean `project_item`, and inference must not pretend
    // to know that. It reports the column with the suggestion instead.
    let item = schema
        .unresolved
        .iter()
        .find(|u| u.table == "message" && u.column == "item_id")
        .expect("message.item_id is reported as unresolved, not silently dropped");
    assert_eq!(item.suggestions, vec!["project_item".to_string()]);
}

#[test]
fn the_overlay_resolves_what_inference_reported() {
    let overlay_path =
        repo_root().join("apps/gui/frontend/src/features/schema/schema.overlay.json");
    let overlay: wt_schema::Overlay = serde_json::from_str(
        &std::fs::read_to_string(&overlay_path).expect("the overlay is readable"),
    )
    .expect("the overlay is valid JSON in the expected shape");

    let schema = wt_schema::read_dir_with(&schema_dir(), &overlay).expect("the schema parses");

    assert!(
        schema.unresolved.is_empty(),
        "the overlay is meant to account for every unresolved column; still open: {:?}",
        schema
            .unresolved
            .iter()
            .map(|u| format!("{}.{}", u.table, u.column))
            .collect::<Vec<_>>()
    );

    let item_edge = schema
        .relationships
        .iter()
        .find(|r| r.from_table == "message" && r.from_column == "item_id")
        .expect("the overlay supplies message.item_id");
    assert_eq!(item_edge.to_table, "project_item");
    assert_eq!(item_edge.origin, wt_schema::Origin::Overlay);
    assert_eq!(item_edge.kind, wt_schema::Kind::Optional);
}
