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

/// Replace a name that has to stay distinct from every other name.
///
/// `scrub_text` seeds from the text itself, so two different projects whose
/// real names happened to share a length collapse to the same filler: the
/// rebuilt profile had 71 projects called `epsilon delta west omega alpha eta
/// eta l` and two called `e`. Every check that drives a control *by name* then
/// becomes ambiguous - `press "Rename e"` had two candidates and pressed the
/// wrong one, so a working editor read as dead.
///
/// Mixing the row's id into the seed restores what the real data had and the
/// filler threw away. Still deterministic: the same id and name always give the
/// same output, so a rebuild is a readable diff rather than a wall of churn.
/// A short name cannot be made unique by reseeding alone: a five-character slot
/// holds one word from a twenty-word list, so sixty-four of them collapse into
/// nineteen however the seed is chosen. Past this length there is room for
/// several words and collisions stop mattering; below it the discriminator does
/// the work.
const NAME_NEEDS_A_DISCRIMINATOR: usize = 12;

/// Scrub a name, keeping it distinct from every other scrubbed name.
pub fn scrub_name(original: &str, id: &str) -> String {
    if original.trim().is_empty() {
        return String::new();
    }
    if looks_like_path(original) {
        return redact_identifiers(&scrub_path(original));
    }
    let seed = seed_of(original) ^ seed_of(id);
    let base = filler(original, seed);
    if original.len() >= NAME_NEEDS_A_DISCRIMINATOR {
        return redact_identifiers(&base);
    }
    /*
     * Short names get a suffix rather than a reseed, and the result is allowed
     * to be longer than the original.
     *
     * Length is load-bearing for wrapping and truncation, but *uniqueness* is
     * load-bearing for every check that drives a control by name, and a name
     * this short cannot have both. Uniqueness wins: a two-character project
     * name that wraps differently costs nothing, while two projects called `e`
     * cost a working editor reported as dead.
     */
    let suffix = seed % 1_000;
    redact_identifiers(&format!("{base}{suffix}"))
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

/// Scrub a JSON array of paths, keeping it parseable JSON.
///
/// `project.dirs` is a JSON-encoded list of working directories. Passing it
/// through `scrub_value` would treat the whole `["/a","/b"]` blob as prose and
/// destroy the brackets and quotes the read path expects, so the array is taken
/// apart, each element scrubbed as the path it is, and the array rebuilt.
///
/// This field is why an earlier profile shipped with real directories in it:
/// `project.name` was scrubbed and `project.dirs` sat untouched beside it, so
/// the committed store still named the owner's home directory and every
/// repository they had open.
pub fn scrub_dirs(original: &str) -> String {
    let trimmed = original.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let Ok(serde_json::Value::Array(entries)) = serde_json::from_str(trimmed) else {
        // Not the JSON array we expect. Scrub it as a plain path rather than
        // leave an unrecognised shape unscrubbed.
        return scrub_value(original);
    };
    let scrubbed: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| match entry.as_str() {
            Some(path) => serde_json::Value::String(scrub_path(path)),
            None => entry.clone(),
        })
        .collect();
    serde_json::Value::Array(scrubbed).to_string()
}

/// Projects kept at full depth, because the checks and the timings need them.
///
/// Everything else is capped hard. A profile trimmed flat would still exercise
/// every control while quietly making every timing meaningless, so the depth
/// goes where it is load-bearing: these are the two deepest project transcripts
/// in the store after the owner's own, which is excluded for being four times
/// larger than anything a check reads.
///
/// Matched by **id**, not by name. Matching the scrubbed name was tried and is
/// circular: the scrubber has to run to produce the name, the name decides how
/// much history to keep, and any change to the scrubber silently stops matching.
/// It did exactly that - a change to how names are seeded left every project
/// capped at the light budget and the profile lost 94% of its task log with no
/// error. An id is stable across rebuilds and independent of scrubbing.
const HEAVY_PROJECTS: &[&str] = &[
    "proj-c238fef5-9b7d-49d3-8c8c-551c9af054a2",
    "proj-79aef7ba-ac75-47b6-8bd3-e2b71439c39b",
];

/// Task-log rows kept for a heavy project.
///
/// The log pages at well under this, so the paging controls still have more
/// than one page to walk. Sized against the 20-40 MB the profile is budgeted
/// for: these two projects are where the depth goes, because they are the only
/// ones a timing is ever taken against.
const HEAVY_TASK_LOG_ROWS: usize = 2_600;

/// Task-log rows kept for every other project.
///
/// Enough that a row-level control has something to act on, not enough for 294
/// projects to add up to anything. This one is multiplied by ~292, so it is the
/// number that sets the floor.
const LIGHT_TASK_LOG_ROWS: usize = 20;

/// Messages kept per project, on the same reasoning as the task log.
const HEAVY_MESSAGE_ROWS: usize = 1_200;
const LIGHT_MESSAGE_ROWS: usize = 12;

/// The ids that survive into the committed profile.
struct Keep {
    task_log: std::collections::HashSet<String>,
    message: std::collections::HashSet<String>,
    /// Which of `HEAVY_PROJECTS` this store actually contains, so a list that
    /// has gone stale is an error rather than a quietly thinner profile.
    heavy_found: std::collections::HashSet<String>,
}

/// Choose what survives, keeping the shape the checks depend on.
///
/// The scrubber replaces text with filler of exactly the same length, so a
/// scrubbed 114 MB store would still be 114 MB. Size has to come out by
/// dropping rows, and which rows are dropped is the whole design: an evenly
/// thinned store loses the deep transcript that makes paging and scrolling
/// worth measuring, so depth is kept where it is load-bearing and discarded
/// everywhere else.
fn plan(source: &crate::db::tables::Tables) -> Keep {
    let heavy: std::collections::HashSet<String> = source
        .project
        .select_all()
        .execute()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| HEAVY_PROJECTS.contains(&row.id.as_str()))
        .map(|row| row.id)
        .collect();

    /*
     * Newest rows are kept, oldest dropped. The UI opens a log at its tail and
     * a transcript at its end, so the rows a check actually reads are the
     * recent ones; trimming from the front would leave a store that is the
     * right size and empty everywhere the app looks.
     */
    let mut task_log_rows = source.task_log.select_all().execute().unwrap_or_default();
    task_log_rows.sort_by(|a, b| b.finished_at.cmp(&a.finished_at));
    let mut task_log = std::collections::HashSet::new();
    let mut seen_per_project: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for row in task_log_rows {
        let budget = if heavy.contains(&row.project_id) {
            HEAVY_TASK_LOG_ROWS
        } else {
            LIGHT_TASK_LOG_ROWS
        };
        let seen = seen_per_project.entry(row.project_id.clone()).or_insert(0);
        if *seen < budget {
            *seen += 1;
            task_log.insert(row.id);
        }
    }

    let mut message_rows = source.message.select_all().execute().unwrap_or_default();
    message_rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let mut message = std::collections::HashSet::new();
    let mut seen_per_project: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for row in message_rows {
        let budget = if heavy.contains(&row.project_id) {
            HEAVY_MESSAGE_ROWS
        } else {
            LIGHT_MESSAGE_ROWS
        };
        let seen = seen_per_project.entry(row.project_id.clone()).or_insert(0);
        if *seen < budget {
            *seen += 1;
            message.insert(row.id);
        }
    }

    Keep {
        task_log,
        message,
        heavy_found: heavy,
    }
}

/// Read a real store and write a scrubbed one, row by row.
///
/// # Why this copies forward instead of editing in place
///
/// It used to copy the store and scrub the copy. That cannot be made to work,
/// and the failure is silent: `.wt.data` is append-only, so a delete writes a
/// tombstone and an update appends a new version while **the original bytes
/// stay in the file**. Scrubbing a copied 114 MB store left 20,135 occurrences
/// of the owner's home path in `task_log` alone - slightly *more* than the
/// 19,514 it started with, because scrubbing appends. Every row read back was
/// clean, every check passed, and `strings` on the file showed the owner's
/// shell history.
///
/// So the destination is opened empty and only ever receives text that has
/// already been through `scrub_value`. Nothing unscrubbed is written, which is
/// the only version of this that cannot leak by omission: a field nobody
/// remembered to scrub is a field that was never copied, and shows up as
/// missing data rather than as private data.
pub async fn build(source: &Path, destination: &Path) -> Result<usize, String> {
    if !source.is_dir() {
        return Err(format!("no store at {}", source.display()));
    }
    if destination.exists() {
        std::fs::remove_dir_all(destination).map_err(|error| error.to_string())?;
    }

    /*
     * The source is opened at a throwaway path, never at the owner's own
     * directory: `Tables::open` is read-write and takes a lock, so pointing it
     * at the live store would put a QA tool one bug away from the only copy of
     * the owner's data. The copy is deleted before this returns.
     */
    let staging = destination.with_extension("source-copy");
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    copy_tree(source, &staging).map_err(|error| error.to_string())?;

    let source_tables = crate::db::tables::Tables::open(&staging)
        .await
        .map_err(|error| format!("could not open the copied store: {error}"))?;
    let tables = crate::db::tables::Tables::open(destination)
        .await
        .map_err(|error| format!("could not create the destination store: {error}"))?;

    let result = copy_scrubbed(&source_tables, &tables).await;

    /*
     * Drain before returning, or the profile is torn.
     *
     * WorkTable persists asynchronously, so the inserts above have only been
     * queued when `copy_scrubbed` returns. Returning straight into
     * `process::exit` truncated whichever table was still being written, and
     * the app refused the result with `torn or corrupt persisted table at
     * .../usage_ledger: early eof`. The write path is the same one the running
     * app uses at quit, so the fix is the same call the app makes: shut the
     * tables down and let them finish.
     */
    tables
        .shutdown()
        .await
        .map_err(|error| format!("the profile did not drain: {error}"))?;

    // The staging copy is unscrubbed by definition. It does not outlive this
    // call whether the build succeeded or failed.
    let _ = source_tables.shutdown().await;
    let _ = std::fs::remove_dir_all(&staging);

    result
}

/// Select what survives, scrub it, and insert it into the empty store.
async fn copy_scrubbed(
    source: &crate::db::tables::Tables,
    tables: &crate::db::tables::Tables,
) -> Result<usize, String> {
    let keep = plan(source);
    eprintln!(
        "qa-profile: keeping {} task-log rows and {} messages",
        keep.task_log.len(),
        keep.message.len()
    );
    /*
     * A profile with no deep project is not a smaller profile, it is a useless
     * one: nothing left in it is worth timing against. This went unnoticed once
     * already - the heavy list stopped matching and the store lost 94% of its
     * task log while still reporting success - so it fails the build rather
     * than printing a number nobody reads.
     */
    if keep.heavy_found.is_empty() {
        return Err(format!(
            "none of the heavy projects are in this store: {}. \
             They are matched by id; if the source store changed, update \
             HEAVY_PROJECTS to the deepest projects it actually has.",
            HEAVY_PROJECTS.join(", ")
        ));
    }
    if keep.heavy_found.len() < HEAVY_PROJECTS.len() {
        eprintln!(
            "qa-profile: warning, only {} of {} heavy projects found",
            keep.heavy_found.len(),
            HEAVY_PROJECTS.len()
        );
    }

    let mut scrubbed = 0usize;

    for row in source.project.select_all().execute().unwrap_or_default() {
        let mut scrubbed_row = row.clone();
        // By id, so two projects never end up sharing a name. Checks drive
        // projects by name and a duplicate makes the press ambiguous.
        scrubbed_row.name = scrub_name(&row.name, &row.id);
        // The working directories, which name the owner's home and every
        // repository they had open. Scrubbed as JSON so the list stays a list.
        scrubbed_row.dirs = scrub_dirs(&row.dirs);
        tables
            .project
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source
        .project_item
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        let mut scrubbed_row = row.clone();
        // Row controls are driven by their item's title, so these have to stay
        // distinct for the same reason project names do.
        scrubbed_row.title = scrub_name(&row.title, &row.id);
        tables
            .project_item
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    /*
     * Message bodies, task-log labels and command output: the bulk of the
     * private content. The task log is the worst of them, because every shell
     * command the agent ran is in it verbatim, home directory and all.
     */
    for row in source.message.select_all().execute().unwrap_or_default() {
        if !keep.message.contains(&row.id) {
            continue;
        }
        let mut scrubbed_row = row.clone();
        scrubbed_row.body = scrub_value(&row.body);
        tables
            .message
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source.task_log.select_all().execute().unwrap_or_default() {
        if !keep.task_log.contains(&row.id) {
            continue;
        }
        let mut scrubbed_row = row.clone();
        scrubbed_row.label = scrub_value(&row.label);
        scrubbed_row.output = scrub_value(&row.output);
        tables
            .task_log
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    /*
     * The overflow half of every long message.
     *
     * A body over the inline cap is split: the head stays on the `message` row
     * and the tail spills into `message_chunk`. Scrubbing only `message`
     * therefore cleans the first page of a long reply and leaves the rest
     * verbatim, which is how 4,308 occurrences of the owner's paths survived a
     * run that reported the store scrubbed. The tail of a long message is the
     * likeliest place for a pasted transcript or a diff, so this is the more
     * sensitive half, not the lesser one.
     *
     * A chunk whose message was dropped is not copied: it would be an orphan
     * carrying the tail of a body that is no longer here.
     */
    for row in source
        .message_chunk
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        if !keep.message.contains(&row.message_id) {
            continue;
        }
        let mut scrubbed_row = row.clone();
        scrubbed_row.text = scrub_value(&row.text);
        tables
            .message_chunk
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    /*
     * In-flight reply snapshots. `payload` is a serialised partial reply, so it
     * holds the same prose as a message and outlives the crash it exists for.
     */
    for row in source
        .reply_checkpoint
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        let mut scrubbed_row = row.clone();
        scrubbed_row.payload = scrub_value(&row.payload);
        tables
            .reply_checkpoint
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    /*
     * Every shell command the agent proposed. Clean in the profile sampled on
     * 2026-08-23, but only because that store happened to hold none with a home
     * path in it.
     */
    for row in source.agent_io.select_all().execute().unwrap_or_default() {
        let mut scrubbed_row = row.clone();
        scrubbed_row.detail = scrub_value(&row.detail);
        tables
            .agent_io
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source.question.select_all().execute().unwrap_or_default() {
        let mut scrubbed_row = row.clone();
        scrubbed_row.text = scrub_value(&row.text);
        // `issue_url` is deliberately left alone. The repositories it points at
        // are public, so nothing leaks, and a real link is worth more than a
        // synthetic one: it gives the issue-connectivity path something live to
        // resolve against.
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
    /*
     * The remaining tables, which the old in-place build carried across simply
     * by copying the files. Copying forward means anything not listed here is
     * silently absent from the profile, so these are copied explicitly even
     * where every column is an id or a counter.
     *
     * `pull_request` names a real repository and branch, `approval_rule` holds
     * the signature of a real command, and `study_event.detail` is free text.
     */
    /*
     * Pull requests keep their real url, repo and branch. They point at public
     * repositories, so there is nothing to leak, and a live link is the only
     * way the PR and issue connectivity paths get exercised against something
     * that actually resolves.
     */
    for row in source
        .pull_request
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        tables
            .pull_request
            .insert(row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source
        .approval_rule
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        let mut scrubbed_row = row.clone();
        scrubbed_row.signature = scrub_value(&row.signature);
        tables
            .approval_rule
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source
        .study_event
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        let mut scrubbed_row = row.clone();
        scrubbed_row.detail = scrub_value(&row.detail);
        tables
            .study_event
            .insert(scrubbed_row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source
        .question_reply
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        tables
            .question_reply
            .insert(row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source
        .item_completion
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        tables
            .item_completion
            .insert(row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source
        .usage_ledger
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        tables
            .usage_ledger
            .insert(row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source
        .usage_cache
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        tables
            .usage_cache
            .insert(row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source
        .usage_session
        .select_all()
        .execute()
        .unwrap_or_default()
    {
        tables
            .usage_session
            .insert(row)
            .map_err(|error| error.to_string())?;
        scrubbed += 1;
    }

    for row in source.kv.select_all().execute().unwrap_or_default() {
        let mut scrubbed_row = row.clone();
        // Every row is copied, but only the ones that carry prose or a path are
        // rewritten: a flag or an id scrubbed into filler is a setting the app
        // reads back as garbage.
        if row.value.contains('/') || row.value.contains(' ') {
            scrubbed_row.value = scrub_value(&row.value);
        }
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

    /*
     * The regression these guard is not hypothetical. The profile built on
     * 2026-08-22 was scrubbed by this module and still shipped 33,792 real home
     * paths, because `project.dirs` held a JSON array nothing took apart.
     */
    #[test]
    fn working_directories_are_scrubbed_and_stay_json() {
        let original = r#"["/Users/revenge/code/agencyzero","/Users/revenge/notes"]"#;
        let scrubbed = scrub_dirs(original);
        assert!(!scrubbed.contains("revenge"), "{scrubbed}");
        assert!(!scrubbed.contains("agencyzero"), "{scrubbed}");
        let parsed: serde_json::Value =
            serde_json::from_str(&scrubbed).expect("the read path parses this back as JSON");
        let entries = parsed.as_array().expect("still an array");
        assert_eq!(entries.len(), 2, "a project keeps its directory count");
        assert!(
            entries
                .iter()
                .all(|entry| entry.as_str().is_some_and(|path| path.starts_with('/'))),
            "each entry is still an absolute path: {scrubbed}"
        );
    }

    #[test]
    fn a_dirs_value_that_is_not_an_array_is_still_scrubbed() {
        // Fail closed: an unrecognised shape must not pass through untouched.
        assert!(!scrub_dirs("/Users/revenge/code").contains("revenge"));
    }

    #[test]
    fn empty_dirs_stay_empty() {
        assert_eq!(scrub_dirs(""), "");
        assert_eq!(scrub_dirs("   "), "");
    }

    #[test]
    fn two_projects_with_the_same_shape_do_not_collapse_to_one_name() {
        /*
         * The regression: the rebuilt profile had 71 projects sharing a name and
         * two called `e`, because `filler` is seeded from the text and two real
         * names of the same length produce the same output. `press "Rename e"`
         * then had two candidates, pressed the wrong one, and a working editor
         * read as dead.
         */
        let first = scrub_name("alpha", "proj-1111");
        let second = scrub_name("gamma", "proj-2222");
        assert_ne!(first, second, "same length must not mean same name");

        // Same row twice is still the same name: a rebuild has to be a readable
        // diff, not a wall of churn.
        assert_eq!(scrub_name("alpha", "proj-1111"), first);

        // The property the fixtures actually need: a run of same-length names
        // stays a run of distinct names. These are short enough to need the
        // discriminator, which is exactly the case that used to collapse.
        let names: std::collections::HashSet<String> = (0..64)
            .map(|n| scrub_name("wxyz", &format!("proj-{n}")))
            .collect();
        assert_eq!(names.len(), 64, "short names must not collide");

        // A name long enough to hold several words keeps its length exactly,
        // because wrapping and truncation are what that length is for.
        let long = "a project name long enough to wrap";
        assert_eq!(scrub_name(long, "proj-1").len(), long.len());
    }

    #[test]
    fn a_name_that_is_a_path_is_still_scrubbed_as_a_path() {
        let scrubbed = scrub_name("/Users/revenge/code/thing", "proj-1");
        assert!(!scrubbed.contains("revenge"));
        assert!(scrubbed.starts_with('/'));
    }

    #[test]
    fn an_email_address_does_not_survive_prose() {
        // Third-party addresses were in the message tail, not just the owner's
        // own name: the profile carried two collaborators' real gmail accounts.
        let scrubbed = scrub_value("ping maksim.volkov.03@gmail.com about the branch");
        assert!(!scrubbed.contains('@'), "{scrubbed}");
        assert!(!scrubbed.contains("gmail"), "{scrubbed}");
    }
}
