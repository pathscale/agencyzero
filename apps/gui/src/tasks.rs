//! Home's Task Manager: one long-running conversation that maintains the same
//! project items an ordinary project tab does.
//!
//! # One reverse-channel language
//!
//! Home used to switch the agent into a private `AZ-TASKS-BEGIN` JSONL format.
//! Project tabs used Prompt Syntax directives, and PRs were found by scanning
//! prose for URLs. That made an agent learn three unrelated mutation channels
//! and made ordinary output executable in two of them.
//!
//! Home now uses the declared Prompt Syntax surface too. The live snapshot
//! gives every existing row's id, so updates and removals use `items.state`
//! and `items.retire`; new rows use `items.add(project: ...)`. The Task Manager
//! keeps its one extra capability: when that explicit `project:` argument does
//! not resolve, the host creates a bare project before adding the item.

/// The reserved project id for Home's conversation.
///
/// Fixed rather than generated so it survives a restart without a lookup, and
/// prefixed differently from `proj-` so it can never collide with a real one.
pub const TASK_MANAGER_ID: &str = "home-task-manager";

/// Appended to the user's Task Manager prompt.
///
/// The general surface declaration is already in the system prompt. This
/// narrows it to Home's job and states the one context-specific capability:
/// an authored `items.add(project: ...)` may create the named project.
pub const OUTPUT_CONTRACT: &str = "\n\n\
---\n\
Task Manager rules for the declared Prompt Syntax surface:\n\
- Existing rows are addressed by the item id in the live snapshot, never by title.\n\
- `items.add` must name `project`. Here only, if that exact project id or name \
does not exist, the application creates a bare project before adding the row.\n\
- Omission changes nothing. Retire only an item the user explicitly asked to remove.\n\
- In Home, `items.retire` only marks an item Delete for owner review. The application does not \
remove it until the owner confirms the proposed deletions.\n\
- An explicit request to cancel or stop work means retire the item. A pause, hold, or \
\"not now\" keeps it.\n\
- Keep titles under 120 characters. Use one directive per mutation.\n\
- If there is no mutation to record, emit no directive.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_teaches_the_same_ps_surface_as_project_tabs() {
        assert!(OUTPUT_CONTRACT.contains("`items.add` must name `project`"));
        assert!(!OUTPUT_CONTRACT.contains("AZ-TASKS"));
        assert!(!OUTPUT_CONTRACT.contains("JSONL"));
        assert!(!OUTPUT_CONTRACT.contains("<ps "));
    }

    #[test]
    fn home_keeps_omission_inert_while_terminal_states_stay_available() {
        assert!(OUTPUT_CONTRACT.contains("Omission changes nothing"));
        assert!(OUTPUT_CONTRACT.contains("marks an item Delete for owner review"));
        assert!(OUTPUT_CONTRACT.contains("owner confirms"));
        assert!(OUTPUT_CONTRACT.contains("cancel or stop work means retire"));
        assert!(OUTPUT_CONTRACT.contains("pause, hold"));
    }
}
