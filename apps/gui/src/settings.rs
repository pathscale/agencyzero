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
    /// How many subsequent user turns an agent-finished row remains visible
    /// before AgencyZero retires it. Persisted so runtime behavior, Settings,
    /// and the injected instruction all read one value.
    pub agent_finished_retention_turns: u8,
    /// How the workspace is coloured. See [`Theme`].
    pub theme: Theme,
    /// Explicit local consent for the content-free PS deployment study.
    pub study_analytics: StudyAnalytics,
    /// Inject the AgencyZero + Prompt Syntax operating instructions into every
    /// turn's system prompt, for the extended features (items, questions, PR
    /// tracking) they enable. On by default: the app's own directives only work
    /// if the agent is told the surface. A user file `AgencyZeroPerTurn.md` in
    /// the config directory overrides the built-in text; absent, the embedded
    /// default is used, so this is never silently empty. See
    /// [`crate::per_turn`].
    #[serde(default = "default_true")]
    pub per_turn_injection: bool,
    /// Check the signed release manifest after launch. Manual checks and
    /// installs remain available when this is off; the application never
    /// installs an update merely because a check found one.
    #[serde(default = "default_true")]
    pub automatic_update_checks: bool,
    /// Which lifecycle action an agent-authored Prompt Syntax directive may
    /// schedule after its current turn finishes. The default is deliberately
    /// `"disabled"`: restarting or replacing the running binary is owner
    /// authority until the owner explicitly delegates it.
    #[serde(default = "default_agent_restart_policy")]
    pub agent_restart_policy: String,
    /// The project-tab arrangement that travels with a store backup.
    ///
    /// `None` identifies a settings row written before this field existed, so
    /// the frontend can migrate its old webview-local preference once rather
    /// than mistaking the absence for an intentionally empty strip.
    #[serde(default)]
    pub workspace_tabs: Option<WorkspaceTabs>,
    /// How a PR review is shaped: the model each reviewer uses, and the prompt.
    #[serde(default)]
    pub review: Review,
}

/// The PR-review side-channel's configuration.
///
/// A review runs the chosen agent headlessly on the PR and drops the result
/// inline in the transcript for the owner to copy; it is never sent to the Home
/// agent. `prompt` is prepended to the PR URL; empty means the built-in default.
/// Per-agent model empty means the agent's own default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Review {
    /// The review instruction, prepended to the PR URL. Empty uses the default.
    pub prompt: String,
    /// Model per reviewer agent (`claude` / `codex` / `copilot`); empty is the
    /// agent's default.
    pub models: BTreeMap<String, String>,
}

/// The portable part of the tab strip.
///
/// Utility tabs are deliberately excluded: Settings and Analytics describe
/// this particular window, while project tabs describe the workspace the
/// owner expects a backup to restore.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceTabs {
    pub open_project_keys: Vec<String>,
    pub active_project_key: String,
}

/// The built-in review instruction, used when the setting is blank.
pub const DEFAULT_REVIEW_PROMPT: &str = "Review this pull request for correctness bugs, security issues, and \
     anything that would block merge. Be concrete: name the file and line, say \
     what is wrong and why, and rank findings most severe first. If it is solid, \
     say so briefly.";

/// `#[serde(default)]` for a bool field that should default to `true` rather
/// than `false` — an absent flag on an older settings row must read as on.
fn default_true() -> bool {
    true
}

fn default_agent_restart_policy() -> String {
    "disabled".into()
}

/// The opt-in boundary for the PromptSyntax deployment study.
///
/// The session fields are assigned by the backend on an off-to-on transition.
/// They are not user-editable labels: every recorded row carries the id so a
/// stopped and later restarted study cannot be mistaken for one interval.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct StudyAnalytics {
    pub enabled: bool,
    pub session_id: String,
    pub enabled_at: String,
}

/// The theme picker's two axes, as the webview applies them.
///
/// Here rather than in the webview's own storage because settings in this app
/// are rows in WorkTable: `localStorage` would not survive a data directory
/// move, would not show up in an export, and would leave Settings displaying a
/// control whose value lives somewhere the rest of Settings does not.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Theme {
    /// The accent, as a `#rrggbb` hex string. Drives `--color-primary` and
    /// everything derived from it — the composer ring, the status halo, active
    /// states.
    ///
    /// Empty means "the palette's own yellow", deliberately rather than the
    /// literal `#ffee58`: writing the default in here would freeze this record
    /// against the stylesheet, and the two would drift the first time the
    /// design changed.
    pub accent: String,
    /// Lightness added to every surface, in oklch percentage points, with the
    /// matching amount taken off every text rung. One number, because the two
    /// halves only make sense together: lifting the desk without bringing the
    /// text down trades one glare for another.
    ///
    /// 0 is the palette as designed. Clamped where it is applied rather than
    /// here, so a record from a future build with a wider range cannot make
    /// this one unreadable — it renders at the edge instead.
    pub softness: f32,
    /// How much of the accent is mixed into every surface, as a percentage.
    ///
    /// The difference between a picked colour that changes buttons and one that
    /// changes the workspace. nofilter.io washes its base tiers at 8–11%, which
    /// is why its picker reads as a theme and an accent-only version reads as a
    /// highlight — that version shipped here first and was wrong.
    ///
    /// Ignored while `accent` is empty: the designed palette is grey, not grey
    /// washed with its own yellow.
    pub wash: f32,
    /// Lightness added back to every text rung, in oklch percentage points.
    ///
    /// Softness dims the text as it lifts the surfaces, which is right for
    /// glare and wrong for anyone who then finds the prose faded — the two
    /// wants are separate and this is the second one. Negative dims further,
    /// positive brightens; 0 leaves the ladder where softness put it.
    pub text_brightness: f32,
}

impl Default for Theme {
    fn default() -> Self {
        Theme {
            accent: String::new(),
            softness: 0.0,
            // Matches `DEFAULT_WASH` in the webview's lib/theme.ts: a colour
            // picked with no opinion about strength washes at 10%.
            wash: 10.0,
            text_brightness: 0.0,
        }
    }
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
    /// Which provider owns this conversation.
    pub agent: String,
    pub model: String,
    pub effort: String,
    /// The same posture vocabulary project tabs use.
    pub permission: String,
    /// Where its runs execute, first entry as the working directory.
    ///
    /// The task manager has no project row to carry directories the way a
    /// project does, and every provider applies its permission posture within
    /// this scope. Empty means the workspace root.
    pub dirs: Vec<String>,
}

impl Default for TaskManager {
    fn default() -> Self {
        TaskManager {
            agent: "codex".into(),
            // Cheap and fast: this is a list keeper, not a reasoner.
            model: "gpt-5.6-luna".into(),
            effort: "low".into(),
            permission: "ask".into(),
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
                    sel(
                        &["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
                        "gpt-5.6-sol",
                    ),
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
            agent_finished_retention_turns: 1,
            theme: Theme::default(),
            study_analytics: StudyAnalytics::default(),
            per_turn_injection: true,
            automatic_update_checks: true,
            agent_restart_policy: "disabled".into(),
            workspace_tabs: None,
            review: Review::default(),
        }
    }
}

/// Keep the task manager on a selected, economical model.
///
/// Existing installs may still name Haiku after it was removed from their
/// selected models. Luna is preferred when selected, then another selected
/// Codex model, then Sonnet, then the configured provider default.
pub fn normalize_task_manager(settings: &mut GlobalSettings) {
    let selected = |agent: &str, model: &str| {
        settings
            .models
            .get(agent)
            .is_some_and(|selection| selection.enabled.iter().any(|id| id == model))
    };
    let current_selected = selected(&settings.task_manager.agent, &settings.task_manager.model);
    if current_selected {
        return;
    }

    let priorities = [
        ("codex", "gpt-5.6-luna", "low"),
        ("codex", "gpt-5.6-terra", "low"),
        ("codex", "gpt-5.6-sol", "low"),
        ("claude", "sonnet", "medium"),
    ];
    if let Some((agent, model, effort)) = priorities
        .into_iter()
        .find(|(agent, model, _)| selected(agent, model))
    {
        settings.task_manager.agent = agent.into();
        settings.task_manager.model = model.into();
        settings.task_manager.effort = effort.into();
        return;
    }

    if let Some((agent, selection)) = settings
        .models
        .iter()
        .find(|(_, selection)| selection.enabled.iter().any(|id| id == &selection.default))
    {
        settings.task_manager.agent.clone_from(agent);
        settings.task_manager.model.clone_from(&selection.default);
        settings.task_manager.effort = if agent == "codex" { "low" } else { "medium" }.into();
    }
}

/// Clamp persisted settings whose valid range is narrower than their wire type.
pub fn normalize(settings: &mut GlobalSettings) {
    normalize_task_manager(settings);
    settings.agent_finished_retention_turns = settings.agent_finished_retention_turns.clamp(1, 3);
    if !matches!(
        settings.agent_restart_policy.as_str(),
        "disabled" | "restart" | "restart_and_update"
    ) {
        settings.agent_restart_policy = "disabled".into();
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
        assert_eq!(back.task_manager.agent, "codex");
        assert_eq!(back.task_manager.model, "gpt-5.6-luna");
        assert_eq!(back.task_manager.effort, "low");
        assert_eq!(back.task_manager.permission, "ask");
        assert!(
            !back.study_analytics.enabled,
            "research collection is opt-in"
        );
        assert!(back.study_analytics.session_id.is_empty());
        assert_eq!(back.agent_finished_retention_turns, 1);
        assert!(back.automatic_update_checks);
        assert_eq!(back.agent_restart_policy, "disabled");
        assert!(back.workspace_tabs.is_none());
        assert!(json.contains("defaultAgent"), "must be camelCase: {json}");
    }

    /// A record written before a setting existed must still load. Without the
    /// serde defaults this would fail the read, and a failed read resets
    /// everything the user chose.
    #[test]
    fn a_record_missing_newer_fields_still_loads() {
        let old = r#"{"defaultAgent":"codex","taskManager":{"model":"haiku","effort":"medium","dirs":[]}}"#;
        let loaded: GlobalSettings = serde_json::from_str(old).expect("should tolerate absence");
        assert_eq!(loaded.default_agent, "codex");
        assert_eq!(loaded.task_manager.agent, "codex");
        assert_eq!(loaded.task_manager.permission, "ask");
        assert!(!loaded.study_analytics.enabled);
        assert_eq!(loaded.agent_finished_retention_turns, 1);
        assert!(loaded.automatic_update_checks);
        assert_eq!(loaded.agent_restart_policy, "disabled");
        assert!(loaded.workspace_tabs.is_none());
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

    #[test]
    fn a_removed_task_manager_model_moves_to_selected_luna() {
        let mut settings = GlobalSettings::default();
        settings.task_manager.agent = "claude".into();
        settings.task_manager.model = "haiku".into();
        settings.task_manager.effort = "medium".into();
        settings.models.get_mut("claude").unwrap().enabled = vec!["sonnet".into()];

        normalize_task_manager(&mut settings);

        assert_eq!(settings.task_manager.agent, "codex");
        assert_eq!(settings.task_manager.model, "gpt-5.6-luna");
        assert_eq!(settings.task_manager.effort, "low");
    }
}
