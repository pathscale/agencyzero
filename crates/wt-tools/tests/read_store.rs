//! Round-trips through a real on-disk store: written with the same write
//! engine the GUI uses, read back through this crate's read-only path.

use std::path::{Path, PathBuf};

// `new` on the engine is a `PersistenceEngine` method and `load` a
// `PersistedWorkTable` one, so both traits have to be in scope even though
// nothing here names them.
use worktable::PersistedWorkTable;
use worktable::persistence::PersistenceEngine;
use worktable::prelude::DiskConfig;
use wt_tools::project::{ProjectPersistenceEngine, ProjectRow, ProjectWorkTable};
use wt_tools::project_item::{ProjectItemPersistenceEngine, ProjectItemRow, ProjectItemWorkTable};

/// A fresh directory per test, so parallel tests never share a store.
fn temp_store(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wt-tools-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn project(id: &str, name: &str, position: u32) -> ProjectRow {
    ProjectRow {
        id: id.into(),
        name: name.into(),
        status: "active".into(),
        position,
        dirs: r#"["/tmp/alpha"]"#.into(),
        pinned: false,
        moderator_enabled: false,
        forked_from: String::new(),
        last_activity_at: "2026-07-30T00:00:00Z".into(),
    }
}

fn item(id: &str, project_id: &str, title: &str, position: u32) -> ProjectItemRow {
    ProjectItemRow {
        id: id.into(),
        project_id: project_id.into(),
        title: title.into(),
        status: "pending".into(),
        position,
    }
}

/// Write rows the way the GUI writes them, then drop the table so the store is
/// closed — the "GUI not running" case.
async fn write_projects(dir: &Path, rows: Vec<ProjectRow>) {
    let config = DiskConfig::new_with_table_name(
        dir.to_string_lossy().to_string(),
        ProjectWorkTable::name_snake_case(),
        ProjectWorkTable::version(),
    );
    let engine = ProjectPersistenceEngine::new(config).await.unwrap();
    let table = ProjectWorkTable::load(engine).await.unwrap();
    for row in rows {
        table.insert(row).unwrap();
    }
    table.wait_for_ops().await;
}

async fn write_items(dir: &Path, rows: Vec<ProjectItemRow>) {
    let config = DiskConfig::new_with_table_name(
        dir.to_string_lossy().to_string(),
        ProjectItemWorkTable::name_snake_case(),
        ProjectItemWorkTable::version(),
    );
    let engine = ProjectItemPersistenceEngine::new(config).await.unwrap();
    let table = ProjectItemWorkTable::load(engine).await.unwrap();
    for row in rows {
        table.insert(row).unwrap();
    }
    table.wait_for_ops().await;
}

/// Every byte of every file under `dir`, so a read can be proven writeless.
fn store_bytes(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let bytes = std::fs::read(&path).unwrap();
                files.push((path, bytes));
            }
        }
    }
    files.sort();
    files
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projects_round_trip_without_writing() {
    let dir = temp_store("projects");
    write_projects(
        &dir,
        vec![project("proj-b", "Beta", 2), project("proj-a", "Alpha", 1)],
    )
    .await;

    let before = store_bytes(&dir);
    let table = wt_tools::open_projects(&dir).await.unwrap();
    let projects = wt_tools::list_projects(&table).unwrap();

    // Ordered by position, not by insertion or id.
    assert_eq!(projects.len(), 2);
    assert_eq!(projects[0].name, "Alpha");
    assert_eq!(projects[1].name, "Beta");
    // The JSON-encoded column comes back decoded.
    assert_eq!(projects[0].dirs, serde_json::json!(["/tmp/alpha"]));
    assert_eq!(projects[0].forked_from, serde_json::Value::Null);

    // The read-only path left every byte alone.
    assert_eq!(store_bytes(&dir), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn items_filter_and_search() {
    let dir = temp_store("items");
    write_items(
        &dir,
        vec![
            item("item-1", "proj-a", "Deploy the staging box", 1),
            item("item-2", "proj-a", "Write release notes", 2),
            item("item-3", "proj-b", "deploy production", 1),
        ],
    )
    .await;

    let table = wt_tools::open_items(&dir).await.unwrap();

    let all = wt_tools::list_items(&table, None).unwrap();
    assert_eq!(all.len(), 3);

    let only_a = wt_tools::list_items(&table, Some("proj-a")).unwrap();
    assert_eq!(only_a.len(), 2);
    assert!(only_a.iter().all(|item| item.project_id == "proj-a"));

    // Case-insensitive substring, across projects.
    let hits = wt_tools::search_items(&table, "DEPLOY").unwrap();
    let ids: Vec<&str> = hits.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, ["item-1", "item-3"]);

    assert!(
        wt_tools::search_items(&table, "nonexistent")
            .unwrap()
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_store_reads_empty_and_creates_nothing() {
    let dir = temp_store("missing").join("never-written");

    let table = wt_tools::open_items(&dir).await.unwrap();
    assert!(wt_tools::list_items(&table, None).unwrap().is_empty());

    // Graceful is not enough — the read must not have conjured a store the
    // GUI would later mistake for its own.
    assert!(!dir.exists());
}

/// The case the tool exists for: the GUI holds the store open while an agent
/// reads it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_while_a_writer_holds_the_store() {
    let dir = temp_store("held");

    let config = DiskConfig::new_with_table_name(
        dir.to_string_lossy().to_string(),
        ProjectWorkTable::name_snake_case(),
        ProjectWorkTable::version(),
    );
    let engine = ProjectPersistenceEngine::new(config).await.unwrap();
    let writer = ProjectWorkTable::load(engine).await.unwrap();
    writer.insert(project("proj-live", "Live", 1)).unwrap();
    writer.wait_for_ops().await;

    // Writer still open, exactly like a running GUI.
    let reader = wt_tools::open_projects(&dir).await.unwrap();
    let projects = wt_tools::list_projects(&reader).unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, "proj-live");

    drop(writer);
}

/// The binary end to end: env override in, JSON lines out.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_prints_json_lines() {
    let dir = temp_store("binary");
    write_projects(&dir, vec![project("proj-cli", "From the CLI", 1)]).await;

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_wt-tools"))
        .env("AZ_DATA_DIR", &dir)
        .arg("list-projects")
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 1);
    let row: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(row["id"], "proj-cli");
    assert_eq!(row["name"], "From the CLI");
}

#[test]
fn binary_rejects_unknown_commands_on_stderr() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_wt-tools"))
        .arg("frobnicate")
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unknown command"));
}
