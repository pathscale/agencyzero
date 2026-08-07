//! Bounded, item-owned context for fresh execution sessions.
//!
//! The coordinator transcript is deliberately not an input. A worker receives
//! durable item/project facts with explicit provenance and byte ceilings, then
//! returns a structured handback. This is the seam that lets fresh sessions be
//! compared with Claude forks without quietly copying the context we are trying
//! to avoid.

use crate::db::schema::project::ProjectRow;
use crate::db::schema::project_item::ProjectItemRow;
use crate::db::tables::Tables;
use worktable::prelude::SelectQueryExecutor;

const MAX_OBJECTIVE_BYTES: usize = 4_000;
const MAX_ACCEPTANCE_BYTES: usize = 4_000;
const MAX_NOTES_BYTES: usize = 4_000;
const MAX_CAPSULE_BYTES: usize = 16_384;
const MAX_POINTERS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkerHandoff {
    pub revision: u32,
    pub text: String,
}

impl WorkerHandoff {
    #[must_use]
    pub fn bytes(&self) -> usize {
        self.text.len()
    }
}

#[derive(Debug)]
struct WorkerHandoffInput {
    project_id: String,
    project_name: String,
    item_id: String,
    item_title: String,
    item_status: String,
    item_reference: String,
    objective: String,
    acceptance: String,
    item_context: String,
    roots: Vec<String>,
    notes: String,
    memory_pointers: Vec<String>,
    related_prs: Vec<String>,
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.trim().to_string();
    }
    let suffix = format!("\n[truncated at {max_bytes} bytes]");
    let mut end = max_bytes.saturating_sub(suffix.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", value[..end].trim_end(), suffix)
}

fn render_handoff(input: WorkerHandoffInput) -> WorkerHandoff {
    let objective = truncate_utf8(&input.objective, MAX_OBJECTIVE_BYTES);
    let acceptance = truncate_utf8(&input.acceptance, MAX_ACCEPTANCE_BYTES);
    let item_context = truncate_utf8(&input.item_context, MAX_NOTES_BYTES);
    let notes = truncate_utf8(&input.notes, MAX_NOTES_BYTES);
    let roots = input
        .roots
        .iter()
        .map(|root| format!("- {root}"))
        .collect::<Vec<_>>()
        .join("\n");
    let pointers = input
        .memory_pointers
        .iter()
        .take(MAX_POINTERS)
        .map(|pointer| format!("- {pointer}"))
        .collect::<Vec<_>>()
        .join("\n");
    let prs = input
        .related_prs
        .iter()
        .map(|url| format!("- {url}"))
        .collect::<Vec<_>>()
        .join("\n");

    let fixed_tail = "\n\n## Operating constraints\n\
- Work only on this item. Do not infer authority for adjacent work.\n\
- Treat durable state above as current; do not rely on remembered coordinator state.\n\
- Ask a concise blocking question when an owner decision is required.\n\
- Do not open or publish a pull request unless the owner explicitly changes the local-only policy.\n\
\n## Handback contract\n\
Return these sections, even when empty:\n\
1. Outcome\n\
2. Changed files or artifacts\n\
3. Verification\n\
4. Remaining risks or blockers\n\
5. Questions for the owner\n\
Keep the handback concise. The parent project receives this result; your transcript remains in this fork.";

    let body = format!(
        "# Item worker handoff v1\n\n\
         ## Identity (AgencyZero durable state)\n\
         - Project: {} ({})\n\
         - Item: {}\n\
         - Item status: {}\n\
         - Item reference: {}\n\n\
         ## Objective (owner-authored dispatch input)\n{}\n\n\
         ## Acceptance criteria (owner-authored dispatch input)\n{}\n\n\
         ## Item context (owner-authored, sent at work start)\n{}\n\n\
         ## Workspace roots (AgencyZero project configuration)\n{}\n\n\
         ## Durable operating notes (AgencyZero project memory)\n{}\n\n\
         ## Durable memory pointers\n{}\n\n\
         ## Related pull requests (AgencyZero tracked state)\n{}",
        input.project_name,
        input.project_id,
        input.item_id,
        input.item_status,
        if input.item_reference.is_empty() {
            "none"
        } else {
            &input.item_reference
        },
        if objective.is_empty() {
            &input.item_title
        } else {
            &objective
        },
        if acceptance.is_empty() {
            "Complete the named item and report verification."
        } else {
            &acceptance
        },
        if item_context.is_empty() {
            "none"
        } else {
            &item_context
        },
        if roots.is_empty() { "- none" } else { &roots },
        if notes.is_empty() { "none" } else { &notes },
        if pointers.is_empty() {
            "- none"
        } else {
            &pointers
        },
        if prs.is_empty() { "- none" } else { &prs },
    );
    let body_budget = MAX_CAPSULE_BYTES.saturating_sub(fixed_tail.len());
    let text = format!("{}{}", truncate_utf8(&body, body_budget), fixed_tail);
    debug_assert!(text.len() <= MAX_CAPSULE_BYTES);
    WorkerHandoff { revision: 1, text }
}

fn memory_pointers(memory_dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(memory_dir) else {
        return Vec::new();
    };
    let mut pointers = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            path.is_file().then(|| path.display().to_string())
        })
        .collect::<Vec<_>>();
    pointers.sort();
    pointers.truncate(MAX_POINTERS);
    pointers
}

/// Build one fresh worker's complete first-turn context.
///
/// `objective` and `acceptance` come from the explicit dispatch UI. Everything
/// else is read from current durable rows. No coordinator transcript is read.
pub(crate) fn build_item_handoff(
    tables: &Tables,
    item_id: &str,
    objective: &str,
    acceptance: &str,
) -> Result<WorkerHandoff, String> {
    let item: ProjectItemRow = tables
        .project_item
        .select(item_id.to_string())
        .ok_or_else(|| format!("item {item_id} does not exist"))?;
    let project: ProjectRow = tables
        .project
        .select(item.project_id.clone())
        .ok_or_else(|| format!("project {} does not exist", item.project_id))?;
    let roots = serde_json::from_str::<Vec<String>>(&project.dirs).unwrap_or_default();
    let notes = tables
        .kv_get(&crate::notes::notes_key(&project.id))
        .unwrap_or_default();
    let memory_dir = tables.data_dir.join("memory").join(&project.id);
    let related_prs = tables
        .pull_request
        .select_by_project_id(project.id.clone())
        .execute()
        .unwrap_or_default()
        .into_iter()
        .filter(|pr| !pr.dismissed)
        .map(|pr| pr.url)
        .collect();
    let item_context = crate::projects::item_context(tables, &item.id);

    Ok(render_handoff(WorkerHandoffInput {
        project_id: project.id,
        project_name: project.name,
        item_id: item.id,
        item_title: item.title,
        item_status: item.status,
        item_reference: item.reference,
        objective: objective.to_string(),
        acceptance: acceptance.to_string(),
        item_context,
        roots,
        notes,
        memory_pointers: memory_pointers(&memory_dir),
        related_prs,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_is_bounded_provenanced_and_keeps_its_return_contract() {
        let handoff = render_handoff(WorkerHandoffInput {
            project_id: "project-a".into(),
            project_name: "Long thread".into(),
            item_id: "item-a".into(),
            item_title: "Implement the bounded worker".into(),
            item_status: "active".into(),
            item_reference: String::new(),
            objective: "x".repeat(20_000),
            acceptance: "y".repeat(20_000),
            item_context: "The owner wants the preview editable before dispatch.".into(),
            roots: vec!["/repo".into()],
            notes: "z".repeat(20_000),
            memory_pointers: vec!["/memory/decision.md".into()],
            related_prs: vec![],
        });

        assert!(handoff.bytes() <= MAX_CAPSULE_BYTES);
        assert!(handoff.text.contains("[truncated at 4000 bytes]"));
        assert!(handoff.text.contains("AgencyZero durable state"));
        assert!(handoff.text.contains("Handback contract"));
        assert!(handoff.text.contains("preview editable before dispatch"));
        assert!(
            handoff
                .text
                .contains("The parent project receives this result")
        );
        assert!(handoff.text.contains("transcript remains in this fork"));
    }
}
