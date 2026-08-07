//! The per-turn operating instructions injected into every project's system
//! prompt.
//!
//! Distinct from `AgencyZero.md`, which is a repository's own rules read from
//! the run's `cwd` and therefore present only for a project whose checkout
//! ships one. These instructions are the app's, not a repository's: how to use
//! the Prompt Syntax surface, and the obligations that come with it. They must
//! reach every project — including one whose cwd has no rules file — so they are
//! carried here rather than left to a file that may not exist.
//!
//! Reliability is the whole point, so the text is never allowed to be empty. A
//! user file `AgencyZeroPerTurn.md` in the config directory overrides the
//! built-in when it is present and non-blank; absent or blank, the embedded
//! default compiled in below is used. There is no third case where the agent is
//! told nothing about the surface it is expected to author.

/// The file a user drops beside their settings to replace the built-in text.
pub const OVERRIDE_FILE: &str = "AgencyZeroPerTurn.md";

/// The instructions compiled into the binary, used when no override is present.
/// Editing these needs a rebuild; the point of the override file is to edit them
/// without one.
pub const EMBEDDED: &str = include_str!("per_turn_default.md");

/// The per-turn instructions to inject: the user's override when present and
/// non-blank, otherwise the embedded default.
///
/// `config_dir` is the directory the app writes settings into, so the override
/// travels with a data-directory move the same way settings do. A file that
/// exists but is blank falls through to the default rather than injecting
/// nothing: an empty file is far more likely a mistake than a deliberate
/// "inject no instructions", and the toggle already exists for the deliberate
/// case.
#[must_use]
pub fn instructions(config_dir: &std::path::Path, agent_finished_retention_turns: u8) -> String {
    std::fs::read_to_string(config_dir.join(OVERRIDE_FILE))
        .ok()
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| EMBEDDED.to_string())
        .replace(
            "{{agent_finished_retention_turns}}",
            &agent_finished_retention_turns.to_string(),
        )
}

/// Whether an instruction block already teaches every live authoring verb.
///
/// The dynamic state snapshot can omit its fallback declaration and examples
/// only when the stable system prefix carries the whole surface. Checking the
/// effective text keeps a custom override that does not teach Prompt Syntax
/// safe: it still gets the fallback beside the live ids.
#[must_use]
pub fn covers_surface(instructions: &str) -> bool {
    crate::directives::SURFACE.verbs.iter().all(|verb| {
        instructions.contains(&format!("@{}:{verb}", crate::directives::SURFACE.namespace))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_default_is_not_empty_and_names_the_surface() {
        assert!(!EMBEDDED.trim().is_empty());
        // The obligations are the reason this exists; a default that lost them
        // would inject a grammar with no reason to use it.
        assert!(EMBEDDED.contains("pr.link"));
        assert!(EMBEDDED.contains("Report every pull request"));
        assert!(EMBEDDED.contains("Finish delivered work"));
        assert!(EMBEDDED.contains("@agency:ask"));
        assert!(covers_surface(EMBEDDED));
    }

    #[test]
    fn an_unrelated_override_does_not_suppress_the_snapshot_fallback() {
        assert!(!covers_surface("Keep answers concise."));
    }

    #[test]
    fn a_present_override_wins_over_the_default() {
        let dir = std::env::temp_dir().join(format!("az-per-turn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join(OVERRIDE_FILE), "my own rules").expect("write override");

        assert_eq!(instructions(&dir, 2), "my own rules");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_blank_override_falls_back_to_the_default() {
        let dir = std::env::temp_dir().join(format!("az-per-turn-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");

        // Missing entirely.
        assert_eq!(
            instructions(&dir, 2),
            EMBEDDED.replace("{{agent_finished_retention_turns}}", "2")
        );

        // Present but blank: a mistake, not a deliberate silencing.
        std::fs::write(dir.join(OVERRIDE_FILE), "   \n\t\n").expect("write blank");
        assert_eq!(
            instructions(&dir, 2),
            EMBEDDED.replace("{{agent_finished_retention_turns}}", "2")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
