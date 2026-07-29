//! Where the tables live, and how that is overridden.
//!
//! # Why this is not a setting
//!
//! Settings are a row in the database, so the database's location cannot be one
//! of them: reading it would need the database already open at the location we
//! are trying to look up. The override therefore lives outside the database, in
//! a one-line pointer file that is read before anything else.
//!
//! Resolution order, first hit wins:
//!
//! 1. `AZ_DATA_DIR`, for tests and CI, which need a location without writing to
//!    a real user's config.
//! 2. The pointer file in the app config directory, which is what Settings edits.
//! 3. The default below.
//!
//! # The default
//!
//! `app_data_dir()/db`, **not** `app_config_dir()`. On macOS the two are the same
//! path so the distinction is invisible, but on Linux config is `~/.config` and
//! data is `~/.local/share`, and a transcript database in `~/.config` is wrong.
//! Picking by meaning rather than by what happens to work locally is what keeps
//! the Linux build from inheriting a macOS accident.
//!
//! The `db` subdirectory keeps the four table directories from sitting loose
//! beside logs, caches and the pointer file itself.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The pointer file's name, inside the app config directory.
const POINTER: &str = "data-location.json";

/// Overrides the data directory without needing the database. See the module doc.
const ENV_OVERRIDE: &str = "AZ_DATA_DIR";

#[derive(Debug, Serialize, Deserialize)]
struct Pointer {
    path: PathBuf,
}

/// Where the tables are, and why.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocation {
    pub path: PathBuf,
    /// `default` | `pointer` | `env`. Settings renders this, so an override that
    /// came from the environment is visibly not something the UI can change.
    pub source: String,
    /// False when the environment set it, since a pointer file would not win.
    pub is_editable: bool,
}

/// Resolve the data directory. Never fails: an unreadable pointer falls back to
/// the default rather than refusing to start, because the alternative is an app
/// that cannot launch until someone hand-edits a file it never named.
#[must_use]
pub fn resolve(config_dir: &Path, data_dir: &Path) -> DataLocation {
    if let Some(path) = std::env::var_os(ENV_OVERRIDE).filter(|value| !value.is_empty()) {
        return DataLocation {
            path: PathBuf::from(path),
            source: "env".into(),
            is_editable: false,
        };
    }

    if let Some(path) = read_pointer(config_dir) {
        return DataLocation {
            path,
            source: "pointer".into(),
            is_editable: true,
        };
    }

    DataLocation {
        path: default_path(data_dir),
        source: "default".into(),
        is_editable: true,
    }
}

/// `<app data>/db`. See the module doc for why data and not config.
#[must_use]
pub fn default_path(data_dir: &Path) -> PathBuf {
    data_dir.join("db")
}

fn read_pointer(config_dir: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(config_dir.join(POINTER)).ok()?;
    let pointer: Pointer = serde_json::from_str(&raw).ok()?;
    (!pointer.path.as_os_str().is_empty()).then_some(pointer.path)
}

/// Point future launches at `path`, or back at the default when `path` is `None`.
///
/// Deliberately does **not** move existing data or reopen anything. A database
/// cannot be relocated out from under its open handles, so this takes effect on
/// the next launch and the caller says so.
///
/// # Errors
/// Returns the underlying IO error when the pointer cannot be written, so a
/// change that did not stick reports rather than appearing to have saved.
pub fn set_pointer(config_dir: &Path, path: Option<&Path>) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let file = config_dir.join(POINTER);
    match path {
        Some(path) => {
            let encoded = serde_json::to_string_pretty(&Pointer {
                path: path.to_path_buf(),
            })
            .map_err(std::io::Error::other)?;
            std::fs::write(file, encoded)
        }
        // Removing the pointer is how "back to the default" is expressed, rather
        // than writing the default path in: a recorded default would not follow
        // the platform if the default ever changed.
        None => match std::fs::remove_file(file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("az-loc-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("should create");
        dir
    }

    /// The default has to be the data directory, not the config one. They are the
    /// same path on macOS, so only an assertion catches a regression here.
    #[test]
    fn the_default_lives_under_the_data_directory() {
        let config = temp("config-a");
        let data = temp("data-a");
        let resolved = resolve(&config, &data);

        assert_eq!(resolved.path, data.join("db"));
        assert_eq!(resolved.source, "default");
        assert!(resolved.is_editable);
    }

    #[test]
    fn a_pointer_overrides_the_default_and_can_be_cleared() {
        let config = temp("config-b");
        let data = temp("data-b");
        let elsewhere = temp("elsewhere-b");

        set_pointer(&config, Some(&elsewhere)).expect("should write");
        let resolved = resolve(&config, &data);
        assert_eq!(resolved.path, elsewhere);
        assert_eq!(resolved.source, "pointer");

        set_pointer(&config, None).expect("should clear");
        assert_eq!(resolve(&config, &data).path, data.join("db"));
    }

    /// Clearing a pointer that was never written is a no-op, not an error: the
    /// UI's "use the default" is the same action whether or not one exists.
    #[test]
    fn clearing_an_absent_pointer_is_not_an_error() {
        let config = temp("config-c");
        assert!(set_pointer(&config, None).is_ok());
    }

    /// A corrupt pointer must not stop the app launching. Falling back to the
    /// default beats refusing to start over a file the user never saw.
    #[test]
    fn an_unreadable_pointer_falls_back_rather_than_failing() {
        let config = temp("config-d");
        let data = temp("data-d");
        std::fs::write(config.join(POINTER), "not json at all").expect("should write");

        let resolved = resolve(&config, &data);
        assert_eq!(resolved.path, data.join("db"));
        assert_eq!(resolved.source, "default");
    }
}
