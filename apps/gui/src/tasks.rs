//! The Home task manager: one long-running conversation that keeps the project
//! and item lists in order.
//!
//! # Why it is a project
//!
//! Home needs a transcript, a session to resume, a model, a cost and a raw I/O
//! trail — every one of which a project already has. Inventing a parallel set of
//! those for one screen would mean two of everything, so Home *is* a project,
//! reserved under a fixed id and hidden from the project lists.
//!
//! # The output contract
//!
//! The reply has to become rows. Asking a model for prose and then parsing it is
//! how you get a to-do list that is subtly wrong; asking for JSONL and refusing
//! anything else is how you get one that is either right or visibly empty.
//!
//! So the user's own words go out unchanged, with [`OUTPUT_CONTRACT`] appended.
//! One JSON object per line, each naming a project and an item. Anything that
//! does not parse is skipped and counted rather than guessed at — a task list
//! that quietly invents entries is worse than one that comes back short.
//!
//! # What it cannot do yet
//!
//! It reads what you paste and what the agent can reach through its own tools in
//! the workspace directory. **It cannot read the WorkTable store**: those files
//! are rkyv, a binary layout with no text form, so an agent pointed at them sees
//! bytes. Giving it real access to its own data means a query tool — see
//! `docs/task-manager.md`.

use serde::{Deserialize, Serialize};

/// The reserved project id for Home's conversation.
///
/// Fixed rather than generated so it survives a restart without a lookup, and
/// prefixed differently from `proj-` so it can never collide with a real one.
pub const TASK_MANAGER_ID: &str = "home-task-manager";

/// Opens the machine-readable block. Only lines between the markers are
/// authoritative; see [`harvest`] for what happens without them.
pub const TASKS_BEGIN: &str = "AZ-TASKS-BEGIN";
/// Closes the machine-readable block.
pub const TASKS_END: &str = "AZ-TASKS-END";

/// The most tasks one reply may mutate. The live lists are dozens of rows;
/// a reply proposing hundreds is a malfunction, not a plan.
const MAX_TASKS: usize = 100;

/// Appended to whatever the user types.
///
/// Deliberately explicit about the failure mode: a model told only "return
/// JSONL" will still wrap it in prose or a fence often enough to matter, and
/// every one of those is a dropped line.
pub const OUTPUT_CONTRACT: &str = "\n\n\
---\n\
When you have finished, end your reply with a machine-readable block so this \
application can store what you produced.\n\n\
The block must be wrapped in exactly these two marker lines, each alone on \
its own line:\n\n\
AZ-TASKS-BEGIN\n\
{\"project\": \"<project name>\", \"item\": \"<one short task>\", \"status\": \"pending\"}\n\
AZ-TASKS-END\n\n\
Emit one JSON object per line between the markers, nothing else in the block, \
no markdown fence, no commentary between lines.\n\n\
Rules:\n\
- `status` is one of pending, active, finished, deleted.\n\
- `deleted` removes the existing task whose project and item match. This is \
the only way to remove one: omitting a task from your output never deletes \
it, so never re-emit a list hoping the absences take effect. Deletions are \
honoured only inside the markers.\n\
- Only the marked block is read as instructions. When *discussing* a task or \
quoting an example, never place it between marker lines — and never write the \
marker lines anywhere except around your real block.\n\
- Use exactly the three fields shown. A line with extra fields is rejected.\n\
- One task per line. Do not number them.\n\
- Keep `item` under 120 characters and specific enough to act on.\n\
- Group related tasks by repeating the same `project` value.\n\
- If you have no tasks to record, emit no block at all rather than an empty \
one or an explanatory line.\n\
- Put the block last, after any prose you want to write.";

/// One task the agent proposed.
///
/// `deny_unknown_fields` because these lines are promoted to database
/// mutations: JSON quoted from a README, a log or an issue almost always
/// carries extra fields, and rejecting it is the cheapest way to tell the
/// contract's shape apart from the world's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposedTask {
    pub project: String,
    pub item: String,
    #[serde(default = "default_status")]
    pub status: String,
}

fn default_status() -> String {
    "pending".to_string()
}

/// What a reply yielded, and what it cost us to read it.
#[derive(Debug, Default, PartialEq)]
pub struct Harvest {
    pub tasks: Vec<ProposedTask>,
    /// Lines that looked like JSON and were not usable. Reported rather than
    /// hidden: a contract the model keeps drifting from is worth knowing about.
    pub rejected: usize,
}

/// Pull the task block out of a reply.
///
/// The marked block is the authority: when `AZ-TASKS-BEGIN` appears, only
/// lines between it and `AZ-TASKS-END` are read, so a task the model merely
/// *quotes* in its prose — from a README, an example, a discussion of the
/// format — cannot mutate anything. A `BEGIN` whose `END` never arrives runs
/// to the end of the reply, because a forgotten closer should not discard a
/// real block.
///
/// Without any marker the whole reply is scanned as before — models move or
/// forget delimiters often enough that refusing the reply outright would lose
/// whole harvests — but that lenient path is additive only: a `deleted` line
/// outside the markers is refused and counted, never applied. A stray quoted
/// line can at worst add a row someone deletes; it can no longer destroy one.
///
/// A line that starts like JSON and does not parse counts as rejected. Prose
/// is ignored entirely — it is not an error for a reply to contain sentences.
#[must_use]
pub fn harvest(reply: &str) -> Harvest {
    let mut out = Harvest::default();

    let marked: Vec<&str> = {
        let mut lines = Vec::new();
        let mut inside = false;
        for line in reply.lines() {
            let bare = line.trim().trim_matches('`');
            if bare == TASKS_BEGIN {
                inside = true;
            } else if bare == TASKS_END {
                inside = false;
            } else if inside {
                lines.push(line);
            }
        }
        lines
    };

    if marked.is_empty() {
        scan(reply.lines(), false, &mut out);
    } else {
        scan(marked.into_iter(), true, &mut out);
    }
    out
}

/// One pass over candidate lines. `allow_delete` is what separates the marked
/// block from the lenient whole-reply fallback.
fn scan<'a>(lines: impl Iterator<Item = &'a str>, allow_delete: bool, out: &mut Harvest) {
    for line in lines {
        let line = line.trim().trim_start_matches("```json").trim_matches('`');
        if !line.starts_with('{') {
            continue;
        }

        match serde_json::from_str::<ProposedTask>(line) {
            Ok(task) if !task.project.trim().is_empty() && !task.item.trim().is_empty() => {
                let status = normalize_status(&task.status);
                // Destructive words need the marked block; see `harvest`.
                // A reply proposing more than MAX_TASKS is a malfunction and
                // the excess is refused rather than trusted.
                if (status == "deleted" && !allow_delete) || out.tasks.len() >= MAX_TASKS {
                    out.rejected += 1;
                    continue;
                }
                out.tasks.push(ProposedTask {
                    project: crate::projects::clip(task.project.trim(), 80),
                    item: crate::projects::clip(task.item.trim(), 120),
                    status,
                });
            }
            // Parsed but useless, or did not parse at all. Both are the model
            // not keeping the contract, and both are worth counting.
            _ => out.rejected += 1,
        }
    }
}

/// Anything unrecognized becomes `pending` rather than being dropped.
///
/// A task whose status we cannot read is still a task; refusing it would lose
/// work over a spelling. `deleted` is the one destructive word and is matched
/// strictly for that reason: "remove"-adjacent spellings fall through to
/// `pending`, because guessing at a deletion is worse than adding a stray row.
fn normalize_status(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "active" | "in_progress" | "in-progress" | "doing" => "active",
        "finished" | "done" | "complete" | "completed" => "finished",
        "deleted" => "deleted",
        _ => "pending",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `deleted` is the one destructive word, so it passes through exactly and
    /// nothing else is allowed to drift into it: a "remove" that became a
    /// deletion by fuzzy matching would delete work over a spelling.
    #[test]
    fn deleted_passes_and_nothing_drifts_into_it() {
        let explicit = harvest(
            "AZ-TASKS-BEGIN\n{\"project\": \"p\", \"item\": \"t\", \"status\": \"deleted\"}\nAZ-TASKS-END",
        );
        assert_eq!(explicit.tasks[0].status, "deleted");

        let fuzzy = harvest(
            "AZ-TASKS-BEGIN\n{\"project\": \"p\", \"item\": \"t\", \"status\": \"remove\"}\nAZ-TASKS-END",
        );
        assert_eq!(fuzzy.tasks[0].status, "pending");
    }

    /// The confused-deputy fix: a deletion the model merely *mentions* in
    /// prose — quoting the format, an example, someone else's text — must not
    /// remove anything. Destructive words need the marked block.
    #[test]
    fn a_deleted_line_outside_the_markers_is_refused() {
        let got = harvest(r#"{"project": "p", "item": "t", "status": "deleted"}"#);
        assert!(got.tasks.is_empty());
        assert_eq!(got.rejected, 1, "refused visibly, not dropped silently");
    }

    /// When a marked block exists, it is the whole authority: a plausible
    /// line quoted in the prose around it is ignored, not harvested.
    #[test]
    fn json_outside_a_marked_block_is_ignored() {
        let reply = "For example {\"project\": \"Quoted\", \"item\": \"never store this\"} is the shape.\n\
             AZ-TASKS-BEGIN\n\
             {\"project\": \"Real\", \"item\": \"store this\"}\n\
             AZ-TASKS-END\n\
             And {\"project\": \"Also quoted\", \"item\": \"nor this\"} afterwards.";

        let got = harvest(reply);

        assert_eq!(got.tasks.len(), 1);
        assert_eq!(got.tasks[0].project, "Real");
        assert_eq!(got.rejected, 0, "quoted prose is not contract drift");
    }

    /// A forgotten closing marker must not discard the real block.
    #[test]
    fn a_block_missing_its_end_marker_runs_to_the_end() {
        let reply = "AZ-TASKS-BEGIN\n{\"project\": \"P\", \"item\": \"t\"}";
        assert_eq!(harvest(reply).tasks.len(), 1);
    }

    /// Extra fields are the signature of JSON quoted from somewhere else —
    /// an issue, a log, a fixture. The contract's shape is exact.
    #[test]
    fn a_line_with_extra_fields_is_rejected() {
        let got = harvest(
            "AZ-TASKS-BEGIN\n\
             {\"project\": \"P\", \"item\": \"t\", \"status\": \"pending\", \"id\": 7}\n\
             AZ-TASKS-END",
        );
        assert!(got.tasks.is_empty());
        assert_eq!(got.rejected, 1);
    }

    /// A reply proposing hundreds of mutations is a malfunction; the excess
    /// is refused and counted rather than trusted.
    #[test]
    fn a_reply_cannot_mutate_more_than_the_cap() {
        let mut reply = String::from("AZ-TASKS-BEGIN\n");
        for index in 0..120 {
            reply.push_str(&format!(
                "{{\"project\": \"P\", \"item\": \"task {index}\"}}\n"
            ));
        }
        reply.push_str("AZ-TASKS-END");

        let got = harvest(&reply);

        assert_eq!(got.tasks.len(), 100);
        assert_eq!(got.rejected, 20);
    }

    #[test]
    fn the_contract_names_the_delete_rule() {
        assert!(OUTPUT_CONTRACT.contains("deleted"));
        assert!(OUTPUT_CONTRACT.contains("never deletes"));
    }

    #[test]
    fn a_jsonl_block_after_prose_is_found() {
        let reply = "Here is what I found in the repo.\n\n\
             {\"project\": \"WorkTable\", \"item\": \"Bench before the rewrite\", \"status\": \"pending\"}\n\
             {\"project\": \"WorkTable\", \"item\": \"Ship 0.9.3\", \"status\": \"active\"}\n";

        let got = harvest(reply);

        assert_eq!(got.tasks.len(), 2);
        assert_eq!(got.rejected, 0);
        assert_eq!(got.tasks[0].project, "WorkTable");
        assert_eq!(got.tasks[1].status, "active");
    }

    /// Models fence the block whatever the instructions say. Losing every task
    /// to three backticks would be the most common possible failure.
    #[test]
    fn a_fenced_block_still_parses() {
        let reply =
            "```json\n{\"project\": \"P\", \"item\": \"Do a thing\", \"status\": \"pending\"}\n```";
        assert_eq!(harvest(reply).tasks.len(), 1);
    }

    /// Prose is not an error. Only something shaped like JSON that fails counts.
    #[test]
    fn prose_is_ignored_but_broken_json_is_counted() {
        let reply = "I could not find anything to do.\nNothing here is a task.\n\
             {\"project\": \"P\", \"item\":}\n";

        let got = harvest(reply);

        assert!(got.tasks.is_empty());
        assert_eq!(
            got.rejected, 1,
            "the malformed line is reported, not hidden"
        );
    }

    /// An empty field is not a task. Writing it would put a blank row in the
    /// panel that nobody can act on or explain.
    #[test]
    fn an_empty_field_is_rejected_rather_than_stored() {
        let reply = "{\"project\": \"\", \"item\": \"x\"}\n{\"project\": \"P\", \"item\": \"  \"}";

        let got = harvest(reply);

        assert!(got.tasks.is_empty());
        assert_eq!(got.rejected, 2);
    }

    #[test]
    fn a_missing_status_defaults_to_pending() {
        let got = harvest("{\"project\": \"P\", \"item\": \"Do a thing\"}");
        assert_eq!(got.tasks[0].status, "pending");
    }

    /// A status we do not recognize must not lose the task.
    #[test]
    fn an_unknown_status_becomes_pending_rather_than_dropping_the_task() {
        let got = harvest("{\"project\": \"P\", \"item\": \"x\", \"status\": \"whenever\"}");
        assert_eq!(got.tasks.len(), 1);
        assert_eq!(got.tasks[0].status, "pending");
    }

    #[test]
    fn statuses_are_normalized_from_the_words_models_actually_use() {
        let got = harvest(
            "{\"project\": \"P\", \"item\": \"a\", \"status\": \"in_progress\"}\n\
             {\"project\": \"P\", \"item\": \"b\", \"status\": \"DONE\"}",
        );
        assert_eq!(got.tasks[0].status, "active");
        assert_eq!(got.tasks[1].status, "finished");
    }

    /// The contract has to say the things models get wrong, or it is decoration.
    #[test]
    fn the_contract_forbids_the_usual_failures() {
        assert!(OUTPUT_CONTRACT.contains("no markdown fence"));
        assert!(OUTPUT_CONTRACT.contains("one JSON object per line"));
        assert!(OUTPUT_CONTRACT.contains("emit no block at all"));
        assert!(OUTPUT_CONTRACT.contains(TASKS_BEGIN));
        assert!(OUTPUT_CONTRACT.contains(TASKS_END));
    }
}
