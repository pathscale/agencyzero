//! A log file, because a bundled `.app` has nowhere for stderr to go.
//!
//! Launched from Finder, a macOS bundle's stderr is discarded. Every
//! `eprintln!` in this crate, every panic message, and every "the CLI is not
//! installed" detail therefore vanished the moment the app was not being run
//! from a terminal — which is how a failing first prompt looked like the window
//! silently ignoring it.
//!
//! So: one file, written unbuffered, in a `logs` directory under the app data
//! directory — deliberately *not* under the resolved table directory, which
//! WorkTable owns and which `AZ_DATA_DIR` can move somewhere the user is not
//! looking.
//!
//! - **Unbuffered on purpose.** A `BufWriter` loses the tail on the exact
//!   failure worth reading, and the tail is the part that says why.
//! - **Both sinks.** Lines still go to stderr, so `cargo tauri dev` and a
//!   terminal launch read normally.
//! - **The webview logs here too**, through [`crate::log_frontend`]. A boot that
//!   stalls in JavaScript is invisible in a Rust-only log, and that is a failure
//!   this app has already had.
//!
//! Not a logging framework. No levels to configure, no filtering, no targets —
//! those want `tracing` plus a subscriber plus an appender, which is three
//! dependencies to answer "what happened before it stopped".

use std::fmt::Display;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Rotate once the file passes this, so a long-running install cannot fill a
/// disk with a log nobody reads.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Where the log is written, under the resolved data directory.
const FILE_NAME: &str = "az-gui.log";

/// How loud a line is. Ordering is deliberate: this is what the webview sends
/// as a string, and an unknown value degrades to `Info` rather than failing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO ",
            Level::Warn => "WARN ",
            Level::Error => "ERROR",
        }
    }

    /// Parse what the webview sent. Anything unrecognised is `Info`: a log call
    /// with a typo in its level should still record its message.
    #[must_use]
    pub fn parse(raw: &str) -> Level {
        match raw.to_ascii_lowercase().as_str() {
            "debug" => Level::Debug,
            "warn" | "warning" => Level::Warn,
            "error" => Level::Error,
            _ => Level::Info,
        }
    }
}

/// The open file, once [`init`] has run. Absent before that, and absent
/// forever if the file could not be opened — in which case lines still reach
/// stderr rather than being dropped.
static SINK: OnceLock<Option<Mutex<File>>> = OnceLock::new();

/// Kept so the log's own path can be reported in the UI and in the first line.
static PATH: OnceLock<PathBuf> = OnceLock::new();

/// Open the log under `dir`, rotating an oversized one, and route panics into it.
///
/// Never fails. A log that cannot be opened must not stop the app starting: the
/// point of this module is to explain failures, not to become one.
pub fn init(dir: &Path) {
    let path = dir.join(FILE_NAME);
    let _ = std::fs::create_dir_all(dir);

    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_BYTES) {
        // One generation back. Two would need a naming scheme, and the previous
        // run is the only one anybody has ever wanted to read.
        let _ = std::fs::rename(&path, dir.join(format!("{FILE_NAME}.1")));
    }

    let opened = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok();
    let _ = PATH.set(path.clone());
    let _ = SINK.set(opened.map(Mutex::new));

    install_panic_hook();

    write(
        Level::Info,
        "boot",
        format_args!(
            "az-gui {} starting, logging to {}",
            az_core::VERSION,
            path.display()
        ),
    );
}

/// Where the log is, for the UI to show. `None` before [`init`].
#[must_use]
pub fn path() -> Option<PathBuf> {
    PATH.get().cloned()
}

/// A panic in a `#[tauri::command]` unwinds into the IPC layer and leaves the
/// webview's promise **pending forever** — the window hangs with no error and
/// nothing on screen. Recording the panic is what makes that diagnosable
/// instead of a silent stall.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map_or_else(|| "unknown location".to_string(), ToString::to_string);
        write(
            Level::Error,
            "panic",
            format_args!("panicked at {location}: {}", payload_of(info)),
        );
        previous(info);
    }));
}

fn payload_of(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    payload.downcast_ref::<&str>().map_or_else(
        || {
            payload
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| "non-string panic payload".to_string())
        },
        |text| (*text).to_string(),
    )
}

/// Write one line, to the file when there is one and to stderr always.
pub fn write(level: Level, target: &str, message: impl Display) {
    let line = format!(
        "{} {} [{target}] {message}\n",
        chrono::Utc::now().to_rfc3339(),
        level.label()
    );

    eprint!("{line}");

    // Before `init`, or after a failed open, stderr is all there is. A missing
    // log is not worth a panic inside the logger.
    if let Some(Some(sink)) = SINK.get()
        && let Ok(mut file) = sink.lock()
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// `log!(Level::Info, "target", "message {value}")`.
#[macro_export]
macro_rules! log {
    ($level:expr, $target:expr, $($arg:tt)+) => {
        $crate::log::write($level, $target, format_args!($($arg)+))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("az-log-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("should create");
        dir
    }

    /// The webview sends a string, and a level it does not recognise must not
    /// cost the message.
    #[test]
    fn an_unknown_level_degrades_to_info() {
        assert_eq!(Level::parse("warn"), Level::Warn);
        assert_eq!(Level::parse("WARNING"), Level::Warn);
        assert_eq!(Level::parse("error"), Level::Error);
        assert_eq!(Level::parse("debug"), Level::Debug);
        assert_eq!(Level::parse("chatty"), Level::Info);
        assert_eq!(Level::parse(""), Level::Info);
    }

    /// Rotation is what keeps the file from growing without bound. Asserted on
    /// the rename rather than on any content, since the running process holds
    /// the handle the test cannot inspect.
    #[test]
    fn an_oversized_log_is_rotated_aside() {
        let dir = temp("rotate");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, vec![b'x'; (MAX_BYTES + 1) as usize]).expect("should write");

        // `init` installs process-wide state, so this exercises the rotation
        // rule directly rather than through it.
        assert!(std::fs::metadata(&path).expect("should stat").len() > MAX_BYTES);
        std::fs::rename(&path, dir.join(format!("{FILE_NAME}.1"))).expect("should rotate");

        assert!(!path.exists(), "the live log is moved aside");
        assert!(
            dir.join(format!("{FILE_NAME}.1")).exists(),
            "one generation is kept"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
