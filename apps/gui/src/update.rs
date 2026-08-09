//! Self-update against the published manifest.
//!
//! The install half deliberately mirrors [`crate::relaunch_app`]: swapping the
//! bundle on disk is only half an upgrade, and the tables have to be drained
//! before the process goes away or a half-written page outlives it.
//!
//! Note what has to ship *before* this is useful to anyone. A build that goes
//! out without the updater compiled in can never pull itself forward, and
//! that cohort has to reinstall by hand, so this lands in the same change as
//! the first published bundle, not after it.

use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::{AppHandle, AppState};

/// What the frontend needs in order to offer the upgrade.
#[derive(Serialize)]
pub(crate) struct AvailableUpdate {
    version: String,
    notes: Option<String>,
    date: Option<String>,
}

/// The published version, when it is newer than the running one.
///
/// A transport failure is raised rather than folded into `None`. The two
/// outcomes read identically in the UI otherwise, and "you are up to date" is
/// the wrong thing to tell someone whose update check never reached the CDN.
#[tauri::command]
pub(crate) async fn check_for_update(app: AppHandle) -> Result<Option<AvailableUpdate>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;

    Ok(found.map(|update| AvailableUpdate {
        version: update.version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
    }))
}

/// Download the published bundle over the installed one, then restart into it.
///
/// Refuses while any run is live. An upgrade kills every run this instance is
/// hosting, including, when AgencyZero is building itself, the session that
/// produced the bundle. The caller has to stop them first, the same way
/// deleting a project does. That restriction lifts once the run supervisor
/// moves out of this process.
#[tauri::command]
pub(crate) async fn install_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    install_update_now_with_state(&app, &state).await
}

/// Internal half used by an owner-authorized agent restart request after the
/// originating run has released its slot.
pub(crate) async fn install_update_now(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    install_update_now_with_state(app, &state).await
}

async fn install_update_now_with_state(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let live = state.live_run_count();
    if live > 0 {
        return Err(format!(
            "{live} run(s) still active; stop them before upgrading"
        ));
    }

    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update available".to_string());
    };

    crate::log!(
        crate::log::Level::Info,
        "boot",
        "installing update {}",
        update.version
    );

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // Same drain-and-angel handoff as Restart into Build on Disk. The updater
    // has replaced the path already; the angel launches that new binary only
    // after this process has released the single-writer store.
    crate::restart_after_drain(app, state).await
}
