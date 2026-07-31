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

/// Whether this project takes knowledge checkpoints as its context fills.
pub fn checkpoints_key(project_id: &str) -> String {
    format!("checkpoints:{project_id}")
}

/// The largest threshold this project has already sampled, in context tokens.
///
/// Persisted rather than held in memory so a restart mid-session does not
/// re-sample everything already captured. Reset to zero by a compaction, which
/// is what makes the next fill re-arm all three.
pub fn checkpoint_mark_key(project_id: &str) -> String {
    format!("checkpoint-mark:{project_id}")
}

/// Where the samples are taken, in context tokens.
///
/// Thirds of a million-token window, which is the shape of the question being
/// asked: does the pre-compaction extraction get worse as the conversation it is
/// summarising gets bigger? Three points is the fewest that can show a *trend*
/// rather than a difference — two could only say "not the same".
///
/// Nothing here decides when to compact. These are measurements, and the point
/// of taking them is to find out where compacting should happen rather than to
/// assume it.
pub const CHECKPOINTS: [u64; 3] = [300_000, 600_000, 900_000];

/// The next sample due for a conversation of this size, if any.
///
/// `mark` is the largest threshold already taken. Returns the *highest* crossed
/// threshold rather than the lowest, so a run that jumps from 250k to 640k in
/// one turn — which a long tool-using turn easily does — records one sample at
/// 600k instead of firing 300k and 600k back to back against a context that is
/// already past both.
#[must_use]
pub fn due(context_tokens: u64, mark: u64) -> Option<u64> {
    CHECKPOINTS
        .iter()
        .rev()
        .copied()
        .find(|&threshold| context_tokens >= threshold && threshold > mark)
}

/// A sample's filename: sortable, and self-describing without opening it.
#[must_use]
pub fn sample_name(threshold: u64, stamp: &str) -> String {
    // Colons are legal on the platforms this ships to but make a path awkward to
    // pass to anything else, and the stamp is only ever read by eye.
    format!("{}k-{}.md", threshold / 1_000, stamp.replace(':', "-"))
}

/// The header that makes a sample comparable to the others.
///
/// The whole exercise is a comparison, and a bare list of rules cannot be
/// compared to anything — the reader has to know how full the window was, how
/// long the conversation had run, and how much came back. Written as front
/// matter so the file is still readable prose.
#[must_use]
pub fn sample_document(
    threshold: u64,
    context_tokens: u64,
    context_window: Option<u64>,
    stamp: &str,
    session: &str,
    body: &str,
) -> String {
    let window = context_window.map_or_else(|| "unknown".to_string(), |value| value.to_string());
    let share = context_window.filter(|window| *window > 0).map_or_else(
        || "unknown".to_string(),
        |window| format!("{}%", (context_tokens * 100) / window),
    );
    format!(
        "---\nthreshold: {threshold}\ncontext_tokens: {context_tokens}\n\
         context_window: {window}\ncontext_used: {share}\ntaken_at: {stamp}\n\
         session: {session}\nchars: {}\nlines: {}\n---\n\n{body}\n",
        body.len(),
        body.lines().filter(|line| !line.trim().is_empty()).count(),
    )
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

    /*
     * The measurement this feature exists to make: does the extraction get
     * worse as the conversation it summarises gets bigger? So the sampling has
     * to be even-handed — one sample per threshold, never two for the same
     * pressure, and never a sample skipped because a turn was large.
     */
    #[test]
    fn nothing_is_due_below_the_first_threshold() {
        assert_eq!(due(299_999, 0), None);
        assert_eq!(due(0, 0), None);
    }

    #[test]
    fn each_threshold_is_sampled_once() {
        assert_eq!(due(300_000, 0), Some(300_000));
        // Already taken, so a turn that lands at the same size takes nothing.
        assert_eq!(due(310_000, 300_000), None);
        assert_eq!(due(600_001, 300_000), Some(600_000));
        assert_eq!(due(950_000, 600_000), Some(900_000));
        assert_eq!(due(999_999, 900_000), None);
    }

    /// A long tool-using turn can add hundreds of thousands of tokens at once.
    /// Firing every crossed threshold in turn would sample 300k against a
    /// conversation already at 640k, which is not a 300k sample at all.
    #[test]
    fn a_turn_that_jumps_two_thresholds_samples_the_one_it_landed_on() {
        assert_eq!(due(640_000, 0), Some(600_000));
        assert_eq!(due(910_000, 0), Some(900_000));
    }

    /// A compaction resets the mark, so the next fill re-arms all three — and
    /// that is the point: the interesting comparison is across fills.
    #[test]
    fn a_reset_mark_re_arms_the_thresholds() {
        assert_eq!(due(320_000, 0), Some(300_000));
    }

    #[test]
    fn a_sample_is_named_so_it_sorts_and_explains_itself() {
        assert_eq!(
            sample_name(600_000, "2026-08-01T00:30:00+00:00"),
            "600k-2026-08-01T00-30-00+00-00.md"
        );
    }

    /// A rule list with no idea how full the window was cannot be compared to
    /// anything, which would defeat the whole exercise.
    #[test]
    fn a_sample_records_the_pressure_it_was_taken_under() {
        let doc = sample_document(
            300_000,
            312_450,
            Some(1_000_000),
            "2026-08-01T00:30:00+00:00",
            "abc-123",
            "- Bump the version on every commit.",
        );

        assert!(doc.contains("threshold: 300000"));
        assert!(doc.contains("context_tokens: 312450"));
        assert!(doc.contains("context_used: 31%"));
        assert!(doc.contains("session: abc-123"));
        assert!(doc.contains("lines: 1"));
        assert!(doc.ends_with("- Bump the version on every commit.\n"));
    }

    /// An agent that reports no window still gives a comparable sample: the
    /// token count is the axis that matters and it is always there.
    #[test]
    fn a_missing_window_is_said_rather_than_guessed() {
        let doc = sample_document(300_000, 312_450, None, "t", "s", "body");
        assert!(doc.contains("context_window: unknown"));
        assert!(doc.contains("context_used: unknown"));
    }

    /// The window carries its own copy as `NOTES_BUDGET` in `api/client.ts`, so
    /// the editor can show the room left *before* saving rather than truncating
    /// silently afterwards. This one binds — the backend clamps whatever it is
    /// handed — and both are pinned so they cannot drift apart unnoticed.
    #[test]
    fn the_budget_matches_the_window() {
        assert_eq!(BUDGET, 4_000);
    }

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
