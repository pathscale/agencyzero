//! Experimental request policies compiled only into the experimental profile.
//!
//! The production agent adapter deliberately has no dependency on these
//! capabilities. AgencyZero owns the narrow integration boundary and keeps the
//! prepared policy alive for exactly as long as the request's child process.

use agent_abstraction::{Agent, Request};

#[cfg(all(feature = "experimental", target_os = "macos"))]
const CLAUDE_TOKEN_SERVICE: &str = "com.pathscale.agencyzero.experimental.claude-usage";
#[cfg(all(feature = "experimental", target_os = "macos"))]
const CLAUDE_TOKEN_ACCOUNT: &str = "oauth-access-token";
#[cfg(all(feature = "experimental", target_os = "macos"))]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;

/// Whether the experimental profile has a Claude token in the OS secret store.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTokenStatus {
    pub configured: bool,
}

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
async fn read_claude_token() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        match security_framework::passwords::get_generic_password(
            CLAUDE_TOKEN_SERVICE,
            CLAUDE_TOKEN_ACCOUNT,
        ) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "the Claude token in Keychain is not valid UTF-8".to_string()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(format!(
                "could not read the Claude token from Keychain: {error}"
            )),
        }
    })
    .await
    .map_err(|error| format!("the Keychain read task failed: {error}"))?
}

/// Report token presence without ever returning the secret to the webview.
#[tauri::command]
pub async fn claude_token_status() -> Result<ClaudeTokenStatus, String> {
    #[cfg(all(feature = "experimental", target_os = "macos"))]
    {
        Ok(ClaudeTokenStatus {
            configured: read_claude_token().await?.is_some(),
        })
    }

    #[cfg(not(all(feature = "experimental", target_os = "macos")))]
    Err("Claude usage is available only in the macOS experimental profile".to_string())
}

/// Validate and store a Claude OAuth token in the user's macOS Keychain.
#[tauri::command]
pub async fn set_claude_token(token: String) -> Result<ClaudeTokenStatus, String> {
    #[cfg(all(feature = "experimental", target_os = "macos"))]
    {
        agent_experimental::claude_usage::ClaudeAccessToken::new(token.clone())
            .map_err(|error| error.to_string())?;
        tokio::task::spawn_blocking(move || {
            security_framework::passwords::set_generic_password(
                CLAUDE_TOKEN_SERVICE,
                CLAUDE_TOKEN_ACCOUNT,
                token.as_bytes(),
            )
            .map_err(|error| format!("could not save the Claude token in Keychain: {error}"))
        })
        .await
        .map_err(|error| format!("the Keychain write task failed: {error}"))??;
        Ok(ClaudeTokenStatus { configured: true })
    }

    #[cfg(not(all(feature = "experimental", target_os = "macos")))]
    {
        let _ = token;
        Err("Claude usage is available only in the macOS experimental profile".to_string())
    }
}

/// Remove the experimental Claude token from the user's macOS Keychain.
#[tauri::command]
pub async fn remove_claude_token() -> Result<ClaudeTokenStatus, String> {
    #[cfg(all(feature = "experimental", target_os = "macos"))]
    {
        tokio::task::spawn_blocking(
            || match security_framework::passwords::delete_generic_password(
                CLAUDE_TOKEN_SERVICE,
                CLAUDE_TOKEN_ACCOUNT,
            ) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
                Err(error) => Err(format!(
                    "could not remove the Claude token from Keychain: {error}"
                )),
            },
        )
        .await
        .map_err(|error| format!("the Keychain delete task failed: {error}"))??;
        Ok(ClaudeTokenStatus { configured: false })
    }

    #[cfg(not(all(feature = "experimental", target_os = "macos")))]
    Err("Claude usage is available only in the macOS experimental profile".to_string())
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

/// Fetch current Claude subscription usage with the token held in Keychain.
#[tauri::command]
pub async fn claude_usage() -> Result<ClaudeUsageDto, String> {
    #[cfg(all(feature = "experimental", target_os = "macos"))]
    {
        let raw = read_claude_token()
            .await?
            .ok_or_else(|| "save a Claude token before refreshing usage".to_string())?;
        let token = agent_experimental::claude_usage::ClaudeAccessToken::new(raw)
            .map_err(|error| error.to_string())?;
        let client = agent_experimental::claude_usage::ClaudeUsageClient::new()
            .map_err(|error| error.to_string())?;
        let usage = client
            .fetch(&token)
            .await
            .map_err(|error| error.to_string())?;

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
