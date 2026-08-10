//! Round-trips through a real on-disk store: written with the same write
//! engine the GUI uses, read back through this crate's read-only path.

use std::path::{Path, PathBuf};

// `new` on the engine is a `PersistenceEngine` method and `load` a
// `PersistedWorkTable` one, so both traits have to be in scope even though
// nothing here names them.
use agency_tools::kv::{KvPersistenceEngine, KvRow, KvWorkTable};
use agency_tools::project::{ProjectPersistenceEngine, ProjectRow, ProjectWorkTable};
use agency_tools::project_item::{
    ProjectItemPersistenceEngine, ProjectItemRow, ProjectItemWorkTable,
};
use worktable::PersistedWorkTable;
use worktable::persistence::PersistenceEngine;
use worktable::prelude::DiskConfig;

/// A fresh directory per test, so parallel tests never share a store.
fn temp_store(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("agency-tools-test-{}-{tag}", std::process::id()));
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
        reference: String::new(),
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
    table.wait_for_ops().await.expect("project rows persist");
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
    table
        .wait_for_ops()
        .await
        .expect("project item rows persist");
}

async fn write_descriptions(dir: &Path, rows: Vec<KvRow>) {
    let config = DiskConfig::new_with_table_name(
        dir.to_string_lossy().to_string(),
        KvWorkTable::name_snake_case(),
        KvWorkTable::version(),
    );
    let engine = KvPersistenceEngine::new(config).await.unwrap();
    let table = KvWorkTable::load(engine).await.unwrap();
    for row in rows {
        table.insert(row).unwrap();
    }
    table.wait_for_ops().await.expect("descriptions persist");
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
    let table = agency_tools::open_projects(&dir).await.unwrap();
    let projects = agency_tools::list_projects(&table).unwrap();

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
    write_descriptions(
        &dir,
        vec![KvRow {
            key: "item-context:item-2".into(),
            value: "Explain the release outcome".into(),
            updated_at: "2026-08-09T00:00:00Z".into(),
        }],
    )
    .await;

    let table = agency_tools::open_items(&dir).await.unwrap();
    let kv = agency_tools::open_kv(&dir).await.unwrap();

    let all = agency_tools::list_items(&table, None).unwrap();
    assert_eq!(all.len(), 3);

    let only_a = agency_tools::list_items(&table, Some("proj-a")).unwrap();
    assert_eq!(only_a.len(), 2);
    assert!(only_a.iter().all(|item| item.project_id == "proj-a"));

    let described = agency_tools::list_items_with_descriptions(&table, &kv, Some("proj-a"))
        .expect("descriptions join");
    assert_eq!(described[0].description, "");
    assert_eq!(described[1].description, "Explain the release outcome");

    // Case-insensitive substring, across projects.
    let hits = agency_tools::search_items(&table, "DEPLOY").unwrap();
    let ids: Vec<&str> = hits.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, ["item-1", "item-3"]);

    assert!(
        agency_tools::search_items(&table, "nonexistent")
            .unwrap()
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_sessions_report_ownership_and_explicit_resets() {
    let dir = temp_store("sessions");
    write_descriptions(
        &dir,
        vec![
            KvRow {
                key: "session:proj-a".into(),
                value: "claude-session".into(),
                updated_at: "2026-08-09T00:00:00Z".into(),
            },
            KvRow {
                key: "session:codex:proj-a".into(),
                value: String::new(),
                updated_at: "2026-08-10T00:00:00Z".into(),
            },
            KvRow {
                key: "session-run:run-a".into(),
                value: "not provider ownership".into(),
                updated_at: "2026-08-10T00:00:01Z".into(),
            },
        ],
    )
    .await;

    let kv = agency_tools::open_kv(&dir).await.unwrap();
    let sessions = agency_tools::list_sessions(&kv, Some("proj-a")).unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].agent, "claude");
    assert_eq!(sessions[0].session_id, "claude-session");
    assert_eq!(sessions[1].agent, "codex");
    assert_eq!(sessions[1].session_id, "");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_session_audit_names_and_deduplicates_recovery_candidates() {
    let dir = temp_store("session-audit");
    write_projects(&dir, vec![project("proj-a", "Research", 1)]).await;
    let projects = agency_tools::open_projects(&dir).await.unwrap();
    let current = vec![agency_tools::SessionOut {
        project_id: "proj-a".into(),
        agent: "codex".into(),
        session_id: String::new(),
        updated_at: "2026-08-10T00:00:00Z".into(),
    }];
    let recovered = agency_tools::SessionOut {
        project_id: "proj-a".into(),
        agent: "codex".into(),
        session_id: "019fe585-684c-7240-82b9-7b1a02d25983".into(),
        updated_at: "2026-08-09T17:27:05Z".into(),
    };
    let snapshots = vec![
        ("snapshot-1".into(), vec![recovered.clone()]),
        ("snapshot-2".into(), vec![recovered]),
    ];

    let report =
        agency_tools::session_recovery_report(&projects, &current, &snapshots, Some("proj-a"))
            .unwrap();

    assert_eq!(report.len(), 1);
    assert_eq!(report[0].project_name, "Research");
    assert_eq!(report[0].current_session_id, "");
    assert_eq!(report[0].action, "restore_snapshot_session");
    assert_eq!(report[0].snapshots, ["snapshot-1", "snapshot-2"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_store_reads_empty_and_creates_nothing() {
    let dir = temp_store("missing").join("never-written");

    let table = agency_tools::open_items(&dir).await.unwrap();
    assert!(agency_tools::list_items(&table, None).unwrap().is_empty());

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
    writer.wait_for_ops().await.expect("project rows persist");

    // Writer still open, exactly like a running GUI.
    let reader = agency_tools::open_projects(&dir).await.unwrap();
    let projects = agency_tools::list_projects(&reader).unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, "proj-live");

    drop(writer);
}

/// The binary end to end: env override in, JSON lines out.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binary_prints_json_lines() {
    let dir = temp_store("binary");
    write_projects(&dir, vec![project("proj-cli", "From the CLI", 1)]).await;

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_agency-tools"))
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
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_agency-tools"))
        .arg("frobnicate")
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unknown command"));
}
