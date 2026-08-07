//! One-shot supervisor for a drained in-place restart.
//!
//! The GUI cannot reliably replace itself and also be the process responsible
//! for starting the replacement. The angel is the same executable in a hidden
//! headless mode: it waits for the old PID to disappear, starts the binary now
//! present at that path, and exits.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::store_backup;

const FLAG: &str = "--agencyzero-angel";
const PARENT_EXIT_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_EVERY: Duration = Duration::from_millis(50);

#[derive(Debug, PartialEq, Eq)]
struct Request {
    parent_pid: u32,
    target: PathBuf,
    action: Action,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Relaunch,
    Backup { store: PathBuf, backup: PathBuf },
    Restore { store: PathBuf, backup: PathBuf },
}

/// Run angel mode when the private flag is present.
///
/// `None` means this is an ordinary GUI launch. `Some` means the process is
/// exclusively the headless supervisor and must return from `main` afterwards.
pub(crate) fn run_from_env() -> Option<Result<(), String>> {
    parse(std::env::args_os()).map(|request| request.and_then(run))
}

fn parse(args: impl IntoIterator<Item = OsString>) -> Option<Result<Request, String>> {
    let mut args = args.into_iter();
    let _executable = args.next();
    let first = args.next()?;
    if first != FLAG {
        return None;
    }

    let parsed = (|| {
        let parent = args
            .next()
            .ok_or_else(|| "angel mode is missing the parent PID".to_string())?;
        let parent_pid = parent
            .to_string_lossy()
            .parse::<u32>()
            .map_err(|_| "angel mode received an invalid parent PID".to_string())?;
        if parent_pid == 0 || parent_pid > i32::MAX as u32 {
            return Err("angel mode received an out-of-range parent PID".to_string());
        }

        let target = PathBuf::from(
            args.next()
                .ok_or_else(|| "angel mode is missing the relaunch target".to_string())?,
        );
        if !target.is_absolute() {
            return Err("angel mode requires an absolute relaunch target".to_string());
        }
        let action =
            match args.next() {
                None => Action::Relaunch,
                Some(flag) if flag == "--backup" || flag == "--restore" => {
                    let store = PathBuf::from(args.next().ok_or_else(|| {
                        "angel maintenance is missing the store path".to_string()
                    })?);
                    let backup = PathBuf::from(args.next().ok_or_else(|| {
                        "angel maintenance is missing the backup path".to_string()
                    })?);
                    if !store.is_absolute() || !store_backup::is_package_path(&backup) {
                        return Err(
                            "angel maintenance requires absolute store and .azbackup paths".into(),
                        );
                    }
                    if flag == "--backup" {
                        Action::Backup { store, backup }
                    } else {
                        Action::Restore { store, backup }
                    }
                }
                Some(_) => return Err("angel mode received an unsupported action".into()),
            };
        if args.next().is_some() {
            return Err("angel mode received unexpected trailing arguments".to_string());
        }

        Ok(Request {
            parent_pid,
            target,
            action,
        })
    })();
    Some(parsed)
}

fn run(request: Request) -> Result<(), String> {
    let deadline = Instant::now() + PARENT_EXIT_TIMEOUT;
    while process_exists(request.parent_pid) {
        if Instant::now() >= deadline {
            return Err(format!(
                "the parent process {} did not exit within {}s",
                request.parent_pid,
                PARENT_EXIT_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(POLL_EVERY);
    }

    let operation = match &request.action {
        Action::Relaunch => None,
        Action::Backup { store, backup } => Some(
            store_backup::create(store, backup)
                .map(|()| store_backup::OperationResult {
                    kind: "backup".into(),
                    ok: true,
                    message: format!("Verified backup created at {}", backup.display()),
                })
                .unwrap_or_else(|error| store_backup::OperationResult {
                    kind: "backup".into(),
                    ok: false,
                    message: format!("Backup failed: {error}"),
                }),
        ),
        Action::Restore { store, backup } => Some(
            store_backup::restore(store, backup)
                .map(|rollback| store_backup::OperationResult {
                    kind: "restore".into(),
                    ok: true,
                    message: format!(
                        "Verified backup restored; the displaced store is at {}",
                        rollback.display()
                    ),
                })
                .unwrap_or_else(|error| store_backup::OperationResult {
                    kind: "restore".into(),
                    ok: false,
                    message: format!("Restore failed: {error}"),
                }),
        ),
    };

    // A successful backup is the profile handoff point: Experimental stays
    // closed so the owner can open Normal and select the package there. A
    // failed backup relaunches so Settings can report why no package appeared.
    if matches!(&request.action, Action::Backup { .. })
        && operation.as_ref().is_some_and(|operation| operation.ok)
    {
        return Ok(());
    }

    let mut replacement = Command::new(&request.target);
    // An ordinary later restart must not keep reporting an operation from an
    // earlier process through inherited environment state.
    replacement.env_remove(store_backup::RESULT_ENV);
    if let Some(operation) = operation
        && let Ok(encoded) = serde_json::to_string(&operation)
    {
        replacement.env(store_backup::RESULT_ENV, encoded);
    }
    replacement
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not relaunch {}: {error}", request.target.display()))
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    // Signal zero changes nothing; it only asks the kernel whether the process
    // exists and is visible to this user. EPERM still means it exists.
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn process_exists(_pid: u32) -> bool {
    false
}

/// Start the one-shot supervisor before asking Tauri to exit.
pub(crate) fn spawn(action: Action) -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("could not locate the running executable: {error}"))?;
    if let Action::Backup { store, backup } | Action::Restore { store, backup } = &action
        && (!store.is_absolute() || !store_backup::is_package_path(backup))
    {
        return Err("could not start maintenance with a non-absolute store or package path".into());
    }
    let mut command = Command::new(&executable);
    command
        .arg(FLAG)
        .arg(std::process::id().to_string())
        .arg(&executable);
    match action {
        Action::Relaunch => {}
        Action::Backup { store, backup } => {
            command.arg("--backup").arg(store).arg(backup);
        }
        Action::Restore { store, backup } => {
            command.arg("--restore").arg(store).arg(backup);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not start the restart angel: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn ordinary_launches_do_not_enter_angel_mode() {
        assert_eq!(parse(os(&["az-gui"])), None);
        assert_eq!(parse(os(&["az-gui", "--debug-no-persist"])), None);
    }

    #[test]
    fn angel_arguments_are_exact_and_absolute() {
        assert_eq!(
            parse(os(&[
                "az-gui",
                FLAG,
                "42",
                "/Applications/AgencyZero.app/az-gui"
            ])),
            Some(Ok(Request {
                parent_pid: 42,
                target: PathBuf::from("/Applications/AgencyZero.app/az-gui"),
                action: Action::Relaunch,
            }))
        );
        assert!(
            parse(os(&["az-gui", FLAG, "nope", "/tmp/az-gui"]))
                .unwrap()
                .is_err()
        );
        assert!(
            parse(os(&[
                "az-gui",
                FLAG,
                "42",
                "/tmp/az-gui",
                "--backup",
                "/tmp/db",
                "/tmp/AgencyZero-backup-20260807.azbackup"
            ]))
            .unwrap()
            .is_ok()
        );
        assert!(
            parse(os(&[
                "az-gui",
                FLAG,
                "42",
                "/tmp/az-gui",
                "--restore",
                "/tmp/db",
                "/outside/moved.azbackup"
            ]))
            .unwrap()
            .is_ok()
        );
        assert!(
            parse(os(&[
                "az-gui",
                FLAG,
                "42",
                "/tmp/az-gui",
                "--restore",
                "relative/db",
                "/outside/moved.azbackup"
            ]))
            .unwrap()
            .is_err()
        );
        assert!(
            parse(os(&["az-gui", FLAG, "42", "relative"]))
                .unwrap()
                .is_err()
        );
        assert!(
            parse(os(&["az-gui", FLAG, "42", "/tmp/az-gui", "extra"]))
                .unwrap()
                .is_err()
        );
    }

    #[test]
    fn the_current_process_is_observably_alive() {
        assert!(process_exists(std::process::id()));
    }

    #[cfg(unix)]
    #[test]
    fn a_successful_backup_leaves_the_source_profile_closed() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "az-angel-backup-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let store = dir.join("db");
        std::fs::create_dir_all(&store).expect("store creates");
        std::fs::write(store.join("raw.wt.data"), b"closed-store bytes")
            .expect("store file writes");
        let backup = dir.join("handoff.azbackup");
        let marker = dir.join("unexpected-relaunch");
        let target = dir.join("replacement.sh");
        std::fs::write(
            &target,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .expect("replacement script writes");
        let mut permissions = std::fs::metadata(&target)
            .expect("replacement script exists")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&target, permissions).expect("replacement becomes executable");

        let mut parent = Command::new("/bin/sh")
            .args(["-c", "true"])
            .spawn()
            .expect("short-lived parent starts");
        let parent_pid = parent.id();
        let reaper = std::thread::spawn(move || parent.wait().expect("parent reaps"));
        run(Request {
            parent_pid,
            target,
            action: Action::Backup {
                store,
                backup: backup.clone(),
            },
        })
        .expect("backup handoff succeeds");
        reaper.join().expect("reaper finishes");

        assert!(backup.is_file());
        std::thread::sleep(Duration::from_millis(100));
        assert!(!marker.exists(), "successful backup relaunched its profile");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_replacement_starts_only_after_the_parent_is_reaped() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "az-angel-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("scratch directory creates");
        let marker = dir.join("launched");
        let target = dir.join("replacement.sh");
        std::fs::write(
            &target,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .expect("replacement script writes");
        let mut permissions = std::fs::metadata(&target)
            .expect("replacement script exists")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&target, permissions).expect("replacement becomes executable");

        let mut parent = Command::new("/bin/sh")
            .args(["-c", "sleep 0.15"])
            .spawn()
            .expect("short-lived parent starts");
        let parent_pid = parent.id();
        let reaper = std::thread::spawn(move || parent.wait().expect("parent reaps"));

        run(Request {
            parent_pid,
            target,
            action: Action::Relaunch,
        })
        .expect("angel hands off");
        reaper.join().expect("reaper finishes");
        // A full workspace test run can leave the spawned shell waiting for a
        // scheduler slice longer than the focused test does. The angel handoff
        // has already returned; allow the replacement a modest observation
        // window before declaring that it never launched.
        for _ in 0..80 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(marker.exists(), "replacement did not create its marker");

        let _ = std::fs::remove_dir_all(dir);
    }
}
