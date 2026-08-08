//! Account-wide usage, from `agent-abstraction`'s `account_usage`.
//!
//! Distinct from `Usage`, which measures one run. This is the plan behind the
//! runs: how much of a window is spent, when it resets, what credits remain.
//!
//! # Only one agent can answer, and that is the honest answer
//!
//! `Agent::reports_account_usage()` is asked first, per agent, rather than
//! calling and interpreting a failure — a host should be able to decide whether
//! to draw the panel without discovering the answer from an error.
//!
//! Today that means **Codex answers and Claude does not**. Claude reports quota
//! only *during* a run, as `Event::RateLimit`, carrying the window, its reset
//! time and whether the request was allowed. The percentages its `/usage` screen
//! shows are not on the wire, and that screen itself says its figures are
//! approximate and cover only local sessions on one machine. Scraping them would
//! produce a number that looks authoritative and is not, which is the one thing
//! this readout must never do.
//!
//! So the window says, per agent, either a real figure or why there is none.
//! [`AgentQuota::supported`] is what keeps "could not ask" apart from "asked,
//! and there are no limits in force" — a bare empty list flattens the two, and
//! they mean opposite things.

use agency_proxy_protocol::ProviderAccountUsage;
use agent_abstraction::Agent;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

/// One quota window, in the provider's own terms.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindowDto {
    /// The provider's own name for it, e.g. `primary`.
    pub window: String,
    /// Share consumed, 0..1.
    ///
    /// The crate reports 0..100 as the provider gave it; this is that divided by
    /// a hundred, and **never** synthesised when the provider did not report one.
    pub used_fraction: Option<f64>,
    /// How long the window runs. Codex reports 10080 for a week.
    pub window_minutes: Option<u64>,
    /// ISO 8601, converted from the crate's epoch seconds for the webview.
    pub resets_at: Option<String>,
}

/// What one agent says about the account behind it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuota {
    pub agent: Agent,
    /// False when this agent cannot report account usage at all. The window says
    /// "not reported" rather than "no limits", which are different facts.
    pub supported: bool,
    /// Empty with `supported: true` genuinely means no windows are in force.
    pub windows: Vec<QuotaWindowDto>,
    pub plan: Option<String>,
    /// A pay-as-you-go balance, as the provider wrote it. Text, not a float: a
    /// decimal balance must not be rounded on its way to a display.
    pub credit_balance: Option<String>,
    pub unlimited: bool,
    /// Why there is nothing to show, when `supported` is false or the call
    /// failed. Rendered as-is.
    pub detail: String,
}

/// Where every agent's account stands.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuotaReport {
    pub agents: Vec<AgentQuota>,
    /// ISO 8601, so a stale answer is visibly stale rather than silently so.
    pub checked_at: String,
}

fn epoch_to_iso(seconds: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(seconds, 0).map(|at| at.to_rfc3339())
}

/// Ask one agent, having first asked whether it can answer.
fn from_proxy(provider: ProviderAccountUsage) -> Result<AgentQuota, String> {
    let agent = match provider.provider.as_str() {
        "claude" => Agent::Claude,
        "codex" => Agent::Codex,
        "copilot" => Agent::Copilot,
        other => {
            return Err(format!(
                "AgencyProxy reported unknown quota provider: {other}"
            ));
        }
    };
    let mut quota = AgentQuota {
        agent,
        supported: provider.supported,
        windows: Vec::new(),
        plan: None,
        credit_balance: None,
        unlimited: false,
        detail: String::new(),
    };

    if !provider.supported {
        quota.detail = match agent {
            Agent::Claude => "Claude reports quota only during a run, as a rate limit. \
                              Its usage percentages are not on the wire."
                .into(),
            _ => "This agent does not report account-wide usage.".into(),
        };
        return Ok(quota);
    }

    match provider.usage {
        Some(value) => {
            let usage: agent_abstraction::AccountUsage = serde_json::from_value(value)
                .map_err(|error| format!("AgencyProxy returned invalid account usage: {error}"))?;
            quota.plan = usage.plan.clone();
            quota.unlimited = usage.credits.as_ref().is_some_and(|c| c.unlimited);
            quota.credit_balance = usage.credits.as_ref().and_then(|c| c.balance.clone());
            quota.windows = usage
                .windows
                .iter()
                .map(|window| QuotaWindowDto {
                    window: window.id.clone(),
                    // 0..100 from the provider, 0..1 for the bar that draws it.
                    used_fraction: window.used_percent.map(|percent| percent / 100.0),
                    window_minutes: window.window_minutes,
                    resets_at: window.resets_at.and_then(epoch_to_iso),
                })
                .collect();
        }
        None => {
            let error = provider.error.unwrap_or_else(|| "no detail".into());
            // Reachable but unhappy: the agent can answer in principle and did
            // not this time. Not the same as "cannot answer", so it is said
            // differently rather than folded into the unsupported case.
            quota.detail = format!("could not read account usage: {error}");
            crate::log!(
                crate::log::Level::Warn,
                "quota",
                "{agent:?}: could not read account usage: {error}"
            );
        }
    }

    Ok(quota)
}

/// Where every agent's account stands, for the window-wide usage readout.
#[tauri::command]
pub async fn list_quota(state: State<'_, AppState>) -> Result<QuotaReport, String> {
    let agents = state
        .proxy
        .account_usage()
        .await?
        .into_iter()
        .map(from_proxy)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(QuotaReport {
        agents,
        checked_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The distinction the whole module exists to preserve. Claude cannot report
    /// account usage, and saying so is not the same as saying "no limits".
    #[test]
    fn an_agent_that_cannot_answer_says_so_rather_than_reporting_zero() {
        let quota = from_proxy(ProviderAccountUsage {
            provider: "claude".into(),
            supported: false,
            usage: None,
            error: None,
        })
        .expect("known provider maps");

        assert!(!quota.supported, "Claude does not report account usage");
        assert!(quota.windows.is_empty());
        assert!(
            quota.detail.contains("during a run"),
            "it has to explain where its quota does show up, got {:?}",
            quota.detail
        );
    }

    /// Asked up front rather than discovered from an error, so the UI can decide
    /// whether to draw a panel at all.
    #[test]
    fn the_crate_is_asked_which_agents_can_answer() {
        assert!(!Agent::Claude.reports_account_usage());
        assert!(Agent::Codex.reports_account_usage());
    }

    /// The crate's field is explicitly amount used, 0..100. Keep it in that
    /// direction while converting only its scale for the webview. Inverting it
    /// would make Codex disagree with Claude and turn 45% used into 55% used.
    #[test]
    fn a_percentage_becomes_a_fraction() {
        // `UsageWindow` is `#[non_exhaustive]`, so the mapping is exercised on
        // the values rather than through a struct literal the crate forbids.
        let used_percent = Some(45.0_f64);
        let dto = QuotaWindowDto {
            window: "primary".into(),
            used_fraction: used_percent.map(|percent| percent / 100.0),
            window_minutes: Some(10_080),
            resets_at: epoch_to_iso(1_800_000_000),
        };

        assert_eq!(dto.used_fraction, Some(0.45));
        assert_eq!(dto.window_minutes, Some(10_080));
        assert!(dto.resets_at.is_some(), "epoch seconds become ISO 8601");
    }

    /// Absent must stay absent. A window the provider gave no percentage for
    /// renders as its wording, never as an empty bar that reads like zero used.
    #[test]
    fn an_unreported_percentage_stays_absent() {
        let dto = QuotaWindowDto {
            window: "primary".into(),
            used_fraction: None::<f64>.map(|percent: f64| percent / 100.0),
            window_minutes: None,
            resets_at: None,
        };
        assert_eq!(dto.used_fraction, None);
    }
}
