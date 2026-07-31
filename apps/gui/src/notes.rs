//! What the agent must not forget when the conversation is thrown away.
//!
//! # The problem
//!
//! `/compact` rewrites a conversation into a summary of itself, and the
//! summariser optimises for *what was discussed*. What it discards is the layer
//! on top: the corrections, the house rules, the approaches already ruled out.
//! That layer is what took the whole session to establish, and losing it is why
//! an agent reads as newly stupid after a compaction that, by its own measure,
//! worked perfectly.
//!
//! # Why notes live outside the conversation
//!
//! Anything inside the conversation is compactable. Anything in the system
//! prompt is not. So durable knowledge cannot be re-taught by *saying* it to the
//! agent — that turn is conversation too, and the next compaction eats it, and
//! you pay for the lesson again every time.
//!
//! These notes are held by the app, per project, and delivered through
//! [`agent_abstraction::Request::system`], which the crate promises is "never
//! dropped". They survive compaction, session death and app restart, and they
//! cost a cache read per turn rather than a turn.
//!
//! # Whose logic this is
//!
//! AgencyZero's, entirely. The crate's job ends at "run `/compact` against this
//! session and report what happened"; it has no opinion about what a compaction
//! costs its caller. Catching the command here and doing the right thing around
//! it — learn first, then compact, then keep teaching — is the app's own
//! behaviour, and nothing in this file asks the crate for anything it does not
//! already do for any other request.
//!
//! # Why they merge rather than replace
//!
//! Extraction runs against the conversation about to be summarised, so it can
//! only see what is still there. After the first compaction the agent no longer
//! remembers what it knew before it, and an extraction that replaced the notes
//! would quietly drop everything learned earlier — the knowledge would decay one
//! compaction at a time, which is the failure this module exists to prevent.
//! [`merge_prompt`] hands the agent what it already wrote and asks for one
//! deduplicated set back.
//!
//! # Why they are budgeted
//!
//! Notes ride every request. Left to grow they become the context problem they
//! were written to solve, so [`BUDGET`] is a hard ceiling, stated to the agent
//! and enforced here regardless of whether it obeyed.

/// How much room the notes get, in characters.
///
/// Roughly a thousand tokens: enough for the twenty-odd rules a long session
/// actually accumulates, small enough that carrying it on every turn is a
/// rounding error against a conversation. Enforced in [`clamp`] rather than
/// trusted to the prompt, because "keep it under N" is a request and this is a
/// guarantee.
pub const BUDGET: usize = 4_000;

/// Where a project's notes are kept. Keyed like [`crate::projects::session_key`]
/// — a kv row rather than a column, so it can be absent without a migration.
pub fn notes_key(project_id: &str) -> String {
    format!("notes:{project_id}")
}

/// Trim notes to [`BUDGET`], on a line boundary.
///
/// Cut at a line rather than mid-sentence: half a rule is worse than no rule,
/// because the agent cannot tell it is reading a fragment and will act on it.
/// The oldest lines go first — the agent writes the set in the order it thinks
/// matters, and a later extraction has had more chances to confirm what is
/// really load-bearing.
#[must_use]
pub fn clamp(notes: &str) -> String {
    let trimmed = notes.trim();
    if trimmed.len() <= BUDGET {
        return trimmed.to_string();
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut used = 0;
    for line in trimmed.lines().rev() {
        // +1 for the newline this line will be joined with.
        if used + line.len() + 1 > BUDGET {
            break;
        }
        used += line.len() + 1;
        kept.push(line);
    }
    kept.reverse();
    kept.join("\n")
}

/// The turn that runs before a compaction, asking the agent what to carry over.
///
/// # Why it is this specific
///
/// "Write down what matters" produces confident generalities — an agent asked to
/// summarise its own knowledge will describe the codebase, which is the one
/// thing already on disk and re-readable at any time. So the ask is restricted
/// to categories that require *evidence from this conversation*: something the
/// user said, something that was decided, something that was tried and failed.
///
/// The exclusion is doing as much work as the inclusions. Anything derivable
/// from the code, the tests or the git log is banned outright, because that is
/// exactly the filler that crowds out the twenty lines that are not.
///
/// # Why the imperative
///
/// The result becomes a system prompt, so it has to read as instructions to
/// follow rather than as minutes of a meeting. "The user prefers X" is a fact
/// about a conversation; "Do X" is a rule, and only one of them changes what the
/// next turn does.
#[must_use]
pub fn merge_prompt(existing: &str) -> String {
    let carried = if existing.trim().is_empty() {
        "You have no notes yet; this is the first pass.".to_string()
    } else {
        format!(
            "These are the notes you wrote before an earlier compaction. You can \
             no longer remember the conversations they came from, so treat them \
             as true and carry them forward unless something in the current \
             conversation contradicts them:\n\n{existing}"
        )
    };

    format!(
        "This conversation is about to be compacted into a summary, and the \
         summary will lose everything except roughly what we discussed. Before \
         that happens, write the operating knowledge that must survive.\n\n\
         {carried}\n\n\
         Produce one merged list, deduplicated, newest understanding winning \
         where it conflicts. Write it as instructions to yourself in the \
         imperative — \"Bump the version on every commit\", not \"the user likes \
         version bumps\" — because this becomes your standing instructions, not \
         a record of a chat.\n\n\
         Include only these, and only where this conversation is the evidence:\n\
         - Corrections you were given, each with the reason behind it.\n\
         - Decisions taken, and the alternatives that were rejected and why.\n\
         - Constraints and conventions that are not visible in the code.\n\
         - Approaches already tried and ruled out, so they are not retried.\n\
         - What is in flight right now and what the next step is.\n\n\
         Exclude anything re-derivable from the repository — how the code is \
         structured, what a function does, what the tests cover, what is in the \
         git log. You can read those again in seconds; that is not what gets \
         lost.\n\n\
         Hard limit: {BUDGET} characters. If you must cut, keep the corrections \
         — they are the ones that cost a person their time to give you.\n\n\
         Reply with the list and nothing else: no preamble, no sign-off, no \
         offer to help further. Your entire reply is stored verbatim and fed \
         back to you as instructions."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_within_budget_are_left_alone() {
        assert_eq!(
            clamp("  do the thing\ndo the other  "),
            "do the thing\ndo the other"
        );
    }

    /// Half a rule is worse than no rule: the agent cannot tell it is reading a
    /// fragment, so it acts on it.
    #[test]
    fn an_oversized_set_is_cut_on_line_boundaries() {
        let line = "x".repeat(100);
        let many = std::iter::repeat_n(line.as_str(), 100)
            .collect::<Vec<_>>()
            .join("\n");
        let clamped = clamp(&many);

        assert!(clamped.len() <= BUDGET);
        assert!(
            clamped.lines().all(|kept| kept.len() == 100),
            "no line survived as a fragment"
        );
    }

    /// The newest understanding is the one that has been confirmed most often,
    /// so the oldest lines are what a full set gives up.
    #[test]
    fn the_tail_is_what_survives_a_cut() {
        let filler = "y".repeat(BUDGET);
        let clamped = clamp(&format!("the oldest rule\n{filler}\nthe newest rule"));

        assert!(clamped.ends_with("the newest rule"));
        assert!(!clamped.contains("the oldest rule"));
    }

    /// A first pass must not invite the agent to invent a history it never had.
    #[test]
    fn the_first_pass_says_there_is_nothing_to_carry() {
        let prompt = merge_prompt("   ");
        assert!(prompt.contains("no notes yet"));
    }

    /// The whole point of merging: knowledge from before the last compaction is
    /// unrecoverable from the conversation, so it has to be handed back.
    #[test]
    fn an_established_set_is_handed_back_to_be_carried_forward() {
        let prompt = merge_prompt("Bump the version on every commit.");
        assert!(prompt.contains("Bump the version on every commit."));
        assert!(!prompt.contains("no notes yet"));
        assert!(prompt.contains("carry them forward"));
    }

    #[test]
    fn the_budget_is_stated_to_the_agent_as_well_as_enforced() {
        assert!(merge_prompt("").contains(&BUDGET.to_string()));
    }
}
