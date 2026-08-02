//! What the agent says back about state, and what the app does with it.
//!
//! # Why this is not the checkbox contract
//!
//! Items were maintained by writing `- [/] Some title` in a reply, matched
//! against the list by lowercased title. That fails in one specific way, and it
//! fails silently: a title retyped with one word different does not match, so
//! the update lands as a *new row*, and nothing tells either side. Over a
//! session the list fills with near-duplicates while every individual turn
//! looks like it worked.
//!
//! The deeper problem is that the agent was asked to maintain a list it could
//! not see. Nothing about the item list was ever sent to it, so every reference
//! was a guess at a string.
//!
//! So: the app sends ids, the agent sends ids back, and each directive gets a
//! typed outcome that is quoted back on the next turn. An unknown id is a
//! rejection rather than an insert, which is the whole of the duplicate bug.
//!
//! # Provenance
//!
//! These are Prompt Syntax spans, and PS's inert-content rule applies: only
//! text the agent authored is parsed, never a quoted or fenced example. The
//! caller is responsible for that (see `apply_directives`), which is why this
//! module reads one line at a time and knows nothing about fences.

use promptsyntax::{Argument, Directive as ParsedDirective, Parser, Reference, Scalar};

/// The authoring surface this application declares, per Prompt Syntax 13.2.
///
/// A standing promotion: model-generated text is inert by default, and an
/// application may declare, once and at its own authority, that a named
/// delimited grammar produced by its own agent is authored. The declaration
/// has to say four things, and this is them.
///
/// It is the source rather than a description of one. `docs/ps-capability.yaml`
/// is checked against it by a test, so the published document cannot drift
/// away from what the parser actually does, which is the failure mode of every
/// capability document that is written by hand beside the code.
pub struct Surface {
    /// 13.2.1. An explicit designation, never a scan over undifferentiated
    /// output: a `<ps …>` span on its own line.
    pub delimiter: &'static str,
    /// 13.2.2. The vendor-extension namespace whose references are live.
    pub namespace: &'static str,
    /// 13.2.2. Closed and declared. An unlisted authored verb is refused.
    pub verbs: &'static [&'static str],
    /// 13.2.2. Verbs and values reserved to principals above the agent.
    pub reserved: &'static [&'static str],
    /// 13.2.3. The reach, written down rather than implied by a parameter.
    ///
    /// `items.add(project: ...)` can write outside the project the turn came
    /// from. Home may also create the explicitly named project. Item ids are
    /// installation-wide. That reach is deliberate and must be declared,
    /// never left implicit in verb semantics.
    pub bound: &'static str,
}

/// What this build promotes. Referenced from the prompt, published as YAML.
pub const SURFACE: Surface = Surface {
    delimiter: "<ps …> on its own line, outside fenced or quoted content",
    namespace: "agency",
    verbs: &[
        "items.state",
        "items.add",
        "items.retire",
        "pr.link",
        "issue.link",
    ],
    reserved: &["status:finished", "status:canceled"],
    bound: "any project in this installation's store, named by id or by name; \
            Home Task Manager may create a named project inside that store through \
            items.add; no reach outside it, and no other namespace is live",
};

/// The statuses an agent may set.
///
/// `finished` is deliberately absent. The owner closes an item, because an
/// agent can say it shipped something but cannot say the thing works, and this
/// is the mechanical form of that rule: a house style note can be forgotten,
/// a parser that refuses cannot. `canceled` is absent for the same reason,
/// retiring work is the owner's call.
const SETTABLE: [&str; 5] = ["new", "planning", "active", "questions", "shipped"];

/// One thing the agent asked the app to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Directive {
    /// Move a row that already exists. The id is the app's own.
    ItemState {
        id: String,
        status: String,
        /// The pull request it shipped as, when the status says `shipped`.
        pr: Option<String>,
    },
    /// Open a row that does not exist yet.
    ///
    /// `handle` is the agent's own temporary name for it, echoed back beside
    /// the real id in the receipt. Without it a new item could only be
    /// addressed by title until the next turn, which is the failure this
    /// module exists to remove.
    ItemAdd {
        handle: Option<String>,
        /// Another project in this installation, by id or exact name.
        ///
        /// Used by Home's task manager so it speaks the same item language as
        /// an ordinary project instead of switching to a JSONL dialect.
        project: Option<String>,
        title: String,
        status: String,
    },
    /// Track a pull request, and optionally attach it to an item.
    ///
    /// A URL creates the PR row. A number is enough only when an item is also
    /// named, because a bare number says nothing about which repository owns
    /// it. Keeping both forms lets an already tracked PR be attached cheaply.
    PrLink {
        url: Option<String>,
        number: Option<String>,
        item: Option<String>,
    },
    /// Associate one item with a GitHub issue URL.
    IssueLink { url: String, item: String },
    /// Remove a row, by id.
    ///
    /// The cleanup verb, and the reason it exists is that the old one deleted
    /// by *title*. On a duplicate pair, which is exactly what the title-matching
    /// bug produced, both rows carry the same title, so a delete by title picks
    /// one of them at random. That is not a cleanup tool. This one names the
    /// row it means, and an unknown id is refused like everywhere else.
    ItemRetire { id: String },
}

impl Directive {
    /// Stable, content-free labels for deployment-study records.
    #[must_use]
    pub fn operation(&self) -> &'static str {
        match self {
            Self::ItemState { .. } => "items.state",
            Self::ItemAdd { .. } => "items.add",
            Self::ItemRetire { .. } => "items.retire",
            Self::PrLink { .. } => "pr.link",
            Self::IssueLink { .. } => "issue.link",
        }
    }
}

/// What became of one directive, in the agent's own words back to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Applied. Carries what to say about it.
    Done(String),
    /// Refused, with a code the agent can act on rather than a sentence.
    Refused { what: String, code: String },
}

/// What a standalone `<ps …>` authoring segment resolved to.
///
/// Ordinary prose is not represented here at all. Once a line explicitly
/// enters the declared surface, however, it must become either a directive or
/// a typed refusal. Treating an unknown or malformed reference as ordinary
/// text would violate the reverse-channel fill contract and leave the agent
/// unable to correct it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Authored {
    Directive(Directive),
    Refused(Outcome),
}

impl Outcome {
    /// One line for the receipt.
    #[must_use]
    pub fn line(&self) -> String {
        match self {
            Self::Done(said) => said.clone(),
            Self::Refused { what, code } => format!("rejected: {what} [{code}]"),
        }
    }

    /// Terminal state and typed code for a content-free study row.
    #[must_use]
    pub fn study_result(&self) -> (&'static str, String) {
        match self {
            Self::Done(_) => ("applied", String::new()),
            Self::Refused { code, .. } => ("refused", code.clone()),
        }
    }
}

fn scalar_text(value: &Scalar) -> Option<String> {
    match value {
        Scalar::String(value) | Scalar::Number(value) | Scalar::Bare(value) => {
            Some(value.trim().to_string())
        }
        Scalar::Boolean(value) => Some(value.to_string()),
        Scalar::Null => None,
    }
}

fn arg(arguments: &[Argument], key: &str) -> Option<String> {
    arguments
        .iter()
        .find(|argument| argument.key.eq_ignore_ascii_case(key))
        .and_then(|argument| scalar_text(&argument.value))
}

fn authored_reference(line: &str) -> Option<Result<Reference, String>> {
    let trimmed = line.trim();
    let header = trimmed.strip_prefix("<ps")?;
    if !header.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    let namespace = header.trim_start().strip_prefix('@')?.split_once(':')?.0;
    if !namespace.eq_ignore_ascii_case(SURFACE.namespace) {
        return None;
    }
    let parsed = Parser::new().authoring_namespace(namespace).parse(trimmed);
    let segment = parsed.segments.as_slice().first()?;
    if parsed.segments.len() != 1
        || segment.span().start != 0
        || segment.span().end != trimmed.len()
    {
        return None;
    }
    let promptsyntax::Segment::Directive(segment) = segment else {
        return None;
    };
    match &segment.directive {
        ParsedDirective::AuthoringSegment { reference } => Some(Ok(reference.clone())),
        ParsedDirective::InvalidAuthoringSegment { header } => Some(Err(header.clone())),
        _ => None,
    }
}

fn from_reference(reference: &Reference) -> Option<Directive> {
    let verb = reference.name.as_str();
    let args = &reference.arguments;
    if verb.eq_ignore_ascii_case("items.state") {
        let id = arg(args, "id")?;
        let status = arg(args, "status")?;
        return (!id.is_empty() && !status.is_empty()).then(|| Directive::ItemState {
            id,
            status: status.to_ascii_lowercase(),
            pr: arg(args, "pr")
                .map(|number| number.trim_start_matches('#').to_string())
                .filter(|number| !number.is_empty()),
        });
    }
    if verb.eq_ignore_ascii_case("items.add") {
        let title = arg(args, "title")?;
        return (!title.is_empty()).then(|| Directive::ItemAdd {
            handle: arg(args, "ref").filter(|handle| !handle.is_empty()),
            project: arg(args, "project").filter(|project| !project.is_empty()),
            title,
            status: arg(args, "status")
                .unwrap_or_else(|| "new".to_string())
                .to_ascii_lowercase(),
        });
    }
    if verb.eq_ignore_ascii_case("items.retire") {
        let id = arg(args, "id")?;
        return (!id.is_empty()).then_some(Directive::ItemRetire { id });
    }
    if verb.eq_ignore_ascii_case("pr.link") {
        let url = arg(args, "url").filter(|url| !url.is_empty());
        let number = arg(args, "number")
            .map(|number| number.trim_start_matches('#').to_string())
            .filter(|number| !number.is_empty());
        let item = arg(args, "item").filter(|item| !item.is_empty());
        return (url.is_some() || (number.is_some() && item.is_some()))
            .then_some(Directive::PrLink { url, number, item });
    }
    if verb.eq_ignore_ascii_case("issue.link") {
        let url = arg(args, "url")?;
        let item = arg(args, "item")?;
        return (!url.is_empty() && !item.is_empty()).then_some(Directive::IssueLink { url, item });
    }
    None
}

/// Recognize one directive on one line, or nothing.
///
/// The verb is folded as ASCII: a capitalised spelling is casual input for the
/// canonical lowercase, and a verb written with a confusable (a Cyrillic `а` in
/// `agency`) folds to nothing and stays inert, which is the point of doing it
/// this way rather than with a Unicode fold.
#[must_use]
#[cfg(test)]
pub fn parse(line: &str) -> Option<Directive> {
    authored_reference(line)
        .and_then(Result::ok)
        .as_ref()
        .and_then(from_reference)
}

/// Resolve one explicit authoring segment, including its failure path.
///
/// `None` means the line never designated itself as this surface. A line that
/// does start with the declared `<ps ` delimiter always returns an outcome:
/// unknown references fail binding, while a known verb with an invalid shape
/// fails syntax validation. Both are receipts rather than silent raw text.
#[must_use]
pub fn parse_authored(line: &str) -> Option<Authored> {
    let parsed = authored_reference(line)?;
    let (named, known, directive) = match parsed {
        Ok(reference) => {
            let named = format!("@{}:{}", SURFACE.namespace, reference.name);
            let known = SURFACE
                .verbs
                .iter()
                .any(|candidate| reference.name.eq_ignore_ascii_case(candidate));
            let directive = from_reference(&reference);
            (named, known, directive)
        }
        Err(header) => {
            let verb = header
                .split_once('(')
                .map_or(header.as_str(), |(verb, _)| verb)
                .trim();
            let named = if verb.is_empty() {
                "authored Prompt Syntax segment".to_string()
            } else {
                verb.chars().take(96).collect()
            };
            let known = SURFACE.verbs.iter().any(|candidate| {
                verb.eq_ignore_ascii_case(&format!("@{}:{candidate}", SURFACE.namespace))
            });
            (named, known, None)
        }
    };
    if let Some(directive) = directive {
        return Some(Authored::Directive(directive));
    }
    Some(Authored::Refused(Outcome::Refused {
        what: named,
        code: if known {
            "SYNTAX_INVALID".into()
        } else {
            "ENTITY_NOT_FOUND".into()
        },
    }))
}

/// Whether the agent is allowed to set this status.
#[must_use]
pub fn settable(status: &str) -> bool {
    SETTABLE.contains(&status)
}

/// Resolve an id or a unique prefix against what exists.
///
/// A prefix is accepted because the full id is a uuid and the agent pays for
/// every one of them, twice, on every turn. Two matches is an ambiguity and is
/// surfaced rather than guessed at, which is Prompt Syntax's resolution rule
/// and also the only safe reading: picking one would move the wrong row.
pub fn resolve<'a>(known: &[&'a str], named: &str) -> Result<&'a str, String> {
    let named = named.trim();
    if let Some(exact) = known.iter().find(|id| **id == named) {
        return Ok(exact);
    }
    let mut matched = known.iter().filter(|id| id.starts_with(named));
    match (matched.next(), matched.next()) {
        (Some(one), None) => Ok(one),
        (Some(_), Some(_)) => Err("ENTITY_AMBIGUOUS".into()),
        _ => Err("ENTITY_NOT_FOUND".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_state_directive_carries_an_id_a_status_and_a_pull_request() {
        assert_eq!(
            parse(r#"<ps @agency:items.state(id: "item-a3f9", status: "shipped", pr: 66)>"#),
            Some(Directive::ItemState {
                id: "item-a3f9".into(),
                status: "shipped".into(),
                pr: Some("66".into()),
            })
        );
        // `#66` is how a person writes it, so it is accepted and normalised.
        let hashed = parse(r##"<ps @agency:items.state(id: "x", status: "shipped", pr: "#66")>"##);
        assert!(matches!(hashed, Some(Directive::ItemState { pr: Some(ref n), .. }) if n == "66"));
    }

    /// A title is prose: it has commas in it, and quoting it should be the
    /// only thing the writer has to remember.
    #[test]
    fn a_title_may_contain_a_comma() {
        assert_eq!(
            parse(r#"<ps @agency:items.add(ref: "t1", title: "Wrap it, then ship it")>"#),
            Some(Directive::ItemAdd {
                handle: Some("t1".into()),
                project: None,
                title: "Wrap it, then ship it".into(),
                status: "new".into(),
            })
        );
    }

    #[test]
    fn an_item_add_may_name_another_project() {
        assert_eq!(
            parse(
                r#"<ps @agency:items.add(project: "Prompt Syntax", ref: "t1", title: "Unify the surface", status: "planning")>"#
            ),
            Some(Directive::ItemAdd {
                handle: Some("t1".into()),
                project: Some("Prompt Syntax".into()),
                title: "Unify the surface".into(),
                status: "planning".into(),
            })
        );
    }

    #[test]
    fn a_pr_url_may_be_tracked_with_or_without_an_item() {
        let url = "https://github.com/pathscale/agencyzero/pull/76";
        assert_eq!(
            parse(&format!(r#"<ps @agency:pr.link(url: "{url}")>"#)),
            Some(Directive::PrLink {
                url: Some(url.into()),
                number: None,
                item: None,
            })
        );
        assert_eq!(
            parse(r#"<ps @agency:pr.link(number: 76, item: "item-a3f9")>"#),
            Some(Directive::PrLink {
                url: None,
                number: Some("76".into()),
                item: Some("item-a3f9".into()),
            })
        );
        assert!(parse(r#"<ps @agency:pr.link(number: 76)>"#).is_none());
    }

    #[test]
    fn a_github_issue_may_be_attached_to_an_item() {
        let url = "https://github.com/pathscale/agencyzero/issues/42";
        assert_eq!(
            parse(&format!(
                r#"<ps @agency:issue.link(url: "{url}", item: "item-a3f9")>"#
            )),
            Some(Directive::IssueLink {
                url: url.into(),
                item: "item-a3f9".into(),
            })
        );
    }

    /// Casual capitalisation compiles to the canonical verb; a confusable does
    /// not bind at all, because the fold is ASCII.
    #[test]
    fn the_verb_folds_as_ascii_only() {
        assert!(parse(r#"<ps @Agency:Items.State(id: "a", status: "new")>"#).is_some());
        assert!(parse(r#"<ps @аgency:items.state(id: "a", status: "new")>"#).is_none());
    }

    #[test]
    fn bidi_controls_cannot_disguise_an_authored_mutation() {
        assert!(
            parse("<ps @agency:items.state(id: \"item-a3f9\", status: \"active\u{202e}\")>")
                .is_none()
        );
    }

    #[test]
    fn anything_that_is_not_ours_is_not_a_directive() {
        assert!(parse("<ps @file:glossary.md>").is_none());
        assert!(parse(r#"<ps @agency:items.destroy(id: "a")>"#).is_none());
        assert!(parse(r#"<ps @agency:items.inject(project: "ui")>"#).is_none());
        assert!(parse("- [ ] A checklist is display text").is_none());
        assert!(parse("Mention @agency:items.state in a sentence").is_none());
        // Missing the fields it exists to carry.
        assert!(parse(r#"<ps @agency:items.state(status: "new")>"#).is_none());
    }

    #[test]
    fn an_authored_segment_never_fails_as_silent_text() {
        let valid =
            parse_authored(r#"<ps @agency:items.state(id: "item-869382d3", status: "active")>"#);
        assert!(matches!(
            valid,
            Some(Authored::Directive(Directive::ItemState { ref id, .. }))
                if id == "item-869382d3"
        ));

        let unknown = parse_authored(r#"<ps @agency:items.destroy(id: "item-a3f9")>"#);
        assert!(matches!(
            unknown,
            Some(Authored::Refused(Outcome::Refused { ref code, .. }))
                if code == "ENTITY_NOT_FOUND"
        ));

        let malformed = parse_authored(r#"<ps @agency:items.state(status: "active")>"#);
        assert!(matches!(
            malformed,
            Some(Authored::Refused(Outcome::Refused { ref code, .. }))
                if code == "SYNTAX_INVALID"
        ));
        assert_eq!(parse_authored("ordinary prose"), None);
    }

    /// The owner closes an item. The agent can report that it shipped
    /// something; it cannot report that the thing works, because it is not the
    /// one looking at the screen.
    #[test]
    fn an_agent_may_not_finish_or_cancel_a_row() {
        assert!(settable("shipped"));
        assert!(settable("questions"));
        assert!(!settable("finished"));
        assert!(!settable("canceled"));
    }

    /// Retiring names the row. The verb it replaces matched by title, which on
    /// a duplicate pair, the exact thing this whole shape exists to stop
    /// producing, would have removed one of the two at random.
    /// The published document is generated from the declaration, not written
    /// beside it. A capability document that drifts from the parser is worse
    /// than none: it is a promise about behaviour that nothing enforces.
    #[test]
    fn the_published_capability_document_matches_the_declaration() {
        let published = include_str!("../../../docs/ps-capability.yaml");
        for verb in SURFACE.verbs {
            assert!(
                published.contains(&format!("- {}:{verb}", SURFACE.namespace)),
                "{verb} is live and undeclared"
            );
        }
        for reserved in SURFACE.reserved {
            assert!(
                published.contains(reserved),
                "{reserved} is reserved and unpublished"
            );
        }
        assert!(published.contains(SURFACE.namespace));
        // The bound is the point of 13.2.3: reach that is real must be written.
        assert!(published.contains("any project in this installation"));
    }

    #[test]
    fn retiring_takes_an_id_and_nothing_else() {
        assert_eq!(
            parse(r#"<ps @agency:items.retire(id: "item-26f0")>"#),
            Some(Directive::ItemRetire {
                id: "item-26f0".into()
            })
        );
        assert!(parse(r#"<ps @agency:items.retire(title: "Some row")>"#).is_none());
        assert!(parse(r#"<ps @agency:items.retire(id: "")>"#).is_none());
    }

    #[test]
    fn a_prefix_resolves_only_when_it_is_unique() {
        let known = ["item-a3f9c2d1", "item-a3f9ffff", "item-77b0e4aa"];
        assert_eq!(resolve(&known, "item-77b0e4aa"), Ok("item-77b0e4aa"));
        assert_eq!(resolve(&known, "item-77"), Ok("item-77b0e4aa"));
        assert_eq!(resolve(&known, "item-a3f9"), Err("ENTITY_AMBIGUOUS".into()));
        assert_eq!(resolve(&known, "item-zzzz"), Err("ENTITY_NOT_FOUND".into()));
        // An exact id wins even where it is also a prefix of another.
        let shadowed = ["item-a3f9", "item-a3f9c2d1"];
        assert_eq!(resolve(&shadowed, "item-a3f9"), Ok("item-a3f9"));
    }
}
