//! Profile-agnostic backup packages for the restart angel.
//!
//! WorkTable owns memory-mapped indexes and asynchronous persistence workers.
//! The store is therefore archived only after the drained GUI exits. Rows are
//! never decoded or re-encoded: the ZIP contains one small
//! JSON manifest plus the untouched WorkTable files under `store/`.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

pub(crate) const RESULT_ENV: &str = "AZ_STORE_MAINTENANCE_RESULT";
const PACKAGE_PREFIX: &str = "AgencyZero-backup-";
const PACKAGE_SUFFIX: &str = ".azbackup";
const PACKAGE_FORMAT: u32 = 1;
const SCHEMA_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
const STORE_PREFIX: &str = "store/";
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    app_version: String,
    /// Logical compatibility line for the rows inside the archive.
    ///
    /// Backups created before this field shipped are schema 1 too. Keeping the
    /// default makes a 0.2.30 package readable without weakening validation.
    #[serde(default = "schema_version_one")]
    schema_version: u32,
    schema_fingerprint: String,
    created_at: String,
    files: Vec<ManifestFile>,
}

const fn schema_version_one() -> u32 {
    SCHEMA_VERSION
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    bytes: u64,
    sha256: String,
}

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
    pub app_version: String,
    pub compatible: bool,
    pub incompatibility: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreBackupStatus {
    pub backups: Vec<StoreBackup>,
    pub last_operation: Option<OperationResult>,
}

fn sibling(store: &Path, name: &str) -> Result<PathBuf, String> {
    let parent = store
        .parent()
        .ok_or_else(|| "the store path has no parent directory".to_string())?;
    Ok(parent.join(name))
}

#[cfg(test)]
pub(crate) fn new_backup_path(store: &Path) -> Result<PathBuf, String> {
    sibling(store, &new_backup_file_name())
}

pub(crate) fn new_backup_file_name() -> String {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    format!(
        "{PACKAGE_PREFIX}{stamp}-{}{PACKAGE_SUFFIX}",
        uuid::Uuid::new_v4()
    )
}

pub(crate) fn is_package_path(package: &Path) -> bool {
    let (Some(parent), Some(name)) = (
        package.parent(),
        package.file_name().and_then(|name| name.to_str()),
    ) else {
        return false;
    };
    package.is_absolute()
        && parent.is_absolute()
        && name.ends_with(PACKAGE_SUFFIX)
        && name.len() > PACKAGE_SUFFIX.len()
}

pub(crate) fn check_restore(package: &Path) -> Result<(), String> {
    validate_archive(package).map(|_| ())
}

pub(crate) fn status(store: &Path) -> Result<StoreBackupStatus, String> {
    let mut backups = Vec::new();
    let parent = store
        .parent()
        .ok_or_else(|| "the store path has no parent directory".to_string())?;

    if parent.is_dir() {
        for entry in std::fs::read_dir(parent).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(id) = name
                .strip_prefix(PACKAGE_PREFIX)
                .and_then(|name| name.strip_suffix(PACKAGE_SUFFIX))
            else {
                continue;
            };
            if id.is_empty()
                || !entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_file()
            {
                continue;
            }

            let manifest = read_manifest(&entry.path());
            let compatibility = manifest.as_ref().map_err(Clone::clone).and_then(compatible);
            let (created_at, app_version, bytes) = manifest
                .as_ref()
                .map(|manifest| {
                    (
                        manifest.created_at.clone(),
                        manifest.app_version.clone(),
                        manifest.files.iter().map(|file| file.bytes).sum(),
                    )
                })
                .unwrap_or_else(|_| ("unknown".into(), "unknown".into(), 0));
            backups.push(StoreBackup {
                id: id.to_string(),
                created_at,
                bytes,
                app_version,
                compatible: compatibility.is_ok(),
                incompatibility: compatibility.err(),
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

fn compatible(manifest: &Manifest) -> Result<(), String> {
    if manifest.format_version != PACKAGE_FORMAT {
        return Err(format!(
            "backup format {} is not supported by this build (expected {PACKAGE_FORMAT})",
            manifest.format_version
        ));
    }
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "backup schema version {} is not supported by this build (expected {SCHEMA_VERSION})",
            manifest.schema_version
        ));
    }
    if manifest.schema_fingerprint != crate::db::tables::SCHEMA_FINGERPRINT {
        return Err("backup schema does not exactly match this build".into());
    }
    Ok(())
}

fn read_manifest(package: &Path) -> Result<Manifest, String> {
    let file = std::fs::File::open(package)
        .map_err(|error| format!("could not open backup package: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("backup package is not a readable ZIP: {error}"))?;
    let mut entry = archive
        .by_name(MANIFEST_FILE)
        .map_err(|_| "backup package has no manifest.json".to_string())?;
    if entry.size() > MAX_MANIFEST_BYTES {
        return Err("backup manifest is unreasonably large".into());
    }
    let mut raw = String::new();
    entry
        .read_to_string(&mut raw)
        .map_err(|error| format!("could not read backup manifest: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("backup manifest is invalid: {error}"))
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn store_files(store: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    fn walk(root: &Path, current: &Path, files: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
        for entry in std::fs::read_dir(current).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_dir() {
                walk(root, &entry.path(), files)?;
            } else if kind.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .components()
                    .map(|component| match component {
                        Component::Normal(name) => name
                            .to_str()
                            .map(ToOwned::to_owned)
                            .ok_or_else(|| "the store contains a non-UTF-8 path".to_string()),
                        _ => Err("the store contains an unsafe relative path".to_string()),
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .join("/");
                files.push((relative, entry.path()));
            } else {
                return Err(format!(
                    "the store contains an unsupported filesystem entry: {}",
                    entry.path().display()
                ));
            }
        }
        Ok(())
    }

    if !store.is_dir() {
        return Err(format!("the store does not exist at {}", store.display()));
    }
    let mut files = Vec::new();
    walk(store, store, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn write_archive(store: &Path, package: &Path) -> Result<(), String> {
    let output = std::fs::File::create(package)
        .map_err(|error| format!("could not create backup package: {error}"))?;
    let mut archive = zip::ZipWriter::new(output);
    let options = SimpleFileOptions::default()
        // DEFLATE is the one compressed ZIP method supported by the built-in
        // archive tools on Windows, macOS and ordinary Linux desktops.
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let mut records = Vec::new();

    for (relative, source) in store_files(store)? {
        archive
            .start_file(format!("{STORE_PREFIX}{relative}"), options)
            .map_err(|error| format!("could not add {relative} to backup: {error}"))?;
        let mut source = std::fs::File::open(&source)
            .map_err(|error| format!("could not read {}: {error}", source.display()))?;
        let mut digest = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
            archive
                .write_all(&buffer[..read])
                .map_err(|error| format!("could not write backup data: {error}"))?;
            bytes = bytes
                .checked_add(read as u64)
                .ok_or_else(|| "backup size overflowed u64".to_string())?;
        }
        records.push(ManifestFile {
            path: relative,
            bytes,
            sha256: hex(digest.finalize()),
        });
    }

    let manifest = Manifest {
        format_version: PACKAGE_FORMAT,
        app_version: az_core::VERSION.into(),
        schema_version: SCHEMA_VERSION,
        schema_fingerprint: crate::db::tables::SCHEMA_FINGERPRINT.into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        files: records,
    };
    archive
        .start_file(MANIFEST_FILE, options)
        .map_err(|error| format!("could not add backup manifest: {error}"))?;
    archive
        .write_all(
            &serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("could not encode backup manifest: {error}"))?,
        )
        .map_err(|error| format!("could not write backup manifest: {error}"))?;
    archive
        .finish()
        .map_err(|error| format!("could not finish backup ZIP: {error}"))?;
    Ok(())
}

fn checksum_reader(reader: &mut impl Read) -> Result<(u64, String), String> {
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        bytes = bytes
            .checked_add(read as u64)
            .ok_or_else(|| "backup size overflowed u64".to_string())?;
    }
    Ok((bytes, hex(digest.finalize())))
}

fn validate_archive(package: &Path) -> Result<Manifest, String> {
    let manifest = read_manifest(package)?;
    compatible(&manifest)?;
    let mut expected = BTreeMap::new();
    for file in &manifest.files {
        if !safe_relative(&file.path) || expected.insert(file.path.clone(), file).is_some() {
            return Err("backup manifest contains a duplicate or unsafe path".into());
        }
    }

    let file = std::fs::File::open(package).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut manifest_count = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().to_string();
        if entry.enclosed_name().is_none() || entry.is_dir() {
            return Err("backup ZIP contains an unsafe or unexpected entry".into());
        }
        if name == MANIFEST_FILE {
            manifest_count += 1;
            continue;
        }
        let Some(relative) = name.strip_prefix(STORE_PREFIX) else {
            return Err(format!("backup ZIP contains unexpected entry {name}"));
        };
        let Some(record) = expected.remove(relative) else {
            return Err(format!("backup ZIP contains unmanifested entry {name}"));
        };
        let (bytes, sha256) = checksum_reader(&mut entry)?;
        if bytes != record.bytes || sha256 != record.sha256 {
            return Err(format!("backup integrity check failed for {relative}"));
        }
    }
    if manifest_count != 1 || !expected.is_empty() {
        return Err("backup ZIP is missing its manifest or a declared store file".into());
    }
    Ok(manifest)
}

fn verify_store(store: &Path, manifest: &Manifest) -> Result<(), String> {
    let actual = store_files(store)?;
    if actual.len() != manifest.files.len() {
        return Err("restored store has a different file count".into());
    }
    for ((path, file), record) in actual.iter().zip(&manifest.files) {
        if path != &record.path {
            return Err("restored store has a different directory layout".into());
        }
        let mut file = std::fs::File::open(file).map_err(|error| error.to_string())?;
        let (bytes, sha256) = checksum_reader(&mut file)?;
        if bytes != record.bytes || sha256 != record.sha256 {
            return Err(format!("restored store verification failed for {path}"));
        }
    }
    Ok(())
}

fn load_store_tables(store: &Path) -> Result<(), String> {
    let runtime = tokio::runtime::Runtime::new()
        .map_err(|error| format!("could not start backup validation: {error}"))?;
    let tables = runtime
        .block_on(crate::db::tables::Tables::open(store))
        .map_err(|error| format!("restored WorkTable store would not open: {error}"))?;
    runtime
        .block_on(tables.shutdown())
        .map_err(|error| format!("restored WorkTable store would not drain: {error}"))?;
    drop(tables);
    Ok(())
}

#[cfg(not(test))]
fn validate_store_loads(store: &Path) -> Result<(), String> {
    load_store_tables(store)
}

// Package unit tests use minimal byte fixtures rather than constructing all
// WorkTable tables. Production restores always execute the loader above.
#[cfg(test)]
fn validate_store_loads(_store: &Path) -> Result<(), String> {
    Ok(())
}

fn staging_path(store: &Path, label: &str) -> Result<PathBuf, String> {
    let name = store
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "the store path has no UTF-8 directory name".to_string())?;
    sibling(store, &format!("{name}.{label}-{}", uuid::Uuid::new_v4()))
}

fn package_staging_path(package: &Path) -> Result<PathBuf, String> {
    let parent = package
        .parent()
        .ok_or_else(|| "the backup target has no parent directory".to_string())?;
    Ok(parent.join(format!(
        ".AgencyZero-backup-staging-{}",
        uuid::Uuid::new_v4()
    )))
}

pub(crate) fn create(store: &Path, backup: &Path) -> Result<(), String> {
    if !store.is_absolute() || !is_package_path(backup) || backup.exists() {
        return Err("the backup target is invalid or already exists".into());
    }
    let staging = package_staging_path(backup)?;
    let result = (|| {
        write_archive(store, &staging)?;
        validate_archive(&staging)?;
        std::fs::rename(&staging, backup).map_err(|error| {
            format!(
                "could not publish verified backup {}: {error}",
                backup.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

pub(crate) fn restore(store: &Path, backup: &Path) -> Result<PathBuf, String> {
    if !store.is_absolute() || !store.is_dir() {
        return Err(format!("the store does not exist at {}", store.display()));
    }
    if !is_package_path(backup) || !backup.is_file() {
        return Err("the selected backup is invalid or missing".into());
    }

    let manifest = validate_archive(backup)?;
    let staging = staging_path(store, "restore-staging")?;
    let rollback = staging_path(store, "pre-restore")?;
    let result = (|| {
        std::fs::create_dir(&staging).map_err(|error| error.to_string())?;
        let file = std::fs::File::open(backup).map_err(|error| error.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
        for record in &manifest.files {
            let mut entry = archive
                .by_name(&format!("{STORE_PREFIX}{}", record.path))
                .map_err(|error| format!("could not read {}: {error}", record.path))?;
            let target = staging.join(&record.path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut output = std::fs::File::create(&target)
                .map_err(|error| format!("could not create {}: {error}", target.display()))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|error| format!("could not extract {}: {error}", record.path))?;
        }
        verify_store(&staging, &manifest)?;
        // Loading every table catches damaged indexes and invalid row shapes
        // before the current profile's store is moved out of the way. Verify
        // again afterwards so validation itself cannot silently change bytes.
        validate_store_loads(&staging)?;
        verify_store(&staging, &manifest)?;

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
    use std::io::{Seek, SeekFrom};

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
        std::fs::write(path, body).expect("file writes");
    }

    fn sample_store(root: &Path) -> PathBuf {
        let store = root.join("db");
        write(&store.join("message/.wt.data"), b"transcript");
        write(&store.join("message/primary.wt.idx"), b"index");
        store
    }

    #[test]
    fn a_backup_is_one_verified_profile_agnostic_archive() {
        let root = scratch("create");
        let store = sample_store(&root);
        let backup = new_backup_path(&store).expect("target");

        create(&store, &backup).expect("backup succeeds");
        assert!(backup.is_file());
        assert_eq!(validate_archive(&backup).expect("valid").files.len(), 2);
        let found = status(&store).expect("status");
        assert_eq!(found.backups.len(), 1);
        assert_eq!(found.backups[0].bytes, 15);
        assert_eq!(found.backups[0].app_version, az_core::VERSION);
        assert!(found.backups[0].compatible);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn semantic_preflight_opens_and_drains_a_real_worktable_store() {
        let root = scratch("semantic");
        let store = root.join("db");
        let runtime = tokio::runtime::Runtime::new().expect("runtime starts");
        let tables = runtime
            .block_on(crate::db::tables::Tables::open(&store))
            .expect("real store opens");
        runtime
            .block_on(tables.stamp_schema())
            .expect("schema stamps");
        runtime.block_on(tables.shutdown()).expect("store drains");
        drop(tables);
        drop(runtime);

        load_store_tables(&store).expect("restore preflight accepts the real store");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn integrity_check_rejects_changed_archive_bytes() {
        let root = scratch("integrity");
        let store = sample_store(&root);
        let backup = new_backup_path(&store).expect("target");
        create(&store, &backup).expect("backup succeeds");

        let data_start = {
            let file = std::fs::File::open(&backup).unwrap();
            let mut archive = zip::ZipArchive::new(file).unwrap();
            archive
                .by_name("store/message/.wt.data")
                .unwrap()
                .data_start()
        };
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&backup)
            .unwrap();
        file.seek(SeekFrom::Start(data_start)).unwrap();
        file.write_all(b"X").unwrap();
        drop(file);
        write(&store.join("message/.wt.data"), b"current-store-stays");

        assert!(validate_archive(&backup).is_err());
        assert!(restore(&store, &backup).is_err());
        assert_eq!(
            std::fs::read(store.join("message/.wt.data")).unwrap(),
            b"current-store-stays"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn app_versions_are_metadata_but_other_schemas_are_refused() {
        let files = Vec::new();
        let base = Manifest {
            format_version: PACKAGE_FORMAT,
            app_version: az_core::VERSION.into(),
            schema_version: SCHEMA_VERSION,
            schema_fingerprint: crate::db::tables::SCHEMA_FINGERPRINT.into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            files,
        };
        let mut newer = base.clone();
        newer.app_version = "999.0.0".into();
        compatible(&newer).expect("app version does not define store compatibility");

        let mut older = base.clone();
        older.app_version = "0.0.1".into();
        compatible(&older).expect("app version does not define store compatibility");

        let mut other_schema_version = base.clone();
        other_schema_version.schema_version += 1;
        assert!(
            compatible(&other_schema_version)
                .unwrap_err()
                .contains("schema version")
        );

        let mut other_schema = base;
        other_schema.schema_fingerprint = "different".into();
        assert!(compatible(&other_schema).unwrap_err().contains("schema"));
    }

    #[test]
    fn a_manifest_without_schema_version_is_schema_one() {
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "formatVersion": PACKAGE_FORMAT,
            "appVersion": "0.2.30",
            "schemaFingerprint": crate::db::tables::SCHEMA_FINGERPRINT,
            "createdAt": "2026-08-07T00:00:00Z",
            "files": []
        }))
        .expect("legacy manifest parses");

        assert_eq!(manifest.schema_version, SCHEMA_VERSION);
        compatible(&manifest).expect("legacy schema-one backup stays compatible");
    }

    #[test]
    fn restore_keeps_the_displaced_store_as_a_rollback() {
        let root = scratch("restore");
        let store = sample_store(&root);
        let backup = new_backup_path(&store).expect("target");
        create(&store, &backup).expect("backup succeeds");
        write(&store.join("message/.wt.data"), b"after");

        let rollback = restore(&store, &backup).expect("restore succeeds");
        assert_eq!(
            std::fs::read(store.join("message/.wt.data")).unwrap(),
            b"transcript"
        );
        assert_eq!(
            std::fs::read(rollback.join("message/.wt.data")).unwrap(),
            b"after"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_package_moves_between_profile_roots_without_changing() {
        let root = scratch("profiles");
        let experimental = root.join("experimental");
        let normal = root.join("normal");
        let shared = root.join("shared");
        std::fs::create_dir(&shared).expect("shared directory creates");
        let source_store = sample_store(&experimental);
        let target_store = sample_store(&normal);
        write(&target_store.join("message/.wt.data"), b"normal-before");
        let package = shared.join("experimental-to-normal.azbackup");
        create(&source_store, &package).expect("backup succeeds");
        let package_bytes = std::fs::read(&package).expect("package reads");

        assert!(check_restore(&package).is_ok());
        let rollback = restore(&target_store, &package).expect("cross-profile restore succeeds");
        assert_eq!(
            std::fs::read(target_store.join("message/.wt.data")).unwrap(),
            b"transcript"
        );
        assert_eq!(
            std::fs::read(rollback.join("message/.wt.data")).unwrap(),
            b"normal-before"
        );
        assert_eq!(std::fs::read(&package).unwrap(), package_bytes);

        let _ = std::fs::remove_dir_all(root);
    }
}
