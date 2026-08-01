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
//! caller is responsible for that (see `items_from_reply`), which is why this
//! module reads one line at a time and knows nothing about fences.

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
    /// 13.2.2. Closed and declared. An unlisted verb parses to nothing.
    pub verbs: &'static [&'static str],
    /// 13.2.2. Verbs and values reserved to principals above the agent.
    pub reserved: &'static [&'static str],
    /// 13.2.3. The reach, written down rather than implied by a parameter.
    ///
    /// `items.inject` takes a project, so the surface can write outside the
    /// project the turn came from. That is deliberate and is the whole reason
    /// this field exists: cross-scope reach must be part of the declared bound,
    /// never left implicit in what a verb happens to do.
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
        "items.inject",
        "pr.link",
    ],
    reserved: &["status:finished", "status:canceled"],
    bound: "any project in this installation's store, named by id or by name; \
            no reach outside it, and no other namespace is live",
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
        title: String,
        status: String,
    },
    /// Attach a pull request to an item.
    PrLink { number: String, item: String },
    /// Remove a row, by id.
    ///
    /// The cleanup verb, and the reason it exists is that the old one deleted
    /// by *title*. On a duplicate pair, which is exactly what the title-matching
    /// bug produced, both rows carry the same title, so a delete by title picks
    /// one of them at random. That is not a cleanup tool. This one names the
    /// row it means, and an unknown id is refused like everywhere else.
    ItemRetire { id: String },
}

/// What became of one directive, in the agent's own words back to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Applied. Carries what to say about it.
    Done(String),
    /// Refused, with a code the agent can act on rather than a sentence.
    Refused { what: String, code: String },
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
}

/// Read one `key: value` out of a directive's arguments.
///
/// Quotes optional: a title is prose and whoever writes one should not have to
/// think about which half of the pair needs them. Values may contain commas
/// inside quotes, which a title routinely does.
fn arg<'a>(args: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = args;
    while !rest.trim().is_empty() {
        let (pair, tail) = split_pair(rest);
        rest = tail;
        let Some((found, value)) = pair.split_once(':') else {
            continue;
        };
        if found.trim().eq_ignore_ascii_case(key) {
            let value = value.trim();
            let unquoted = value
                .strip_prefix('"')
                .and_then(|inner| inner.strip_suffix('"'))
                .or_else(|| {
                    value
                        .strip_prefix('\'')
                        .and_then(|inner| inner.strip_suffix('\''))
                })
                .unwrap_or(value);
            return Some(unquoted.trim());
        }
    }
    None
}

/// Split off the first `key: value`, respecting quotes around the value.
fn split_pair(args: &str) -> (&str, &str) {
    let mut quote: Option<char> = None;
    for (at, ch) in args.char_indices() {
        match (quote, ch) {
            (Some(open), c) if c == open => quote = None,
            (None, '"' | '\'') => quote = Some(ch),
            (None, ',') => return (&args[..at], &args[at + 1..]),
            _ => {}
        }
    }
    (args, "")
}

/// Recognize one directive on one line, or nothing.
///
/// The verb is folded as ASCII: a capitalised spelling is casual input for the
/// canonical lowercase, and a verb written with a confusable (a Cyrillic `а` in
/// `agency`) folds to nothing and stays inert, which is the point of doing it
/// this way rather than with a Unicode fold.
#[must_use]
pub fn parse(line: &str) -> Option<Directive> {
    let inner = line.trim().strip_prefix("<ps")?.strip_suffix('>')?.trim();
    let (verb, args) = match inner.split_once('(') {
        Some((verb, args)) => (verb.trim(), args.strip_suffix(')')?),
        None => (inner, ""),
    };

    if verb.eq_ignore_ascii_case("@agency:items.state") {
        let id = arg(args, "id")?;
        let status = arg(args, "status")?;
        return (!id.is_empty() && !status.is_empty()).then(|| Directive::ItemState {
            id: id.to_string(),
            status: status.to_ascii_lowercase(),
            pr: arg(args, "pr")
                .map(|number| number.trim_start_matches('#').to_string())
                .filter(|number| !number.is_empty()),
        });
    }
    if verb.eq_ignore_ascii_case("@agency:items.add") {
        let title = arg(args, "title")?;
        return (!title.is_empty()).then(|| Directive::ItemAdd {
            handle: arg(args, "ref")
                .map(str::to_string)
                .filter(|handle| !handle.is_empty()),
            title: title.to_string(),
            status: arg(args, "status")
                .unwrap_or("new")
                .to_ascii_lowercase()
                .to_string(),
        });
    }
    if verb.eq_ignore_ascii_case("@agency:items.retire") {
        let id = arg(args, "id")?;
        return (!id.is_empty()).then(|| Directive::ItemRetire { id: id.to_string() });
    }
    if verb.eq_ignore_ascii_case("@agency:pr.link") {
        let number = arg(args, "number")?.trim_start_matches('#').to_string();
        let item = arg(args, "item")?.to_string();
        return (!number.is_empty() && !item.is_empty())
            .then_some(Directive::PrLink { number, item });
    }
    None
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
                title: "Wrap it, then ship it".into(),
                status: "new".into(),
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
    fn anything_that_is_not_ours_is_not_a_directive() {
        assert!(parse("<ps @file:glossary.md>").is_none());
        assert!(parse(r#"<ps @agency:items.destroy(id: "a")>"#).is_none());
        assert!(parse("Mention @agency:items.state in a sentence").is_none());
        // Missing the fields it exists to carry.
        assert!(parse(r#"<ps @agency:items.state(status: "new")>"#).is_none());
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
