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
        // A mention of a known PR is still news: merged since last time, CI
        // done. One batched refresh covers every row this reply touched.
        let _ = id;
    }
    // One query for the project, after every mention in this reply is recorded.
    refresh_project(app.clone(), project_id.to_string());
}

/// The `owner/name` this working directory pushes to, if any.
///
/// A project knows its directories, and a directory knows its remote, so the
/// app can find the repository without being told and without a pull request
/// existing yet. That last part is the point: until now a row was only ever
/// created from a URL an agent happened to write in prose, so a pull request
/// existed in the panel if and only if it had been mentioned. Opening one was
/// not enough.
async fn repo_of(dir: &str) -> Option<String> {
    let asked = tokio::process::Command::new("git")
        .args(["-C", dir, "remote", "get-url", "origin"])
        .output()
        .await
        .ok()?;
    if !asked.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&asked.stdout).trim().to_string();
    // Both spellings git uses: git@github.com:owner/name.git and the https one.
    let rest = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    (!owner.is_empty() && !name.is_empty()).then(|| format!("{owner}/{name}"))
}

/// Every repository this project touches: its own checkouts, plus any it has
/// already cut a pull request against.
async fn repos_for(
    state: &State<'_, AppState>,
    project_id: &str,
    rows: &[PullRequestRow],
) -> Vec<String> {
    let mut found: std::collections::BTreeSet<String> =
        rows.iter().map(|row| row.repo.clone()).collect();
    let dirs = state
        .tables
        .project
        .select(project_id.to_string())
        .and_then(|row| serde_json::from_str::<Vec<String>>(&row.dirs).ok())
        .unwrap_or_default();
    for dir in dirs {
        if let Some(repo) = repo_of(&dir).await {
            found.insert(repo);
        }
    }
    found.into_iter().collect()
}

/// One word for the pill, from the rollup's single state.
///
/// Failure outranks pending outranks pass, because the pill exists to say the
/// worst true thing. A null rollup is `none`: a repository without CI must not
/// read as passing.
fn ci_word(state: Option<&str>) -> String {
    match state.unwrap_or("").to_uppercase().as_str() {
        "" => "none".into(),
        "FAILURE" | "ERROR" | "TIMED_OUT" | "ACTION_REQUIRED" => "fail".into(),
        "PENDING" | "IN_PROGRESS" | "QUEUED" | "WAITING" | "EXPECTED" => "pending".into(),
        "SUCCESS" | "NEUTRAL" | "SKIPPED" => "pass".into(),
        _ => "unknown".into(),
    }
}

/// Ask about every open pull request in one query, per repository.
///
/// This was one `gh pr view` process per pull request per cycle: six open ones
/// meant six process spawns and six round trips, which is why the interval had
/// to be slow enough to hide the cost. One `gh api graphql` returns them all,
/// so the cadence can be short enough that "polled" and "pushed" are the same
/// thing to anyone watching.
///
/// `gh` keeps doing the authentication. Nothing here reads or stores a token.
pub fn refresh_project(app: AppHandle, project_id: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let rows: Vec<PullRequestRow> = state
            .tables
            .pull_request
            .select_by_project_id(project_id.clone())
            .execute()
            .unwrap_or_default()
            .into_iter()
            // Endings, and rows nobody is looking at. A settled list costs
            // nothing, which is what makes a short interval affordable.
            .filter(|row| !row.dismissed && row.state != "MERGED" && row.state != "CLOSED")
            .collect();

        /*
         * Every repository this project touches, whether or not it has a row
         * yet. That is what lets a pull request appear because it exists
         * rather than because someone wrote its URL in a reply.
         */
        let repos = repos_for(&state, &project_id, &rows).await;
        if repos.is_empty() {
            return;
        }
        let mut by_repo: std::collections::BTreeMap<String, Vec<PullRequestRow>> =
            repos.into_iter().map(|repo| (repo, Vec::new())).collect();
        for row in rows {
            by_repo.entry(row.repo.clone()).or_default().push(row);
        }

        for (repo, prs) in by_repo {
            let Some((owner, name)) = repo.split_once('/') else {
                continue;
            };
            let selections = prs
                .iter()
                .map(|pr| {
                    format!(
                        "    pr{n}: pullRequest(number: {n}) {{ ...pr }}",
                        n = pr.number
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let query = format!(
                "query($owner:String!, $name:String!) {{\n  repository(owner:$owner, name:$name) {{\n\
                     open: pullRequests(states: OPEN, first: 20, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ nodes {{ ...pr }} }}\n\
                 {selections}\n  }}\n}}\n\
                 fragment pr on PullRequest {{\n  number state isDraft headRefName additions deletions reviewDecision url\n  commits(last:1) {{ nodes {{ commit {{ statusCheckRollup {{ state }} }} }} }}\n}}"
            );

            let asked = tokio::process::Command::new("gh")
                .args(["api", "graphql", "-f"])
                .arg(format!("owner={owner}"))
                .arg("-f")
                .arg(format!("name={name}"))
                .arg("-f")
                .arg(format!("query={query}"))
                .output()
                .await;
            let output = match asked {
                Ok(output) if output.status.success() => output.stdout,
                Ok(output) => {
                    /*
                     * A repository that was renamed, deleted or lost access
                     * answers here. The rows used to keep saying whatever they
                     * last said, forever, which is a stale claim presented as
                     * current. They go to `unknown` instead.
                     */
                    crate::log!(
                        crate::log::Level::Warn,
                        "prs",
                        "gh could not describe {repo}: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    );
                    for pr in &prs {
                        mark_unknown(&app, &state, pr).await;
                    }
                    continue;
                }
                Err(error) => {
                    // No gh at all. The chips keep their URL-derived facts,
                    // which are still true.
                    crate::log!(crate::log::Level::Info, "prs", "gh unavailable: {error}");
                    return;
                }
            };
            let Ok(body) = serde_json::from_slice::<serde_json::Value>(&output) else {
                continue;
            };
            let found = body.get("data").and_then(|data| data.get("repository"));

            /*
             * Anything open with no row yet becomes one. This is the whole of
             * "a pull request I opened shows up": the panel stops depending on
             * an agent having written its URL into a reply.
             */
            if let Some(open) = found
                .and_then(|repo| repo.pointer("/open/nodes"))
                .and_then(serde_json::Value::as_array)
            {
                for node in open {
                    let url = node
                        .get("url")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let number = u32::try_from(
                        node.get("number")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                    )
                    .unwrap_or(0);
                    if url.is_empty() || number == 0 || prs.iter().any(|row| row.number == number) {
                        continue;
                    }
                    let row = PullRequestRow {
                        id: crate::projects::id("pr"),
                        project_id: project_id.clone(),
                        url: url.to_string(),
                        repo: repo.clone(),
                        number,
                        branch: node
                            .get("headRefName")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        state: "OPEN".into(),
                        additions: 0,
                        deletions: 0,
                        ci: ci_word(
                            node.pointer("/commits/nodes/0/commit/statusCheckRollup/state")
                                .and_then(serde_json::Value::as_str),
                        ),
                        dismissed: false,
                        updated_at: crate::projects::now(),
                    };
                    match state.tables.pull_request.insert(row.clone()) {
                        Ok(_) => {
                            let _ = app.emit("pr:updated", PullRequestDto::from(row));
                        }
                        Err(error) => crate::log!(
                            crate::log::Level::Error,
                            "prs",
                            "{project_id}: could not record {url}: {error}"
                        ),
                    }
                }
            }

            for pr in &prs {
                let Some(facts) = found.and_then(|repo| repo.get(format!("pr{}", pr.number)))
                else {
                    // Present in the response but null: the pull request is
                    // gone rather than the repository.
                    mark_unknown(&app, &state, pr).await;
                    continue;
                };
                if facts.is_null() {
                    mark_unknown(&app, &state, pr).await;
                    continue;
                }
                let text = |key: &str| {
                    facts
                        .get(key)
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                let count = |key: &str| {
                    u32::try_from(
                        facts
                            .get(key)
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                    )
                    .unwrap_or(u32::MAX)
                };
                let rollup = facts
                    .pointer("/commits/nodes/0/commit/statusCheckRollup/state")
                    .and_then(serde_json::Value::as_str);

                let update = PrFactsByIdQuery {
                    branch: text("headRefName"),
                    state: {
                        let state = text("state");
                        if state.is_empty() {
                            "unknown".to_string()
                        } else {
                            state
                        }
                    },
                    additions: count("additions"),
                    deletions: count("deletions"),
                    ci: ci_word(rollup),
                    updated_at: crate::projects::now(),
                };
                if let Err(error) = state
                    .tables
                    .pull_request
                    .update_pr_facts_by_id(update, pr.id.clone())
                    .await
                {
                    crate::log!(
                        crate::log::Level::Error,
                        "prs",
                        "could not update {}: {error}",
                        pr.url
                    );
                    continue;
                }
                if let Some(updated) = state.tables.pull_request.select(pr.id.clone()) {
                    let _ = app.emit("pr:updated", PullRequestDto::from(updated));
                }
            }
        }
    });
}

/// Say that we no longer know, rather than repeating what we last knew.
async fn mark_unknown(app: &AppHandle, state: &State<'_, AppState>, row: &PullRequestRow) {
    if row.state == "unknown" {
        return;
    }
    let update = PrFactsByIdQuery {
        branch: row.branch.clone(),
        state: "unknown".into(),
        additions: row.additions,
        deletions: row.deletions,
        ci: "unknown".into(),
        updated_at: crate::projects::now(),
    };
    if state
        .tables
        .pull_request
        .update_pr_facts_by_id(update, row.id.clone())
        .await
        .is_ok()
        && let Some(updated) = state.tables.pull_request.select(row.id.clone())
    {
        let _ = app.emit("pr:updated", PullRequestDto::from(updated));
    }
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
    // Asked about one, answered for its whole project: the query costs the
    // same either way, and a chip nobody clicked is no less stale.
    let project = app
        .state::<AppState>()
        .tables
        .pull_request
        .select(id)
        .map(|row| row.project_id);
    if let Some(project) = project {
        refresh_project(app, project);
    }
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
