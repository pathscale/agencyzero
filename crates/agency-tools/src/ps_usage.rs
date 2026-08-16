//! Usage statistics over the recorded directive events.
//!
//! # Where the numbers come from
//!
//! Every number here is counted from rows the application already writes at the
//! points where it parses and applies a directive, through the app's own
//! parser. Nothing is re-parsed from prose with a second pattern: a separate
//! matcher would drift from the real one and report a surface the app does not
//! actually implement.
//!
//! The source table is content-free by construction, so this reports incidence
//! and outcome. It cannot report what any prompt said, and no amount of
//! post-processing recovers that.
//!
//! # Two counting rules that are easy to get wrong
//!
//! * A turn counts **once** no matter how many directives it carried. The unit
//!   of the incidence questions is the turn, not the directive.
//! * The window is closed at both ends: a row stamped exactly at `WINDOW_END`
//!   is in, one second later is out.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::study_event::StudyEventRow;

/// Start of the measurement window, inclusive, as RFC 3339.
///
/// Empty on purpose. A default window would silently produce a number for a
/// span nobody chose, and that number would look exactly as authoritative as a
/// deliberate one.
pub const WINDOW_START: &str = "";

/// End of the measurement window, inclusive, as RFC 3339.
pub const WINDOW_END: &str = "";

/// The pathway value the app stamps on a directive it parsed from agent text.
const PATHWAY_DIRECTIVE: &str = "ps";

/// The pathway value carrying one record per submitted turn.
const PATHWAY_TURN: &str = "study";

/// The operation naming a turn submission rather than a directive.
const OPERATION_TURN: &str = "turn.submit";

/// The detail key saying whether the person wrote a directive themselves.
const DETAIL_USER_AUTHORED: &str = "userAuthoredPs";

/// The stage naming the moment a directive was recognised in text.
const STAGE_PARSED: &str = "parsed";

/// Outcome buckets, as the app records them.
///
/// `directives.rs`'s `study_result` has exactly two terminal arms, `applied`
/// and `refused`, the second carrying a typed code. There is deliberately no
/// third bucket here: inventing one would report a distinction the application
/// does not make. A value outside this set is counted as failed under an
/// `unrecognized:` code, so a future arm shows up as a finding rather than
/// vanishing into a total.
const OUTCOME_APPLIED: &str = "applied";
const OUTCOME_REFUSED: &str = "refused";
const OUTCOME_OBSERVED: &str = "observed";

/// Which declared surface a verb belongs to.
///
/// Derived from the verb rather than stored, because the verb is what the app
/// commits to. These three names are generic and are published unchanged.
#[must_use]
pub fn surface_of(operation: &str) -> &'static str {
    match operation {
        "items.state" | "items.add" | "items.describe" | "items.retire" => "task_list",
        "ask" => "question",
        "pr.link" | "pr.retire" | "issue.link" => "pr_report",
        _ => "other",
    }
}

/// The published name for a verb, for output that must not be searchable.
///
/// One fixed substitute per real verb, applied everywhere or nowhere. The shape
/// survives — a namespace, a dot, a noun and an action — so structure stays
/// legible while the literal strings do not match a search for this project.
#[must_use]
pub fn blinded_verb(operation: &str) -> &'static str {
    match operation {
        "items.state" => "app:list.setstate",
        "items.add" => "app:list.insert",
        "items.describe" => "app:list.annotate",
        "items.retire" => "app:list.remove",
        "settings.update" => "app:config.set",
        "ask" => "app:query.raise",
        "pr.link" => "app:review.attach",
        "pr.retire" => "app:review.detach",
        "issue.link" => "app:tracker.attach",
        "app.restart" => "app:runtime.cycle",
        OPERATION_TURN => "app:turn.submit",
        _ => "app:other.unknown",
    }
}

/// Every metric, in the order the report presents them.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Report {
    pub window_start: String,
    pub window_end: String,
    pub forward: Incidence,
    pub reverse: Incidence,
    pub surfaces: Vec<SurfaceCount>,
    pub verbs: Vec<VerbCount>,
    pub outcomes: Outcomes,
    pub sustained: Sustained,
}

/// One incidence question: how many turns, how many carried a directive.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Incidence {
    pub turns: usize,
    pub turns_with_directive: usize,
    /// One decimal place, so two runs over one log agree exactly.
    pub percent: String,
}

impl Incidence {
    fn new(turns: usize, with: usize) -> Self {
        Self {
            turns,
            turns_with_directive: with,
            percent: percent(with, turns),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SurfaceCount {
    pub surface: String,
    pub events: usize,
    pub share_percent: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VerbCount {
    pub verb: String,
    pub events: usize,
}

/// Outcome totals, plus the check that every event reached one.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Outcomes {
    pub honored: usize,
    /// Always zero, and kept so the shape of the table is stable.
    ///
    /// The application has no "normalized" terminal state: a directive is
    /// applied or refused. Reporting the field as a structural zero is honest;
    /// dropping it would make a reader wonder whether it went uncounted, and
    /// synthesising one from refusal codes would invent a result the app never
    /// reached.
    pub normalized: usize,
    pub failed: usize,
    pub failed_by_code: Vec<CodeCount>,
    /// Parsed directives with no terminal record. Zero is the expected value;
    /// anything else is a finding about the instrumentation, so it is a field
    /// rather than an assertion that would hide it by aborting.
    pub events_without_outcome: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CodeCount {
    pub code: String,
    pub events: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Sustained {
    pub distinct_days: usize,
    pub distinct_sessions: usize,
    pub events_per_day: Vec<DayCount>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DayCount {
    pub day: String,
    pub events: usize,
}

/// `count/total` to one decimal place, and `0.0` when there is nothing to divide.
fn percent(count: usize, total: usize) -> String {
    if total == 0 {
        return "0.0".into();
    }
    #[expect(
        clippy::cast_precision_loss,
        reason = "counts here are far below the f64 integer limit"
    )]
    let value = (count as f64) * 100.0 / (total as f64);
    format!("{value:.1}")
}

/// The calendar day of an RFC 3339 stamp, as `YYYY-MM-DD`.
fn day_of(at: &str) -> &str {
    at.split('T').next().unwrap_or(at)
}

/// Whether `at` falls inside the window, both ends inclusive.
///
/// String comparison, which is ordering-correct for RFC 3339 stamps in a single
/// zone. The app writes them in one zone with fixed width, so this holds.
fn in_window(at: &str, start: &str, end: &str) -> bool {
    at >= start && at <= end
}

/// Read `userAuthoredPs` out of the allow-listed detail object.
fn user_authored(detail: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(detail)
        .ok()
        .and_then(|value| value.get(DETAIL_USER_AUTHORED)?.as_bool())
        .unwrap_or(false)
}

/// Count every metric over the rows that fall inside the window.
///
/// # Errors
/// When either window constant is unset. Refusing beats defaulting: a report
/// over an unstated span is worse than no report.
pub fn build(rows: &[StudyEventRow], start: &str, end: &str) -> eyre::Result<Report> {
    if start.is_empty() || end.is_empty() {
        eyre::bail!(
            "set WINDOW_START and WINDOW_END (RFC 3339) before running; \
             they are intentionally empty so no window is chosen by default"
        );
    }

    let windowed: Vec<&StudyEventRow> = rows
        .iter()
        .filter(|row| in_window(&row.at, start, end))
        .collect();

    // Forward: one record per submitted turn, carrying whether the person
    // authored a directive. Turn rows are the denominator, so a turn with three
    // directives still counts once on both sides of the ratio.
    let mut forward_turns = BTreeSet::new();
    let mut forward_with = BTreeSet::new();
    for row in &windowed {
        if row.pathway == PATHWAY_TURN && row.operation == OPERATION_TURN {
            forward_turns.insert(row.turn_id.clone());
            if user_authored(&row.detail) {
                forward_with.insert(row.turn_id.clone());
            }
        }
    }

    // Reverse: turns in which the agent emitted at least one directive. Counted
    // from the parse record, so a directive that later failed still counts as
    // emitted, which is the question being asked.
    let mut reverse_with = BTreeSet::new();
    for row in &windowed {
        if row.pathway == PATHWAY_DIRECTIVE && row.stage == STAGE_PARSED {
            reverse_with.insert(row.turn_id.clone());
        }
    }

    let mut surfaces: BTreeMap<&str, usize> = BTreeMap::new();
    let mut verbs: BTreeMap<String, usize> = BTreeMap::new();
    let mut honored = 0usize;
    let mut failed = 0usize;
    let mut failed_by_code: BTreeMap<String, usize> = BTreeMap::new();
    let mut parsed: BTreeSet<String> = BTreeSet::new();
    let mut terminal: BTreeSet<String> = BTreeSet::new();
    let mut days: BTreeMap<String, usize> = BTreeMap::new();
    let mut sessions: BTreeSet<String> = BTreeSet::new();

    for row in &windowed {
        if row.pathway != PATHWAY_DIRECTIVE {
            continue;
        }
        sessions.insert(row.study_id.clone());
        *days.entry(day_of(&row.at).to_owned()).or_default() += 1;

        if row.stage == STAGE_PARSED {
            *surfaces.entry(surface_of(&row.operation)).or_default() += 1;
            *verbs.entry(row.operation.clone()).or_default() += 1;
            if !row.interaction_id.is_empty() {
                parsed.insert(row.interaction_id.clone());
            }
            continue;
        }

        // Terminal record for a directive already counted at parse time.
        if !row.interaction_id.is_empty() {
            terminal.insert(row.interaction_id.clone());
        }
        match row.outcome.as_str() {
            OUTCOME_APPLIED => honored += 1,
            OUTCOME_REFUSED => {
                failed += 1;
                let code = if row.code.is_empty() {
                    "unspecified".to_owned()
                } else {
                    row.code.clone()
                };
                *failed_by_code.entry(code).or_default() += 1;
            }
            // `observed` is a non-terminal marker; anything else is unknown to
            // this reader and is reported rather than folded into a bucket.
            OUTCOME_OBSERVED => {}
            other => {
                failed += 1;
                *failed_by_code
                    .entry(format!("unrecognized:{other}"))
                    .or_default() += 1;
            }
        }
    }

    let surface_total: usize = surfaces.values().sum();
    let mut surface_rows: Vec<SurfaceCount> = surfaces
        .into_iter()
        .map(|(surface, events)| SurfaceCount {
            surface: surface.to_owned(),
            events,
            share_percent: percent(events, surface_total),
        })
        .collect();
    // Descending by count, then by name, so equal counts still order the same
    // way on every run.
    surface_rows.sort_by(|a, b| b.events.cmp(&a.events).then_with(|| a.surface.cmp(&b.surface)));

    let mut verb_rows: Vec<VerbCount> = verbs
        .into_iter()
        .map(|(verb, events)| VerbCount { verb, events })
        .collect();
    verb_rows.sort_by(|a, b| b.events.cmp(&a.events).then_with(|| a.verb.cmp(&b.verb)));

    let mut code_rows: Vec<CodeCount> = failed_by_code
        .into_iter()
        .map(|(code, events)| CodeCount { code, events })
        .collect();
    code_rows.sort_by(|a, b| b.events.cmp(&a.events).then_with(|| a.code.cmp(&b.code)));

    let events_without_outcome = parsed.difference(&terminal).count();

    Ok(Report {
        window_start: start.to_owned(),
        window_end: end.to_owned(),
        forward: Incidence::new(forward_turns.len(), forward_with.len()),
        reverse: Incidence::new(forward_turns.len(), reverse_with.len()),
        surfaces: surface_rows,
        verbs: verb_rows,
        outcomes: Outcomes {
            honored,
            // Structural zero: see the field docs on `Outcomes`.
            normalized: 0,
            failed,
            failed_by_code: code_rows,
            events_without_outcome,
        },
        sustained: Sustained {
            distinct_days: days.len(),
            distinct_sessions: sessions.len(),
            events_per_day: days
                .into_iter()
                .map(|(day, events)| DayCount { day, events })
                .collect(),
        },
    })
}

/// The same report with every identifying string replaced.
///
/// Verbs go through the fixed mapping, session ids become `s1`, `s2`, ... in
/// first-seen order. Surface names and dates pass through: they are generic and
/// they are the point of the table.
#[must_use]
pub fn blind(report: &Report) -> Report {
    let mut blinded = report.clone();
    blinded.verbs = report
        .verbs
        .iter()
        .map(|entry| VerbCount {
            verb: blinded_verb(&entry.verb).to_owned(),
            events: entry.events,
        })
        .collect();
    blinded
}

/// Renumber session ids as `s1`, `s2`, ... in the order first seen.
///
/// Kept separate from [`blind`] because the count is all the report publishes;
/// this exists so a caller holding rows can map ids consistently if it ever
/// needs to emit them.
#[must_use]
pub fn session_pseudonyms(rows: &[StudyEventRow]) -> BTreeMap<String, String> {
    let mut seen: Vec<String> = Vec::new();
    for row in rows {
        if !row.study_id.is_empty() && !seen.contains(&row.study_id) {
            seen.push(row.study_id.clone());
        }
    }
    seen.into_iter()
        .enumerate()
        .map(|(index, id)| (id, format!("s{}", index + 1)))
        .collect()
}

/// The report as a plain table.
#[must_use]
pub fn render(report: &Report) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "window: {} .. {} (inclusive)\n\n",
        report.window_start, report.window_end
    ));

    out.push_str("incidence\n");
    out.push_str(&format!(
        "  user prompts                {:>6}\n",
        report.forward.turns
    ));
    out.push_str(&format!(
        "  ... with a directive        {:>6}  {}%\n",
        report.forward.turns_with_directive, report.forward.percent
    ));
    out.push_str(&format!(
        "  agent turns                 {:>6}\n",
        report.reverse.turns
    ));
    out.push_str(&format!(
        "  ... with a directive        {:>6}  {}%\n\n",
        report.reverse.turns_with_directive, report.reverse.percent
    ));

    out.push_str("surfaces\n");
    for entry in &report.surfaces {
        out.push_str(&format!(
            "  {:<24} {:>6}  {}%\n",
            entry.surface, entry.events, entry.share_percent
        ));
    }
    if report.surfaces.is_empty() {
        out.push_str("  (none)\n");
    }

    out.push_str("\nverbs\n");
    for entry in &report.verbs {
        out.push_str(&format!("  {:<24} {:>6}\n", entry.verb, entry.events));
    }
    if report.verbs.is_empty() {
        out.push_str("  (none)\n");
    }

    out.push_str("\noutcomes\n");
    out.push_str(&format!(
        "  honored                     {:>6}\n",
        report.outcomes.honored
    ));
    out.push_str(&format!(
        "  normalized                  {:>6}\n",
        report.outcomes.normalized
    ));
    out.push_str(&format!(
        "  failed                      {:>6}\n",
        report.outcomes.failed
    ));
    for entry in &report.outcomes.failed_by_code {
        out.push_str(&format!(
            "    {:<24} {:>6}\n",
            entry.code, entry.events
        ));
    }
    out.push_str(&format!(
        "  without an outcome          {:>6}{}\n\n",
        report.outcomes.events_without_outcome,
        if report.outcomes.events_without_outcome == 0 {
            ""
        } else {
            "   <- finding, expected 0"
        }
    ));

    out.push_str("sustained use\n");
    out.push_str(&format!(
        "  distinct days               {:>6}\n",
        report.sustained.distinct_days
    ));
    out.push_str(&format!(
        "  distinct sessions           {:>6}\n",
        report.sustained.distinct_sessions
    ));
    for entry in &report.sustained.events_per_day {
        out.push_str(&format!("  {:<24} {:>6}\n", entry.day, entry.events));
    }
    if report.sustained.events_per_day.is_empty() {
        out.push_str("  (none)\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "2026-08-10T00:00:00Z";
    const END: &str = "2026-08-11T23:59:59Z";

    #[expect(
        clippy::too_many_arguments,
        reason = "a fixture row mirrors the stored columns; grouping them into a
                  builder would hide which column each value lands in"
    )]
    fn row(
        at: &str,
        study: &str,
        turn: &str,
        interaction: &str,
        pathway: &str,
        operation: &str,
        stage: &str,
        outcome: &str,
        code: &str,
        detail: &str,
    ) -> StudyEventRow {
        StudyEventRow {
            id: format!("event-{at}-{operation}-{stage}"),
            study_id: study.into(),
            at: at.into(),
            project_id: "project-alpha".into(),
            turn_id: turn.into(),
            interaction_id: interaction.into(),
            agent: "claude".into(),
            pathway: pathway.into(),
            operation: operation.into(),
            stage: stage.into(),
            outcome: outcome.into(),
            code: code.into(),
            target_kind: "item".into(),
            target_id: "item-7".into(),
            latency_ms: 4,
            detail: detail.into(),
            app_version: "0.8.7".into(),
            parser_version: "p/0.1.0".into(),
            protocol_version: "proto/0.1".into(),
        }
    }

    /// Fourteen records: two turns that carried directives, one that did not,
    /// one normalized, one rejected with a code, one parse with no terminal
    /// record, and two rows placed at the window edges.
    fn fixture() -> Vec<StudyEventRow> {
        vec![
            // Turn 1: person wrote a directive; agent emitted two.
            row("2026-08-10T09:00:00Z", "study-a", "t1", "", PATHWAY_TURN, OPERATION_TURN, "submitted", OUTCOME_OBSERVED, "", r#"{"userAuthoredPs":true}"#),
            row("2026-08-10T09:00:01Z", "study-a", "t1", "i1", PATHWAY_DIRECTIVE, "items.add", STAGE_PARSED, OUTCOME_OBSERVED, "", "{}"),
            row("2026-08-10T09:00:02Z", "study-a", "t1", "i1", PATHWAY_DIRECTIVE, "items.add", "completed", OUTCOME_APPLIED, "", "{}"),
            row("2026-08-10T09:00:03Z", "study-a", "t1", "i2", PATHWAY_DIRECTIVE, "ask", STAGE_PARSED, OUTCOME_OBSERVED, "", "{}"),
            row("2026-08-10T09:00:04Z", "study-a", "t1", "i2", PATHWAY_DIRECTIVE, "ask", "completed", OUTCOME_APPLIED, "", "{}"),
            // Turn 2: no directive from the person, one from the agent that failed.
            row("2026-08-10T10:00:00Z", "study-a", "t2", "", PATHWAY_TURN, OPERATION_TURN, "submitted", OUTCOME_OBSERVED, "", r#"{"userAuthoredPs":false}"#),
            row("2026-08-10T10:00:01Z", "study-a", "t2", "i3", PATHWAY_DIRECTIVE, "pr.link", STAGE_PARSED, OUTCOME_OBSERVED, "", "{}"),
            row("2026-08-10T10:00:02Z", "study-a", "t2", "i3", PATHWAY_DIRECTIVE, "pr.link", "completed", OUTCOME_REFUSED, "unknown_item", "{}"),
            // Turn 3, next day, different session: no directive either way.
            row("2026-08-11T08:00:00Z", "study-b", "t3", "", PATHWAY_TURN, OPERATION_TURN, "submitted", OUTCOME_OBSERVED, "", r#"{"userAuthoredPs":false}"#),
            // Turn 4: a parse with no terminal record, which must surface.
            row("2026-08-11T09:00:00Z", "study-b", "t4", "", PATHWAY_TURN, OPERATION_TURN, "submitted", OUTCOME_OBSERVED, "", r#"{"userAuthoredPs":false}"#),
            row("2026-08-11T09:00:01Z", "study-b", "t4", "i4", PATHWAY_DIRECTIVE, "items.state", STAGE_PARSED, OUTCOME_OBSERVED, "", "{}"),
            // Exactly at the end of the window: included.
            row("2026-08-11T23:59:59Z", "study-b", "t5", "i5", PATHWAY_DIRECTIVE, "items.state", STAGE_PARSED, OUTCOME_OBSERVED, "", "{}"),
            row("2026-08-11T23:59:59Z", "study-b", "t5", "i5", PATHWAY_DIRECTIVE, "items.state", "completed", OUTCOME_APPLIED, "", "{}"),
            // One second past the end: excluded.
            row("2026-08-12T00:00:00Z", "study-c", "t6", "i6", PATHWAY_DIRECTIVE, "items.add", STAGE_PARSED, OUTCOME_OBSERVED, "", "{}"),
        ]
    }

    #[test]
    fn refuses_to_run_without_a_window() {
        assert!(build(&fixture(), "", END).is_err());
        assert!(build(&fixture(), START, "").is_err());
    }

    #[test]
    fn counts_a_turn_once_however_many_directives_it_carried() {
        let report = build(&fixture(), START, END).expect("fixture builds");
        // Four turn.submit rows are in the window; t5's directives belong to a
        // turn with no submit row, so the denominator stays four.
        assert_eq!(report.forward.turns, 4);
        assert_eq!(report.forward.turns_with_directive, 1);
        assert_eq!(report.forward.percent, "25.0");
        // t1 carried two directives and still counts once. t1, t2, t4, t5.
        assert_eq!(report.reverse.turns_with_directive, 4);
    }

    #[test]
    fn window_end_is_inclusive_and_one_second_later_is_not() {
        let report = build(&fixture(), START, END).expect("fixture builds");
        // i5 at exactly WINDOW_END is counted; i6 one second later is not.
        let adds = report
            .verbs
            .iter()
            .find(|entry| entry.verb == "items.add")
            .map_or(0, |entry| entry.events);
        assert_eq!(adds, 1, "only turn 1's add is inside the window");
        let states = report
            .verbs
            .iter()
            .find(|entry| entry.verb == "items.state")
            .map_or(0, |entry| entry.events);
        assert_eq!(states, 2, "the row exactly at the end is included");
    }

    #[test]
    fn surfaces_split_by_verb_and_share_totals_to_a_hundred() {
        let report = build(&fixture(), START, END).expect("fixture builds");
        let task_list = report
            .surfaces
            .iter()
            .find(|entry| entry.surface == "task_list")
            .expect("task_list present");
        assert_eq!(task_list.events, 3);
        assert_eq!(task_list.share_percent, "60.0");
        let question = report
            .surfaces
            .iter()
            .find(|entry| entry.surface == "question")
            .expect("question present");
        assert_eq!(question.events, 1);
        let pr = report
            .surfaces
            .iter()
            .find(|entry| entry.surface == "pr_report")
            .expect("pr_report present");
        assert_eq!(pr.events, 1);
    }

    #[test]
    fn verbs_are_ordered_by_count_descending() {
        let report = build(&fixture(), START, END).expect("fixture builds");
        let counts: Vec<usize> = report.verbs.iter().map(|entry| entry.events).collect();
        let mut sorted = counts.clone();
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        assert_eq!(counts, sorted);
    }

    #[test]
    fn outcomes_split_by_bucket_and_missing_terminals_are_reported() {
        let report = build(&fixture(), START, END).expect("fixture builds");
        assert_eq!(report.outcomes.honored, 3);
        assert_eq!(report.outcomes.normalized, 0, "the app has no normalized state");
        assert_eq!(report.outcomes.failed, 1);
        assert_eq!(report.outcomes.failed_by_code.len(), 1);
        assert_eq!(report.outcomes.failed_by_code[0].code, "unknown_item");
        // i4 parsed and never reached a terminal record: exactly the case the
        // field exists to surface.
        assert_eq!(report.outcomes.events_without_outcome, 1);
    }

    #[test]
    fn sustained_use_counts_days_and_sessions() {
        let report = build(&fixture(), START, END).expect("fixture builds");
        assert_eq!(report.sustained.distinct_days, 2);
        assert_eq!(report.sustained.distinct_sessions, 2);
        assert_eq!(report.sustained.events_per_day.len(), 2);
        assert_eq!(report.sustained.events_per_day[0].day, "2026-08-10");
        assert_eq!(report.sustained.events_per_day[0].events, 6);
    }

    #[test]
    fn the_same_log_produces_the_same_report() {
        let first = build(&fixture(), START, END).expect("fixture builds");
        let second = build(&fixture(), START, END).expect("fixture builds");
        assert_eq!(first, second);
    }

    #[test]
    fn blinded_output_carries_nothing_identifying() {
        let rows = fixture();
        let report = build(&rows, START, END).expect("fixture builds");
        let blinded = blind(&report);
        let json = serde_json::to_string(&blinded).expect("blinded report serializes");

        for verb in [
            "items.add",
            "items.state",
            "items.describe",
            "items.retire",
            "pr.link",
            "issue.link",
        ] {
            assert!(!json.contains(verb), "blinded output still names {verb}");
        }
        for leak in [
            "project-alpha",
            "item-7",
            "study-a",
            "study-b",
            "claude",
            "https://",
            "/Users/",
            "apps/gui",
        ] {
            assert!(!json.contains(leak), "blinded output still carries {leak}");
        }

        // Structure survives: the verb count and ordering are unchanged.
        assert_eq!(blinded.verbs.len(), report.verbs.len());
        assert_eq!(blinded.surfaces, report.surfaces);
        assert_eq!(blinded.sustained, report.sustained);
        assert!(json.contains("app:list.insert"));
    }

    #[test]
    fn session_pseudonyms_are_sequential_in_first_seen_order() {
        let names = session_pseudonyms(&fixture());
        assert_eq!(names.get("study-a").map(String::as_str), Some("s1"));
        assert_eq!(names.get("study-b").map(String::as_str), Some("s2"));
        assert_eq!(names.get("study-c").map(String::as_str), Some("s3"));
    }

    #[test]
    fn an_empty_window_reports_zeroes_rather_than_failing() {
        let report = build(&[], START, END).expect("an empty log is a valid input");
        assert_eq!(report.forward.turns, 0);
        assert_eq!(report.forward.percent, "0.0");
        assert!(report.verbs.is_empty());
        assert_eq!(report.outcomes.events_without_outcome, 0);
    }
}
