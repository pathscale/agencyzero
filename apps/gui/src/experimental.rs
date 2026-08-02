//! Experimental request policies compiled only into the experimental profile.
//!
//! The production agent adapter deliberately has no dependency on these
//! capabilities. AgencyZero owns the narrow integration boundary and keeps the
//! prepared policy alive for exactly as long as the request's child process.

use agent_abstraction::{Agent, Request};

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

/// A request plus any invocation-scoped resources its experimental policy owns.
pub struct AppliedRequest {
    request: Request,
    #[cfg(feature = "experimental")]
    _expanded_context: Option<agent_experimental::CodexExpandedContext>,
}

impl AppliedRequest {
    /// Borrow the request while retaining its policy resources in this wrapper.
    pub fn request(&self) -> &Request {
        &self.request
    }
}

/// Apply experimental policy when this build and model opt into it.
///
/// Standard builds compile a no-op implementation. Experimental builds fail
/// visibly if the installed Codex version or bundled catalog is not the shape
/// that was reviewed, rather than claiming expanded context while silently
/// running the stock policy.
pub fn apply(request: Request, _agent: Agent, _model: &str) -> Result<AppliedRequest, String> {
    #[cfg(feature = "experimental")]
    {
        if eligible(_agent, _model) {
            let context = agent_experimental::CodexExpandedContext::prepare(
                &agent_experimental::ExpandedContextOptions::default(),
            )
            .map_err(|error| format!("expanded Codex context is unavailable: {error:#}"))?;
            let args = context
                .process_args()
                .map_err(|error| format!("could not prepare expanded Codex context: {error:#}"))?;
            return Ok(AppliedRequest {
                request: request.unchecked_args(args),
                _expanded_context: Some(context),
            });
        }
    }

    Ok(AppliedRequest {
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
