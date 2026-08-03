//! Each agent's model catalogue, from `agent-abstraction`.

use agent_abstraction::{Agent, Model, Source};
use serde::Serialize;

use crate::agents::AGENTS;

/// One model, renamed for the webview.
///
/// The crate serializes `is_default` in snake_case and every type the frontend
/// already has is camelCase, so a DTO does the renaming rather than the
/// TypeScript bending to match one field. `kind` needs no help: its own serde
/// attribute already emits `alias` / `pinned`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDto {
    pub id: String,
    pub name: String,
    pub note: String,
    pub kind: agent_abstraction::Kind,
    pub efforts: Vec<String>,
    pub is_default: bool,
}

impl From<Model> for ModelDto {
    fn from(model: Model) -> Self {
        ModelDto {
            id: model.id.into_owned(),
            name: model.name.into_owned(),
            note: model.note.into_owned(),
            kind: model.kind,
            efforts: model.efforts.into_iter().map(|e| e.into_owned()).collect(),
            is_default: model.is_default,
        }
    }
}

/// AgencyZero's one verified supplement to the crate's Claude catalogue.
///
/// `agent-abstraction` records that Claude 2.1.212 resolves the moving `opus`
/// alias to this exact id, but its pinned list starts at Opus 5. Keeping the
/// explicit id here lets a project stay on 4.8 even after the alias moves.
fn model_dtos(agent: Agent, models: Vec<Model>) -> Vec<ModelDto> {
    let mut models: Vec<ModelDto> = models.into_iter().map(ModelDto::from).collect();
    if agent == Agent::Claude && !models.iter().any(|model| model.id == "claude-opus-4-8") {
        let at = models
            .iter()
            .position(|model| model.id == "claude-opus-5")
            .unwrap_or(models.len());
        models.insert(
            at,
            ModelDto {
                id: "claude-opus-4-8".into(),
                name: "Claude Opus 4.8".into(),
                note: "Pinned Claude Opus 4.8, independent of the moving Opus alias".into(),
                kind: agent_abstraction::Kind::Pinned,
                efforts: ["low", "medium", "high", "xhigh", "max"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                is_default: false,
            },
        );
    }
    models
}

/// One agent's catalogue, flattened so the webview does not have to reach
/// through a nested `verified` object to render a single provenance line.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelsDto {
    pub agent: Agent,
    pub models: Vec<ModelDto>,
    pub source: Source,
    pub checked: String,
    pub against: String,
    pub discovered: bool,
}

/// The CLI release this build's mappings were verified against.
#[must_use]
pub fn verified_against(agent: Agent) -> String {
    agent.models_verified().against.to_string()
}

/// Every agent's model catalogue.
///
/// With `discover`, each CLI is asked to enumerate rather than trusting the
/// crate's compiled list. Only Codex can answer that today; Claude and Copilot
/// return `Error::Unsupported` and fall back here.
///
/// A discovery failure is **not** an error for the whole call. It falls back to
/// the compiled list with `discovered: false`, which is the same thing the two
/// agents that cannot be asked report. That is not a silent downgrade: the
/// frontend renders provenance from these fields, so a failed discovery reads as
/// "from vendor documentation, checked <date>" rather than "asked just now", and
/// the difference is visible in Settings. Failing the whole call instead would
/// leave the picker with nothing over one agent's bad output.
#[tauri::command]
pub async fn list_models(discover: bool) -> Vec<AgentModelsDto> {
    let mut catalogues = Vec::with_capacity(AGENTS.len());
    for agent in AGENTS {
        let verified = agent.models_verified();
        let discovered = if discover {
            agent.discover_models().await.ok()
        } else {
            None
        };
        let has_discovered = discovered.is_some();
        catalogues.push(AgentModelsDto {
            agent,
            models: model_dtos(agent, discovered.unwrap_or_else(|| agent.models())),
            source: verified.source,
            checked: verified.checked.to_string(),
            against: verified.against.to_string(),
            discovered: has_discovered,
        });
    }
    catalogues
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The webview's `AgentModels` type is camelCase and the crate's `Model` is
    /// not, so the DTO is the only thing keeping the two in step. A rename that
    /// silently reverted would leave every model reading as not-default.
    #[tokio::test]
    async fn catalogues_serialize_in_the_shape_the_webview_expects() {
        let catalogues = list_models(false).await;
        assert_eq!(catalogues.len(), AGENTS.len());

        let json = serde_json::to_value(&catalogues).expect("should serialize");
        let claude = &json[0];
        assert_eq!(claude["agent"], "claude");
        assert!(
            claude["models"].as_array().is_some_and(|m| !m.is_empty()),
            "an empty catalogue would leave the picker with nothing"
        );
        assert!(
            claude["models"][0].get("isDefault").is_some(),
            "is_default must reach the webview as isDefault: {}",
            claude["models"][0]
        );
        assert!(
            claude["models"][0].get("is_default").is_none(),
            "the snake_case field must not also be emitted"
        );
    }

    /// Without `discover` nothing is spawned, so every entry must say so. The
    /// Settings provenance line reads this to decide between "asked just now"
    /// and naming the weaker evidence behind the compiled list.
    #[tokio::test]
    async fn a_compiled_catalogue_never_claims_to_have_been_discovered() {
        for catalogue in list_models(false).await {
            assert!(
                !catalogue.discovered,
                "{:?} claimed discovery without being asked",
                catalogue.agent
            );
        }
    }

    /// Exactly one preselection per agent, or the picker opens on nothing.
    #[tokio::test]
    async fn every_agent_offers_one_default() {
        for catalogue in list_models(false).await {
            let defaults = catalogue.models.iter().filter(|m| m.is_default).count();
            assert_eq!(defaults, 1, "{:?} should mark one default", catalogue.agent);
        }
    }

    #[tokio::test]
    async fn claude_opus_4_8_is_independently_selectable() {
        let catalogues = list_models(false).await;
        let claude = catalogues
            .iter()
            .find(|catalogue| catalogue.agent == Agent::Claude)
            .expect("Claude catalogue");
        let opus = claude
            .models
            .iter()
            .find(|model| model.id == "claude-opus-4-8")
            .expect("pinned Opus 4.8");

        assert_eq!(opus.name, "Claude Opus 4.8");
        assert_eq!(opus.kind, agent_abstraction::Kind::Pinned);
    }
}
