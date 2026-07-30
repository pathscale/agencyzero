//! The settings record, owned by Rust and persisted through [`crate::store`].
//!
//! Rust holds the shape because Rust holds the file. The frontend's
//! `GlobalSettings` mirrors this, and every field carries `#[serde(default)]` so
//! a record written by an older build still loads when the frontend adds a
//! setting, rather than failing the read and resetting everything the user
//! chose.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where the record lives in the store.
pub const KEY: &str = "settings";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GlobalSettings {
    pub default_agent: String,
    /// Where a new project runs, and the parent of any directory it creates.
    ///
    /// Empty means "not chosen yet", which resolves to `$HOME/AgencyZero` at
    /// read time rather than here. A `Default` impl has no access to the app
    /// handle, and baking a literal home path into the record would freeze it
    /// against the machine that first wrote it.
    pub workspace_root: String,
    /// Per agent: which models the picker offers, and which one it starts on.
    pub models: BTreeMap<String, ModelSelection>,
    pub default_permission: String,
    /// Reasoning level a new tab starts on.
    pub default_effort: String,
    pub moderator: Moderator,
    /// How the Home task manager runs. See [`TaskManager`].
    pub task_manager: TaskManager,
    pub env_policy: String,
    pub forward_proxy_vars: bool,
    pub notifications: Notifications,
    /// What a session's `- [x]` does to an existing item: `"resolve"` marks
    /// it finished and keeps the row (the default — history stays readable),
    /// `"delete"` removes it outright for owners who want the list to be only
    /// what is still open.
    pub completed_items: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelSelection {
    pub enabled: Vec<String>,
    pub default: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Moderator {
    pub enabled: bool,
    pub model: String,
    pub sees: Vec<String>,
    pub on_check: String,
    pub on_critical: String,
    pub confine_to_dirs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Notifications {
    pub on_hold: bool,
    pub on_run_finished: bool,
    pub on_task_failed: bool,
    pub on_rate_limited: bool,
    pub sound: bool,
}

impl Default for ModelSelection {
    fn default() -> Self {
        ModelSelection {
            enabled: vec!["default".into()],
            default: "default".into(),
        }
    }
}

impl Default for Moderator {
    fn default() -> Self {
        Moderator {
            enabled: true,
            model: "haiku".into(),
            sees: vec!["transcript".into(), "events".into()],
            on_check: "hold_step".into(),
            on_critical: "cancel_run".into(),
            confine_to_dirs: true,
        }
    }
}

impl Default for Notifications {
    fn default() -> Self {
        Notifications {
            on_hold: true,
            on_run_finished: true,
            on_task_failed: true,
            on_rate_limited: true,
            sound: false,
        }
    }
}

/// How the Home task manager runs.
///
/// Its own model and effort rather than the prompt's: it is a different job.
/// The prompt is a conversation you steer; this one reads your projects and
/// keeps a list, runs unattended, and wants a cheap fast model far more often
/// than a frontier one. Sharing the prompt's setting would silently bill a
/// to-do list at Opus rates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskManager {
    /// A Claude model id. Claude only for now — it is the one agent the run
    /// path drives, so offering the others here would be a control that cannot
    /// take effect.
    pub model: String,
    pub effort: String,
    /// Where its runs execute, first entry as the working directory.
    ///
    /// The task manager has no project row to carry directories the way a
    /// project does, and the run's scope matters: `read_only` maps to Claude's
    /// don't-ask mode, which denies reads *outside* the working tree without
    /// prompting. Empty means the workspace root, which can only read itself.
    pub dirs: Vec<String>,
}

impl Default for TaskManager {
    fn default() -> Self {
        TaskManager {
            // Cheap and fast: this is a list keeper, not a reasoner.
            model: "haiku".into(),
            effort: "medium".into(),
            dirs: Vec::new(),
        }
    }
}

impl Default for GlobalSettings {
    /// What a first launch starts from.
    ///
    /// A deliberately short model selection out of long catalogues: the four
    /// Claude aliases that name models, Codex's top three, and the only Copilot
    /// id a Free plan permits. The rest are one checkbox away in Settings.
    fn default() -> Self {
        let sel = |enabled: &[&str], default: &str| ModelSelection {
            enabled: enabled.iter().map(|s| (*s).to_string()).collect(),
            default: default.to_string(),
        };
        GlobalSettings {
            default_agent: "claude".into(),
            workspace_root: String::new(),
            models: BTreeMap::from([
                (
                    "claude".to_string(),
                    // The `[1m]` variants are the only way to get a 1M context window;
                    // without them here the picker offers 200k and nothing else.
                    sel(
                        &[
                            "default",
                            "opus",
                            "sonnet",
                            "haiku",
                            "opus[1m]",
                            "sonnet[1m]",
                        ],
                        "sonnet",
                    ),
                ),
                (
                    "codex".to_string(),
                    sel(&["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"], "gpt-5.6-sol"),
                ),
                ("copilot".to_string(), sel(&["auto"], "auto")),
            ]),
            default_permission: "read_only".into(),
            default_effort: "high".into(),
            moderator: Moderator::default(),
            task_manager: TaskManager::default(),
            env_policy: "minimal".into(),
            forward_proxy_vars: false,
            notifications: Notifications::default(),
            completed_items: "resolve".into(),
        }
    }
}

/// Merge a partial patch into a stored record.
///
/// Objects merge key by key; everything else replaces. **Arrays replace rather
/// than merge**, which is what the model selection needs: unchecking a model
/// sends the shorter list, and an element-wise merge would keep the removed id.
pub fn merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                if value.is_null() {
                    target.remove(key);
                } else {
                    merge(target.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_through_json() {
        let json = serde_json::to_string(&GlobalSettings::default()).expect("should serialize");
        let back: GlobalSettings = serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(back.models["claude"].default, "sonnet");
        assert!(json.contains("defaultAgent"), "must be camelCase: {json}");
    }

    /// A record written before a setting existed must still load. Without the
    /// serde defaults this would fail the read, and a failed read resets
    /// everything the user chose.
    #[test]
    fn a_record_missing_newer_fields_still_loads() {
        let old = r#"{"defaultAgent":"codex"}"#;
        let loaded: GlobalSettings = serde_json::from_str(old).expect("should tolerate absence");
        assert_eq!(loaded.default_agent, "codex");
        assert_eq!(
            loaded.moderator.model, "haiku",
            "absent blocks use defaults"
        );
    }

    /// The case the model picker depends on: unchecking a model sends a shorter
    /// array, and merging element-wise would silently keep what was removed.
    #[test]
    fn arrays_replace_rather_than_merge() {
        let mut target = serde_json::json!({
            "models": { "claude": { "enabled": ["default", "opus", "sonnet"], "default": "sonnet" } }
        });
        let patch = serde_json::json!({
            "models": { "claude": { "enabled": ["default"], "default": "default" } }
        });
        merge(&mut target, &patch);
        assert_eq!(
            target["models"]["claude"]["enabled"],
            serde_json::json!(["default"])
        );
    }

    /// A patch touching one agent must not disturb another.
    #[test]
    fn a_patch_leaves_untouched_branches_alone() {
        let mut target = serde_json::to_value(GlobalSettings::default()).expect("should serialize");
        let patch = serde_json::json!({ "models": { "claude": { "enabled": ["opus"], "default": "opus" } } });
        merge(&mut target, &patch);

        let merged: GlobalSettings = serde_json::from_value(target).expect("should deserialize");
        assert_eq!(merged.models["claude"].default, "opus");
        assert_eq!(
            merged.models["codex"].default, "gpt-5.6-sol",
            "codex should be untouched"
        );
        assert_eq!(merged.env_policy, "minimal", "unrelated fields survive");
    }
}
