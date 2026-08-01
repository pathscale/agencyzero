//! Pull requests cut during runs, tracked as chips over the composer.
//!
//! The transcript is the source: any GitHub PR URL in an agent's reply becomes
//! a row (once per project), and `gh` — when installed — fills in what the
//! chip shows: state, branch, +adds −dels, and the CI rollup. No `gh`, no
//! problem: the chip still exists with what the URL alone says, which is the
//! repo and the number. Everything else reads `unknown` rather than a guess.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
// `execute` on a select builder is a trait method.
use worktable::prelude::*;

use crate::AppState;
use crate::db::schema::pull_request::{
    PrDismissedByIdQuery, PrFactsByIdQuery, PullRequestRow, PullRequestWorkTable,
};
use crate::db::tables::Tables;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDto {
    pub id: String,
    pub project_id: String,
    pub url: String,
    pub repo: String,
    pub number: u32,
    pub branch: String,
    pub state: String,
    pub additions: u32,
    pub deletions: u32,
    pub ci: String,
    pub dismissed: bool,
}

impl From<PullRequestRow> for PullRequestDto {
    fn from(row: PullRequestRow) -> Self {
        PullRequestDto {
            id: row.id,
            project_id: row.project_id,
            url: row.url,
            repo: row.repo,
            number: row.number,
            branch: row.branch,
            state: row.state,
            additions: row.additions,
            deletions: row.deletions,
            ci: row.ci,
            dismissed: row.dismissed,
        }
    }
}

/// Every GitHub PR URL in `text`, deduplicated, in order of appearance.
///
/// A hand parser rather than a regex dependency: the shape is one fixed host
/// and three path segments, and the interesting part is knowing where a URL
/// ends inside prose — whitespace and the punctuation that wraps links.
fn pr_urls(text: &str) -> Vec<(String, String, u32)> {
    const HOST: &str = "https://github.com/";
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (at, _) in text.match_indices(HOST) {
        let tail = &text[at + HOST.len()..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | ']' | '>' | '"' | '\'' | '`'))
            .unwrap_or(tail.len());
        let path = tail[..end].trim_end_matches(['.', ',', ';', ':']);
        let mut parts = path.split('/');
        let (Some(owner), Some(repo), Some(kind), Some(number)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if kind != "pull" {
            continue;
        }
        let Ok(number) = number.parse::<u32>() else {
            continue;
        };
        let url = format!("{HOST}{owner}/{repo}/pull/{number}");
        if seen.insert(url.clone()) {
            found.push((url, format!("{owner}/{repo}"), number));
        }
    }
    found
}

/// Record any PRs a reply mentions and start a background refresh for each.
///
/// Called from the run's completion path, after the reply row is safe. Rows
/// are born `unknown` and honest; `gh` upgrades them moments later when it is
/// installed and authenticated.
///
/// `started_from` is the item the run began on, when it began on one. A pull
/// request opened during that run belongs to that item, and the app knows it
/// without being told: the association is a fact about the run, not something
/// the agent has to remember to report. Only a newly recorded pull request
/// attaches, and only to a row that names none yet, so nothing already linked
/// is ever overwritten.
pub fn harvest_prs(
    app: &AppHandle,
    tables: &Tables,
    project_id: &str,
    reply: &str,
    started_from: Option<&str>,
) {
    let mentioned = pr_urls(reply);
    if mentioned.is_empty() {
        return;
    }
    let existing: Vec<PullRequestRow> = tables
        .pull_request
        .select_by_project_id(project_id.to_string())
        .execute()
        .unwrap_or_default();

    for (url, repo, number) in mentioned {
        let known = existing.iter().find(|row| row.url == url);
        let id = match known {
            Some(row) => row.id.clone(),
            None => {
                let row = PullRequestRow {
                    id: crate::projects::id("pr"),
                    project_id: project_id.to_string(),
                    url: url.clone(),
                    repo,
                    number,
                    branch: String::new(),
                    state: "unknown".into(),
                    additions: 0,
                    deletions: 0,
                    ci: "unknown".into(),
                    dismissed: false,
                    updated_at: crate::projects::now(),
                };
                let id = row.id.clone();
                let opened = row.number;
                match tables.pull_request.insert(row.clone()) {
                    Ok(_) => {
                        let _ = app.emit("pr:updated", PullRequestDto::from(row));
                        if let Some(item) = started_from {
                            attach(app, tables, item, opened);
                        }
                    }
                    Err(error) => {
                        crate::log!(
                            crate::log::Level::Error,
                            "prs",
                            "{project_id}: could not record {url}: {error}"
                        );
                        continue;
                    }
                }
                id
            }
        };
        // A mention of a known PR is still news — merged since last time, CI
        // done — so every mention refreshes.
        spawn_refresh(app.clone(), id);
    }
}

/// Ask `gh` about one PR and write what it says onto the row, off the run's
/// own path so a slow network cannot hold a reply hostage.
fn spawn_refresh(app: AppHandle, pr_id: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Some(row) = state.tables.pull_request.select(pr_id.clone()) else {
            return;
        };
        let asked = tokio::process::Command::new("gh")
            .args([
                "pr",
                "view",
                &row.url,
                "--json",
                "state,additions,deletions,headRefName,statusCheckRollup",
            ])
            .output()
            .await;
        let output = match asked {
            Ok(output) if output.status.success() => output.stdout,
            Ok(output) => {
                crate::log!(
                    crate::log::Level::Warn,
                    "prs",
                    "gh could not describe {}: {}",
                    row.url,
                    String::from_utf8_lossy(&output.stderr).trim()
                );
                return;
            }
            Err(error) => {
                // No gh at all. The chip keeps its URL-derived facts.
                crate::log!(crate::log::Level::Info, "prs", "gh unavailable: {error}");
                return;
            }
        };
        let Ok(facts) = serde_json::from_slice::<serde_json::Value>(&output) else {
            return;
        };

        let as_u32 = |key: &str| {
            u32::try_from(
                facts
                    .get(key)
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            )
            .unwrap_or(u32::MAX)
        };
        /*
         * The rollup reduced to one word for the pill. Failure outranks
         * pending outranks pass, because the pill exists to say the worst
         * true thing; an empty rollup is `none` — repos without CI must not
         * read as passing.
         */
        let ci = match facts
            .get("statusCheckRollup")
            .and_then(serde_json::Value::as_array)
        {
            None => "none".to_string(),
            Some(checks) if checks.is_empty() => "none".to_string(),
            Some(checks) => {
                let word = |check: &serde_json::Value, key: &str| {
                    check
                        .get(key)
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_uppercase()
                };
                let any = |what: &[&str]| {
                    checks.iter().any(|check| {
                        let status = word(check, "status");
                        let conclusion = word(check, "conclusion");
                        let state = word(check, "state");
                        what.contains(&status.as_str())
                            || what.contains(&conclusion.as_str())
                            || what.contains(&state.as_str())
                    })
                };
                if any(&["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"]) {
                    "fail".to_string()
                } else if any(&["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "EXPECTED"]) {
                    "pending".to_string()
                } else {
                    "pass".to_string()
                }
            }
        };

        let update = PrFactsByIdQuery {
            branch: facts
                .get("headRefName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            state: facts
                .get("state")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            additions: as_u32("additions"),
            deletions: as_u32("deletions"),
            ci,
            updated_at: crate::projects::now(),
        };
        if let Err(error) = state
            .tables
            .pull_request
            .update_pr_facts_by_id(update, pr_id.clone())
            .await
        {
            crate::log!(
                crate::log::Level::Error,
                "prs",
                "could not update {}: {error}",
                row.url
            );
            return;
        }
        if let Some(updated) = state.tables.pull_request.select(pr_id) {
            let _ = app.emit("pr:updated", PullRequestDto::from(updated));
        }
    });
}

/// This project's tracked PRs, newest row last, dismissed ones included —
/// the frontend filters, so un-dismissing stays possible later.
#[tauri::command]
pub fn list_pull_requests(project_id: String, state: State<'_, AppState>) -> Vec<PullRequestDto> {
    list_rows(&state.tables.pull_request, &project_id)
}

fn list_rows(table: &PullRequestWorkTable, project_id: &str) -> Vec<PullRequestDto> {
    table
        .select_by_project_id(project_id.to_string())
        .execute()
        .unwrap_or_default()
        .into_iter()
        .map(PullRequestDto::from)
        .collect()
}

/// Wave one chip away. The row stays: dismissed is a view state, not a fact
/// about the PR.
///
/// # Errors
/// Returns a message when the row does not exist or the write fails.
#[tauri::command]
pub async fn dismiss_pull_request(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .tables
        .pull_request
        .update_pr_dismissed_by_id(PrDismissedByIdQuery { dismissed: true }, id.clone())
        .await
        .map_err(|error| error.to_string())?;
    if let Some(row) = state.tables.pull_request.select(id) {
        let _ = app.emit("pr:updated", PullRequestDto::from(row));
    }
    Ok(())
}

/// Ask `gh` again, for the refresh affordance on the chip.
#[tauri::command]
pub fn refresh_pull_request(app: AppHandle, id: String) {
    spawn_refresh(app, id);
}

/// Point an item at the pull request its run produced.
///
/// Nothing happens if the row already names one: a run that mentions a second
/// pull request has not changed which one the item shipped as, and quietly
/// repointing it would lose the first.
fn attach(app: &AppHandle, tables: &Tables, item_id: &str, number: u32) {
    let Some(row) = tables.project_item.select(item_id.to_string()) else {
        return;
    };
    if !row.reference.is_empty() {
        return;
    }
    let app = app.clone();
    // Just this table's handle: `Tables` is a bag of `Arc`s and the write is
    // one row on one of them.
    let items = tables.project_item.clone();
    let id = item_id.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = items
            .update_reference_by_id(
                crate::db::schema::project_item::ReferenceByIdQuery {
                    reference: number.to_string(),
                },
                id.clone(),
            )
            .await
        {
            crate::log!(
                crate::log::Level::Error,
                "prs",
                "could not attach #{number} to {id}: {error}"
            );
            return;
        }
        if let Some(updated) = items.select(id) {
            let _ = app.emit(
                "item:updated",
                crate::projects::ProjectItemDto::from(updated),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::pr_urls;

    #[test]
    fn urls_are_found_in_prose_and_markdown() {
        let text = "Opened [PR #16](https://github.com/pathscale/agencyzero/pull/16) and \
                    https://github.com/pathscale/agencyzero/pull/17. Done.";
        let found = pr_urls(text);
        assert_eq!(
            found,
            vec![
                (
                    "https://github.com/pathscale/agencyzero/pull/16".to_string(),
                    "pathscale/agencyzero".to_string(),
                    16
                ),
                (
                    "https://github.com/pathscale/agencyzero/pull/17".to_string(),
                    "pathscale/agencyzero".to_string(),
                    17
                ),
            ]
        );
    }

    #[test]
    fn issues_and_repeats_do_not_count() {
        let text = "See https://github.com/pathscale/agencyzero/issues/3 and \
                    https://github.com/pathscale/agencyzero/pull/16 again: \
                    https://github.com/pathscale/agencyzero/pull/16";
        assert_eq!(pr_urls(text).len(), 1);
    }
}
