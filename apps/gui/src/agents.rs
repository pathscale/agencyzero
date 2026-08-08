//! Detecting the installed agent CLIs, via `agent-abstraction` rather than a
//! fixture.
//!
//! Two questions per agent, and they fail independently: is the binary there and
//! what version (`Probe`), and is it logged in (`AuthStatus`). Keeping them apart
//! is what lets Settings distinguish "not installed" from "installed but signed
//! out", which are different problems with different fixes.

use agent_abstraction::{Agent, AuthState, AuthStatus, Error, Probe, VersionStatus};
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Where the last probe is cached in the store.
pub const KEY: &str = "agents";

/// Every agent this build can drive.
pub const AGENTS: [Agent; 3] = [Agent::Claude, Agent::Codex, Agent::Copilot];

/// Add conventional GUI-invisible agent executable directories to `PATH`.
///
/// GUI launches do not necessarily inherit the interactive shell's startup
/// files. Claude's native installer uses `$HOME/.local/bin`; a common npm
/// setup uses `$HOME/.npm-global/bin`; Volta uses `$HOME/.volta/bin`; and cmux
/// bundles provider CLIs inside its application resources. Appending preserves
/// the user's explicit shell ordering while making those fallbacks visible.
pub(crate) fn with_user_local_bin(path: &OsStr, home: Option<&Path>) -> OsString {
    let mut entries: Vec<PathBuf> = std::env::split_paths(path).collect();
    let mut candidates = Vec::new();
    if let Some(home) = home {
        candidates.extend([
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join(".volta/bin"),
        ]);
    }
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from(
        "/Applications/cmux.app/Contents/Resources/bin",
    ));
    for candidate in candidates {
        if !entries.contains(&candidate) {
            entries.push(candidate);
        }
    }
    std::env::join_paths(entries).unwrap_or_else(|_| path.to_os_string())
}

/// Resolve the executable the selected provider adapter will spawn.
///
/// This is intentionally cheaper than [`Probe::run`]: prompt submission needs
/// a synchronous preflight, not another version and authentication subprocess
/// on every turn. The full probe still owns Settings and onboarding status.
pub fn executable_path(agent: Agent) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|directory| directory.join(agent.bin()))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Refuse before a prompt or project row is persisted when no process can be
/// started to answer it.
pub fn require_executable(agent: Agent) -> Result<PathBuf, String> {
    executable_path(agent).ok_or_else(|| {
        format!(
            "{} is not installed or is not visible on PATH. Install it, then open Settings and run the agent checks again.",
            agent.bin()
        )
    })
}

/// One agent's detected state, in the shape the webview expects.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusDto {
    pub agent: Agent,
    /// `connected` | `outdated` | `logged_out` | `missing`.
    pub state: String,
    /// As the CLI reports it, or `None` when it could not be asked.
    pub version: Option<String>,
    /// The release the crate's mappings were verified against.
    pub min_version: String,
    /// Short capability chips: fork, session id, thread id, events.
    pub caps: Vec<String>,
    /// Machine-readable capabilities for controls whose behavior depends on
    /// what the provider can actually do.
    pub capabilities: ProviderCapabilitiesDto,
    pub checked_at: String,
    /// The CLI's own wording, so Settings can explain rather than just colour a
    /// dot. Empty when there is nothing useful to say.
    pub detail: String,
    /// How it is authenticated, in its own words: `claude.ai`, `ChatGPT`, an API
    /// key. `None` when the agent did not say.
    pub auth_method: Option<String>,
    /// The account and plan, where reported.
    pub account: Option<String>,
    pub plan: Option<String>,
    /// The command that resolves a missing login, for the `logged_out` case.
    pub login_hint: String,
}

/// Stable wire shape for [`agent_abstraction::Caps`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilitiesDto {
    pub session: bool,
    pub fork: bool,
    pub events: bool,
    pub native_system: bool,
    pub commands: bool,
    pub live_follow_up: bool,
    pub approvals: bool,
}

/// Probe every agent concurrently.
///
/// Concurrent because each probe spawns a process and waits on `--version` plus
/// an auth check; run in series, three agents make Settings visibly slow to
/// open.
pub async fn detect_all() -> Vec<AgentStatusDto> {
    let probes = AGENTS.map(detect_one);
    futures::future::join_all(probes).await
}

/// Probe one agent, mapping both failures onto a state the UI can render.
async fn detect_one(agent: Agent) -> AgentStatusDto {
    let checked_at = chrono::Utc::now().to_rfc3339();
    let caps = describe_caps(agent);
    let capabilities = provider_capabilities(agent);
    let min_version = crate::models::verified_against(agent);

    let probe = Probe::run(agent).await;
    let auth = AuthStatus::check(agent).await;

    // Not installed is answered by the probe alone: an agent that is not there
    // cannot be signed in, and reporting `logged_out` for a missing binary would
    // send someone to run a login command for a CLI they do not have.
    if matches!(probe, Err(Error::NotInstalled { .. })) {
        return AgentStatusDto {
            agent,
            state: "missing".into(),
            version: None,
            min_version,
            caps,
            capabilities,
            checked_at,
            detail: agent.install_hint().to_string(),
            auth_method: None,
            account: None,
            plan: None,
            login_hint: String::new(),
        };
    }

    let probe = probe.ok();
    let version = probe
        .as_ref()
        .and_then(|p| p.version.as_ref().map(ToString::to_string));
    let is_outdated = probe
        .as_ref()
        .is_some_and(|p| matches!(p.status, VersionStatus::Older));

    let (auth_state, detail, method, account, plan, login_hint) = match &auth {
        Ok(status) => (
            status.state,
            status.detail.clone(),
            status.method.clone(),
            status.account.clone(),
            status.plan.clone(),
            status.login_hint.to_string(),
        ),
        // An auth check that could not run is not a signed-out agent. Saying
        // `Unknown` keeps the dot off "logged out" while still surfacing why.
        Err(error) => (
            AuthState::Unknown,
            error.to_string(),
            None,
            None,
            None,
            String::new(),
        ),
    };

    // Ordering matters: signed out is the more actionable of the two, so it wins
    // over an old version. Fixing the login is what unblocks the agent; the
    // upgrade advisory is still in `detail`.
    let state = match auth_state {
        AuthState::LoggedOut => "logged_out",
        _ if is_outdated => "outdated",
        _ => "connected",
    };

    let advisory = probe.as_ref().and_then(Probe::advisory);
    let detail = match advisory {
        Some(note) if !detail.is_empty() => format!("{detail} · {note}"),
        Some(note) => note,
        None => detail,
    };

    AgentStatusDto {
        agent,
        state: state.into(),
        version,
        min_version,
        caps,
        capabilities,
        checked_at,
        detail,
        auth_method: method,
        account,
        plan,
        login_hint,
    }
}

fn provider_capabilities(agent: Agent) -> ProviderCapabilitiesDto {
    use agent_abstraction::SessionSupport;

    let caps = agent.caps();
    ProviderCapabilitiesDto {
        session: !matches!(caps.session, SessionSupport::None),
        fork: caps.fork,
        events: caps.events,
        native_system: caps.native_system,
        commands: caps.commands,
        live_follow_up: caps.live_follow_up,
        approvals: caps.approvals,
    }
}

/// The capability chips Settings shows, phrased for a reader rather than as
/// enum names.
fn describe_caps(agent: Agent) -> Vec<String> {
    use agent_abstraction::SessionSupport;
    let caps = agent.caps();
    let mut chips = Vec::new();
    match caps.session {
        SessionSupport::Minted => chips.push("session id".to_string()),
        SessionSupport::Printed => chips.push("thread id".to_string()),
        _ => {}
    }
    if caps.fork {
        chips.push("fork".into());
    }
    if caps.events {
        chips.push("events".into());
    }
    chips
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_local_bin_is_searchable_without_overriding_shell_order() {
        let home = Path::new("/Users/example");
        let amended = with_user_local_bin(OsStr::new("/opt/homebrew/bin:/usr/bin"), Some(home));
        let entries: Vec<_> = std::env::split_paths(&amended).collect();
        assert_eq!(entries[0], Path::new("/opt/homebrew/bin"));
        assert_eq!(entries[1], Path::new("/usr/bin"));
        assert_eq!(entries[2], home.join(".local/bin"));
        assert_eq!(entries[3], home.join(".npm-global/bin"));
        assert_eq!(entries[4], home.join(".volta/bin"));
        #[cfg(target_os = "macos")]
        assert_eq!(
            entries[5],
            Path::new("/Applications/cmux.app/Contents/Resources/bin")
        );
    }

    #[test]
    fn user_local_bin_is_not_duplicated() {
        let home = Path::new("/Users/example");
        let amended =
            with_user_local_bin(OsStr::new("/Users/example/.local/bin:/usr/bin"), Some(home));
        let entries: Vec<_> = std::env::split_paths(&amended).collect();
        assert_eq!(entries[0], home.join(".local/bin"));
        assert_eq!(entries[1], PathBuf::from("/usr/bin"));
        assert_eq!(entries[2], home.join(".npm-global/bin"));
        assert_eq!(entries[3], home.join(".volta/bin"));
    }

    /// Every agent must produce a state the UI knows how to colour, whatever is
    /// or is not installed on the machine running the test.
    #[tokio::test]
    async fn every_agent_reports_a_renderable_state() {
        let known = ["connected", "outdated", "logged_out", "missing"];
        for status in detect_all().await {
            assert!(
                known.contains(&status.state.as_str()),
                "{:?} reported an unrenderable state {:?}",
                status.agent,
                status.state
            );
            assert!(
                !status.min_version.is_empty(),
                "{:?} should say what it was verified against",
                status.agent
            );
        }
    }

    /// A missing binary is not a signed-out one. Reporting `logged_out` would
    /// point someone at a login command for a CLI they have not installed.
    #[tokio::test]
    async fn a_missing_agent_never_reports_as_logged_out() {
        for status in detect_all().await {
            if status.state == "missing" {
                assert!(
                    status.version.is_none(),
                    "{:?} cannot report a version while missing",
                    status.agent
                );
            }
        }
    }

    #[test]
    fn caps_describe_claudes_fork_support() {
        let claude = describe_caps(Agent::Claude);
        assert!(
            claude.iter().any(|c| c == "fork"),
            "fork is Claude's distinguishing capability: {claude:?}"
        );
    }

    #[test]
    fn structured_caps_distinguish_interactive_providers() {
        let claude = provider_capabilities(Agent::Claude);
        let codex = provider_capabilities(Agent::Codex);
        assert!(claude.live_follow_up);
        assert!(claude.approvals);
        assert!(claude.commands);
        assert!(codex.live_follow_up);
        assert!(codex.approvals);
        assert!(!codex.commands);
    }
}
