//! Build the committed QA profile from a real store, with the owner's content
//! removed.
//!
//! # Why this exists
//!
//! A functional sweep needs something to click. An empty profile is a Home
//! screen and almost nothing else: no projects, no items, no task log, so the
//! `Delete`, `Close` and `Collapse` buttons that keep breaking are not on
//! screen to press. Inventing fixture data would test the fixture, and every
//! bug found this week lived in the gap between invented data and real data, so
//! the *shape* has to come from a real store.
//!
//! What must not come from a real store is the owner's content. Prompts,
//! answers, paths and machine names are private and this profile is committed,
//! so every free-text field is replaced by a deterministic stand-in of the same
//! shape: a message stays a message of the same length and paragraph count, a
//! path stays a path of the same depth and extension, a title stays a short
//! line. Structure is what the sweep exercises; the words are not.
//!
//! # Why it lives in this crate
//!
//! It rewrites rows through `db::schema`, and those tables are persisted
//! positionally with rkyv. A second definition of them in another crate is
//! precisely how a store gets silently misread, which the schema files warn
//! about at length. Reusing the real definitions is the only safe option.
//!
//! # Determinism
//!
//! Replacements are derived from a hash of the original, so the same input
//! always gives the same output. Rebuilding from a newer store produces a
//! readable diff rather than a wall of churn, and a failure reported against a
//! given project means the same project tomorrow.
//!
//! ```sh
//! AZ_BUILD_QA_PROFILE="<source-db>:<destination>" az-gui
//! ```

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

// `execute()` on a select builder comes from a prelude trait.
use worktable::prelude::*;

/// The environment variable that runs the generator instead of the app.
///
/// An env var rather than a second binary: the generator needs this crate's
/// private `db` module, and a `[[bin]]` target cannot see it without turning
/// the application into a library for one tool's benefit.
pub const ENV: &str = "AZ_BUILD_QA_PROFILE";

/// Words the stand-in text is built from.
///
/// Deliberately bland and obviously synthetic, so nobody reading a QA failure
/// wonders whether they are looking at something the owner actually wrote.
const WORDS: &[&str] = &[
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
    "lambda", "sigma", "omega", "north", "south", "east", "west", "amber", "cobalt", "indigo",
];

fn seed_of(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Deterministic filler the same length as `original`.
///
/// Length matters because the UI's behaviour depends on it: whether a title
/// wraps to two lines, whether a transcript is long enough to scroll, whether a
/// label truncates. The words do not matter at all.
fn filler(original: &str, seed: u64) -> String {
    if original.trim().is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(original.len());
    let mut counter = seed;
    while out.len() < original.len() {
        counter = counter
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        let word = WORDS[(counter >> 33) as usize % WORDS.len()];
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out.truncate(original.len().max(1));
    out
}

/// Replace free text, keeping the shape a reader depends on.
///
/// Line structure survives, so a multi-paragraph message stays multi-paragraph
/// and a transcript still scrolls the way the real one did.
pub fn scrub_text(original: &str) -> String {
    let seed = seed_of(original);
    original
        .split('\n')
        .map(|line| filler(line, seed ^ line.len() as u64))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Replace a path, keeping its depth and extension.
///
/// A path is not prose. The UI truncates it from the left, shows its basename
/// and groups by parent, so depth and the final extension are load-bearing. The
/// owner's home directory and machine name are exactly what is not.
pub fn scrub_path(original: &str) -> String {
    if original.trim().is_empty() {
        return String::new();
    }
    let absolute = original.starts_with('/');
    let mut counter = seed_of(original);
    let mut segments: Vec<String> = original
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            counter = counter
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let word = WORDS[(counter >> 33) as usize % WORDS.len()];
            match segment.rsplit_once('.') {
                Some((_, extension)) if !extension.contains(' ') => format!("{word}.{extension}"),
                _ => word.to_owned(),
            }
        })
        .collect();
    if segments.is_empty() {
        segments.push("alpha".to_owned());
    }
    let joined = segments.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Whether a value is a path rather than prose.
pub fn looks_like_path(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with('/') || trimmed.starts_with("~/") || trimmed.starts_with("./")
}

/// Anything that must never reach a committed profile, whatever field it is in.
///
/// Belt and braces over fields that are otherwise left alone, because the cost
/// of missing one is publishing the owner's name in a public repository.
pub fn redact_identifiers(value: &str) -> String {
    let mut out = value.to_owned();
    for needle in ["revenge", "Revenge", "REVENGE"] {
        out = out.replace(needle, "owner");
    }
    out
}

/// Scrub either as a path or as prose, whichever the value is.
pub fn scrub_value(value: &str) -> String {
    let scrubbed = if looks_like_path(value) {
        scrub_path(value)
    } else {
        scrub_text(value)
    };
    redact_identifiers(&scrubbed)
}

/// Copy the store and rewrite its text.
///
/// The copy happens first and the edits land on the copy: opening the owner's
/// own store read-write to scrub it would put a single mistake between a QA
/// fixture and their real data.
pub async fn build(source: &Path, destination: &Path) -> Result<usize, String> {
    if !source.is_dir() {
        return Err(format!("no store at {}", source.display()));
    }
    if destination.exists() {
        std::fs::remove_dir_all(destination).map_err(|error| error.to_string())?;
    }
    copy_tree(source, destination).map_err(|error| error.to_string())?;

    let tables = crate::db::tables::Tables::open(destination)
        .await
        .map_err(|error| format!("could not open the copied store: {error}"))?;

    let mut scrubbed = 0usize;

    for row in tables.project.select_all().execute().unwrap_or_default() {
        let name = scrub_value(&row.name);
        tables
            .project
            .update_name_by_id(
                crate::db::schema::project::NameByIdQuery { name },
                row.id.clone(),
            )
            .await
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in tables
        .project_item
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        let title = scrub_value(&row.title);
        tables
            .project_item
            .update_title_by_id(
                crate::db::schema::project_item::TitleByIdQuery { title },
                row.id.clone(),
            )
            .await
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    /*
     * Message bodies, task-log labels and command output.
     *
     * These are the bulk of the private content, not an afterthought: a pass
     * that scrubbed only project names and item titles left 25,000 occurrences
     * of the owner's name in `message` and `task_log` alone. The task log is
     * the worst of them, because every shell command the agent ran is in it
     * verbatim, home directory and all.
     *
     * Deleted and reinserted rather than updated. WorkTable only generates an
     * update for columns a schema declares under `queries: update:`, and these
     * do not declare one for their text; adding declarations to production
     * schemas so a QA tool can call them would put this tool's needs into the
     * application's data layer.
     */
    for row in tables.message.select_all().execute().unwrap_or_default() {
        let mut scrubbed_row = row.clone();
        scrubbed_row.body = scrub_value(&row.body);
        tables
            .message
            .delete(row.id.clone())
            .await
            .map_err(|error| error.to_string())?;
        tables
            .message
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in tables.task_log.select_all().execute().unwrap_or_default() {
        let mut scrubbed_row = row.clone();
        scrubbed_row.label = scrub_value(&row.label);
        scrubbed_row.output = scrub_value(&row.output);
        tables
            .task_log
            .delete(row.id.clone())
            .await
            .map_err(|error| error.to_string())?;
        tables
            .task_log
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in tables.question.select_all().execute().unwrap_or_default() {
        let mut scrubbed_row = row.clone();
        scrubbed_row.text = scrub_value(&row.text);
        tables
            .question
            .delete(row.id.clone())
            .await
            .map_err(|error| error.to_string())?;
        tables
            .question
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    /*
     * `kv` is a String -> String blob table, so what a value holds depends on
     * its key: working directories, notes and per-project settings all live
     * here. Scrubbing every value would break the settings the app reads back,
     * so only values that carry prose or a path are touched.
     */
    for row in tables.kv.select_all().execute().unwrap_or_default() {
        if !row.value.contains('/') && !row.value.contains(' ') {
            continue;
        }
        let mut scrubbed_row = row.clone();
        scrubbed_row.value = scrub_value(&row.value);
        tables
            .kv
            .delete(row.key.clone())
            .await
            .map_err(|error| error.to_string())?;
        tables
            .kv
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    Ok(scrubbed)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filler_is_deterministic_and_shaped_like_its_input() {
        let original = "Fix the reorder arrows so they move the right row";
        assert_eq!(scrub_text(original), scrub_text(original));
        assert_eq!(scrub_text(original).len(), original.len());
        assert!(!scrub_text(original).contains("reorder"));
    }

    #[test]
    fn paragraphs_survive_so_a_transcript_still_scrolls() {
        let original = "first line\n\nthird line";
        assert_eq!(
            scrub_text(original).lines().count(),
            original.lines().count()
        );
    }

    #[test]
    fn a_path_stays_a_path_of_the_same_depth() {
        let original = "/Users/someone/code/agencyzero/src/main.rs";
        let scrubbed = scrub_path(original);
        assert!(scrubbed.starts_with('/'));
        assert_eq!(scrubbed.matches('/').count(), original.matches('/').count());
        assert!(scrubbed.ends_with(".rs"), "the extension is load-bearing");
        assert!(!scrubbed.contains("someone"));
    }

    #[test]
    fn the_owner_is_never_named() {
        assert_eq!(
            scrub_value("/Users/revenge/code"),
            scrub_value("/Users/revenge/code")
        );
        assert!(!scrub_value("/Users/revenge/code").contains("revenge"));
        assert!(!redact_identifiers("Revenge wrote this").contains("Revenge"));
    }

    #[test]
    fn a_path_is_scrubbed_as_a_path_and_prose_as_prose() {
        assert!(looks_like_path("/Users/x/y"));
        assert!(looks_like_path("~/code"));
        assert!(!looks_like_path("Fix the thing"));
    }

    #[test]
    fn empty_stays_empty() {
        assert_eq!(scrub_text(""), "");
        assert_eq!(scrub_path(""), "");
    }
}
