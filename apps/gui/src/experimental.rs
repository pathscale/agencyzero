//! Experimental request policies compiled only into the experimental profile.
//!
//! The production agent adapter deliberately has no dependency on these
//! capabilities. AgencyZero owns the narrow integration boundary and keeps the
//! prepared policy alive for exactly as long as the request's child process.

use agency_proxy_protocol::RunRequest;
use agent_abstraction::Agent;

/// One provider-defined Claude usage window.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageWindowDto {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

/// One provider-defined Claude limit, including an optional model scope.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageLimitDto {
    pub kind: String,
    pub percent: f64,
    pub severity: Option<String>,
    pub resets_at: Option<String>,
    pub model: Option<String>,
}

/// Current Claude subscription usage returned only to the experimental UI.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageDto {
    pub five_hour: Option<ClaudeUsageWindowDto>,
    pub seven_day: Option<ClaudeUsageWindowDto>,
    pub seven_day_sonnet: Option<ClaudeUsageWindowDto>,
    pub limits: Vec<ClaudeUsageLimitDto>,
    pub checked_at: String,
}

/// A proxy request plus invocation-scoped experimental policy resources.
pub struct AppliedProxyRequest {
    request: RunRequest,
    #[cfg(feature = "experimental")]
    _expanded_context: Option<agent_experimental::CodexExpandedContext>,
}

impl AppliedProxyRequest {
    /// Borrow the wire request while retaining its policy resources.
    pub fn request(&self) -> &RunRequest {
        &self.request
    }
}

/// Apply the same experimental policy at the AgencyProxy boundary.
pub fn apply_proxy(
    #[allow(unused_mut)] mut request: RunRequest,
    _agent: Agent,
    _model: &str,
) -> Result<AppliedProxyRequest, String> {
    #[cfg(feature = "experimental")]
    {
        if eligible(_agent, _model) {
            let context = agent_experimental::CodexExpandedContext::prepare(
                &agent_experimental::ExpandedContextOptions::default(),
            )
            .map_err(|error| format!("expanded Codex context is unavailable: {error:#}"))?;
            request.unchecked_args = context
                .process_args()
                .map_err(|error| format!("could not prepare expanded Codex context: {error:#}"))?;
            return Ok(AppliedProxyRequest {
                request,
                _expanded_context: Some(context),
            });
        }
    }

    Ok(AppliedProxyRequest {
        request,
        #[cfg(feature = "experimental")]
        _expanded_context: None,
    })
}

/// Whether a request receives the first expanded-context experiment.
///
/// Other Codex models keep their bundled policies until separately measured.
#[cfg(feature = "experimental")]
fn eligible(agent: Agent, model: &str) -> bool {
    agent == Agent::Codex && model == agent_experimental::DEFAULT_MODEL
}

/// A short boot/run disclosure for diagnostics.
#[must_use]
pub const fn profile_name() -> &'static str {
    if cfg!(feature = "experimental") {
        "experimental"
    } else {
        "standard"
    }
}

#[cfg(all(feature = "experimental", target_os = "macos"))]
fn usage_window(
    window: agent_experimental::claude_usage::ClaudeUsageWindow,
) -> ClaudeUsageWindowDto {
    ClaudeUsageWindowDto {
        utilization: window.utilization,
        resets_at: window.resets_at,
    }
}

/// Fetch current Claude subscription usage through Claude Code's managed login.
#[tauri::command]
pub async fn claude_usage() -> Result<ClaudeUsageDto, String> {
    #[cfg(all(feature = "experimental", target_os = "macos"))]
    {
        let client = agent_experimental::claude_usage::ClaudeManagedUsageClient::new()
            .map_err(|error| error.to_string())?;
        let usage = client.fetch().await.map_err(|error| error.to_string())?;

        Ok(ClaudeUsageDto {
            five_hour: usage.five_hour.map(usage_window),
            seven_day: usage.seven_day.map(usage_window),
            seven_day_sonnet: usage.seven_day_sonnet.map(usage_window),
            limits: usage
                .limits
                .into_iter()
                .map(|limit| ClaudeUsageLimitDto {
                    kind: limit.kind,
                    percent: limit.percent,
                    severity: limit.severity,
                    resets_at: limit.resets_at,
                    model: limit
                        .scope
                        .and_then(|scope| scope.model)
                        .and_then(|model| model.display_name),
                })
                .collect(),
            checked_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    #[cfg(not(all(feature = "experimental", target_os = "macos")))]
    Err("Claude usage is available only in the macOS experimental profile".to_string())
}

#[cfg(all(test, feature = "experimental"))]
mod tests {
    use super::*;

    #[test]
    fn only_sol_is_eligible_for_the_context_experiment() {
        assert!(eligible(Agent::Codex, "gpt-5.6-sol"));
        assert!(!eligible(Agent::Codex, "gpt-5.6-terra"));
        assert!(!eligible(Agent::Claude, "gpt-5.6-sol"));
    }
}
