//! Closed-store backup and restore operations for the restart angel.
//!
//! WorkTable owns memory-mapped indexes and asynchronous persistence workers.
//! Copying its directory while the GUI is alive can preserve a mixture of old
//! and new pages, even after a best-effort flush. These operations therefore run
//! only in angel mode, after the drained parent has exited and released the
//! store lock.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub(crate) const RESULT_ENV: &str = "AZ_STORE_MAINTENANCE_RESULT";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationResult {
    pub kind: String,
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreBackup {
    pub id: String,
    pub created_at: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreBackupStatus {
    pub backups: Vec<StoreBackup>,
    pub last_operation: Option<OperationResult>,
}

fn store_name(store: &Path) -> Result<&str, String> {
    store
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "the store path has no usable directory name".to_string())
}

fn sibling(store: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = store
        .parent()
        .ok_or_else(|| "the store path has no parent directory".to_string())?;
    Ok(parent.join(format!("{}{suffix}", store_name(store)?)))
}

fn backup_prefix(store: &Path) -> Result<String, String> {
    Ok(format!("{}.backup-", store_name(store)?))
}

pub(crate) fn new_backup_path(store: &Path) -> Result<PathBuf, String> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    sibling(store, &format!(".backup-{stamp}-{}", uuid::Uuid::new_v4()))
}

pub(crate) fn resolve_backup(store: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id == "."
        || id == ".."
        || Path::new(id).components().count() != 1
        || id.contains(std::path::MAIN_SEPARATOR)
    {
        return Err("the backup id is invalid".into());
    }
    sibling(store, &format!(".backup-{id}"))
}

pub(crate) fn is_backup_path(store: &Path, backup: &Path) -> bool {
    let (Some(parent), Some(candidate_parent), Ok(prefix), Some(name)) = (
        store.parent(),
        backup.parent(),
        backup_prefix(store),
        backup.file_name().and_then(|name| name.to_str()),
    ) else {
        return false;
    };
    backup.is_absolute()
        && store.is_absolute()
        && parent == candidate_parent
        && name.starts_with(&prefix)
        && name.len() > prefix.len()
}

pub(crate) fn status(store: &Path) -> Result<StoreBackupStatus, String> {
    let prefix = backup_prefix(store)?;
    let mut backups = Vec::new();
    let parent = store
        .parent()
        .ok_or_else(|| "the store path has no parent directory".to_string())?;

    if parent.is_dir() {
        for entry in std::fs::read_dir(parent).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(id) = name.strip_prefix(&prefix) else {
                continue;
            };
            if id.is_empty()
                || !entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_dir()
            {
                continue;
            }
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            let created_at = metadata
                .modified()
                .ok()
                .map(chrono::DateTime::<chrono::Utc>::from)
                .unwrap_or_else(chrono::Utc::now)
                .to_rfc3339();
            backups.push(StoreBackup {
                id: id.to_string(),
                created_at,
                bytes: directory_bytes(&entry.path())?,
            });
        }
    }
    backups.sort_by(|left, right| right.id.cmp(&left.id));

    let last_operation = std::env::var(RESULT_ENV)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(StoreBackupStatus {
        backups,
        last_operation,
    })
}

fn directory_bytes(path: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            total = total
                .checked_add(directory_bytes(&entry.path())?)
                .ok_or_else(|| "backup size overflowed u64".to_string())?;
        } else if kind.is_file() {
            total = total
                .checked_add(entry.metadata().map_err(|error| error.to_string())?.len())
                .ok_or_else(|| "backup size overflowed u64".to_string())?;
        } else {
            return Err(format!(
                "the store contains an unsupported filesystem entry: {}",
                entry.path().display()
            ));
        }
    }
    Ok(total)
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir(to).map_err(|error| {
        format!(
            "could not create backup directory {}: {error}",
            to.display()
        )
    })?;
    for entry in std::fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &target)
                .map_err(|error| format!("could not copy {}: {error}", entry.path().display()))?;
        } else {
            return Err(format!(
                "the store contains an unsupported filesystem entry: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    const CHUNK: usize = 64 * 1024;
    let mut left = std::fs::File::open(left).map_err(|error| error.to_string())?;
    let mut right = std::fs::File::open(right).map_err(|error| error.to_string())?;
    let mut left_buffer = [0_u8; CHUNK];
    let mut right_buffer = [0_u8; CHUNK];
    loop {
        let left_read = left
            .read(&mut left_buffer)
            .map_err(|error| error.to_string())?;
        let right_read = right
            .read(&mut right_buffer)
            .map_err(|error| error.to_string())?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn entries(path: &Path) -> Result<Vec<std::ffi::OsString>, String> {
    let mut names = std::fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    Ok(names)
}

fn verify_copy(source: &Path, copy: &Path) -> Result<(), String> {
    let source_entries = entries(source)?;
    let copy_entries = entries(copy)?;
    if source_entries != copy_entries {
        return Err("the backup verification found a different directory layout".into());
    }
    for name in source_entries {
        let source_entry = source.join(&name);
        let copy_entry = copy.join(&name);
        let source_kind = std::fs::symlink_metadata(&source_entry)
            .map_err(|error| error.to_string())?
            .file_type();
        let copy_kind = std::fs::symlink_metadata(&copy_entry)
            .map_err(|error| error.to_string())?
            .file_type();
        if source_kind.is_dir() && copy_kind.is_dir() {
            verify_copy(&source_entry, &copy_entry)?;
        } else if source_kind.is_file() && copy_kind.is_file() {
            if !files_equal(&source_entry, &copy_entry)? {
                return Err(format!(
                    "the backup verification found different bytes in {}",
                    source_entry.display()
                ));
            }
        } else {
            return Err(format!(
                "the backup verification found a mismatched entry at {}",
                source_entry.display()
            ));
        }
    }
    Ok(())
}

fn staging_path(store: &Path, label: &str) -> Result<PathBuf, String> {
    sibling(store, &format!(".{label}-{}", uuid::Uuid::new_v4()))
}

pub(crate) fn create(store: &Path, backup: &Path) -> Result<(), String> {
    if !store.is_dir() {
        return Err(format!("the store does not exist at {}", store.display()));
    }
    if !is_backup_path(store, backup) || backup.exists() {
        return Err("the backup target is invalid or already exists".into());
    }
    // Must not begin with `.backup-`: a crash can leave staging behind, and
    // the catalogue must never offer a half-copy as restorable.
    let staging = staging_path(store, "maintenance-backup-staging")?;
    let result = (|| {
        copy_dir_all(store, &staging)?;
        verify_copy(store, &staging)?;
        std::fs::rename(&staging, backup).map_err(|error| {
            format!(
                "could not publish verified backup {}: {error}",
                backup.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

pub(crate) fn restore(store: &Path, backup: &Path) -> Result<PathBuf, String> {
    if !store.is_dir() {
        return Err(format!("the store does not exist at {}", store.display()));
    }
    if !is_backup_path(store, backup) || !backup.is_dir() {
        return Err("the selected backup is invalid or missing".into());
    }

    let staging = staging_path(store, "restore-staging")?;
    let rollback = staging_path(store, "pre-restore")?;
    let result = (|| {
        copy_dir_all(backup, &staging)?;
        verify_copy(backup, &staging)?;
        std::fs::rename(store, &rollback).map_err(|error| {
            format!(
                "could not preserve the current store at {}: {error}",
                rollback.display()
            )
        })?;
        if let Err(error) = std::fs::rename(&staging, store) {
            let rollback_error = std::fs::rename(&rollback, store).err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "could not install the restore ({error}) or put the current store back ({rollback_error}); the current store remains at {} and the verified restore remains at {}",
                    rollback.display(),
                    staging.display()
                ),
                None => format!(
                    "could not install the restore: {error}; the current store was put back"
                ),
            });
        }
        Ok(rollback.clone())
    })();
    if result.is_err() && staging.exists() && store.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "az-backup-test-{}-{label}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).expect("scratch creates");
        path
    }

    fn write(path: &Path, body: &[u8]) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("parent creates");
        let mut file = std::fs::File::create(path).expect("file creates");
        file.write_all(body).expect("file writes");
    }

    #[test]
    fn a_backup_is_byte_verified_and_listed() {
        let root = scratch("create");
        let store = root.join("db");
        write(&store.join("message/.wt.data"), b"transcript");
        write(&store.join("message/primary.wt.idx"), b"index");
        let backup = new_backup_path(&store).expect("target");

        create(&store, &backup).expect("backup succeeds");
        verify_copy(&store, &backup).expect("copy verifies");
        let found = status(&store).expect("status");
        assert_eq!(found.backups.len(), 1);
        assert_eq!(found.backups[0].bytes, 15);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn verification_rejects_changed_bytes() {
        let root = scratch("verify");
        let source = root.join("source");
        let copy = root.join("copy");
        write(&source.join("table/.wt.data"), b"good");
        write(&copy.join("table/.wt.data"), b"evil");

        assert!(verify_copy(&source, &copy).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_keeps_the_displaced_store_as_a_rollback() {
        let root = scratch("restore");
        let store = root.join("db");
        write(&store.join("kv/.wt.data"), b"before");
        let backup = new_backup_path(&store).expect("target");
        create(&store, &backup).expect("backup succeeds");
        write(&store.join("kv/.wt.data"), b"after");

        let rollback = restore(&store, &backup).expect("restore succeeds");
        assert_eq!(std::fs::read(store.join("kv/.wt.data")).unwrap(), b"before");
        assert_eq!(
            std::fs::read(rollback.join("kv/.wt.data")).unwrap(),
            b"after"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_backup_id_cannot_escape_the_store_parent() {
        let store = Path::new("/tmp/agencyzero/db");
        assert!(resolve_backup(store, "../elsewhere").is_err());
        assert!(resolve_backup(store, "/absolute").is_err());
        assert!(resolve_backup(store, "known").is_ok());
    }
}
