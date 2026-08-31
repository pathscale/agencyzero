//! Reads `worktable!` invocations out of Rust source.
//!
//! # Why this re-implements a grammar that already exists
//!
//! The DSL is a `macro_rules!` invocation. `syn` will hand over the token
//! stream inside the parentheses and stops there: there is no typed AST for a
//! macro's own grammar, and WorkTable's real parser lives in its proc-macro
//! crate, which compiles for the compiler and returns generated code rather
//! than a description of what it read.
//!
//! So the grammar is walked again here, deliberately kept in one file and
//! deliberately kept small. It mirrors
//! `worktable/codegen/src/common/parser/`: name, then `version`, then
//! `persist`, then `partition_by`, then the `columns` / `indexes` / `queries` /
//! `config` blocks in any order. If WorkTable ever grows a schema-description
//! API, this file is the only thing that has to go.
//!
//! Unknown sections are an error rather than a shrug. A reader that silently
//! ignores what it does not understand draws a diagram that is quietly missing
//! something, which is worse than one that refuses to draw.

use std::iter::Peekable;
use std::path::Path;

use proc_macro2::{Delimiter, TokenStream, TokenTree};

use crate::model::{Column, Index, Operation, PartitionKey, Queries, Table, snake_case};

/// What went wrong, and where. Carries the file and line because the caller is
/// pointed at a directory and cannot otherwise tell which of thirty files.
#[derive(Debug, Clone)]
pub struct Error {
    pub file: String,
    pub line: usize,
    pub message: String,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {}", self.file, self.line, self.message)
    }
}

impl std::error::Error for Error {}

type Result<T> = std::result::Result<T, Error>;

/// Parse every `worktable!` in one file's source text.
///
/// `label` is what the file should be called in output and in errors; the
/// caller decides whether that is an absolute path or one relative to a root.
///
/// # Errors
/// Returns an error when the file is not parseable Rust, or when a
/// `worktable!` in it does not match the grammar.
pub fn parse_source(source: &str, label: &str) -> Result<Vec<Table>> {
    let file = syn::parse_file(source).map_err(|e| Error {
        file: label.to_string(),
        line: e.span().start().line,
        message: format!("not parseable as Rust: {e}"),
    })?;

    let lines: Vec<&str> = source.lines().collect();
    let doc = module_doc(&lines);

    let mut invocations = Vec::new();
    collect_invocations(&file.items, &mut invocations);

    let mut tables = Vec::with_capacity(invocations.len());
    for tokens in invocations {
        let mut table = parse_invocation(tokens, label, &lines)?;
        table.doc = doc.clone();
        tables.push(table);
    }
    Ok(tables)
}

/// Read a file from disk and parse it.
///
/// # Errors
/// Returns an error when the file cannot be read, or does not parse.
pub fn parse_file(path: &Path, label: &str) -> Result<Vec<Table>> {
    let source = std::fs::read_to_string(path).map_err(|e| Error {
        file: label.to_string(),
        line: 0,
        message: format!("cannot read: {e}"),
    })?;
    parse_source(&source, label)
}

/// The leading `//!` block, which is where this codebase writes down why a
/// table is shaped the way it is. Worth carrying: it is the only prose a
/// diagram can show that was not invented by the diagram.
fn module_doc(lines: &[&str]) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("//!") {
            out.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        } else if trimmed.is_empty() && out.is_empty() {
            continue;
        } else if !trimmed.starts_with("//!") {
            break;
        }
    }
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    out.join("\n")
}

/// The `//` comment block immediately above `line` (1-based), with the comment
/// markers stripped. These are ordinary comments, so they never reach the
/// token stream; the line number is the only way back to them.
fn comment_above(lines: &[&str], line: usize) -> String {
    let mut collected: Vec<String> = Vec::new();
    let mut cursor = line;
    while cursor > 1 {
        cursor -= 1;
        let text = lines.get(cursor - 1).map_or("", |l| l.trim());
        if let Some(rest) = text.strip_prefix("//") {
            if rest.starts_with('!') {
                break;
            }
            collected.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        } else {
            break;
        }
    }
    collected.reverse();
    collected.join("\n")
}

fn collect_invocations(items: &[syn::Item], out: &mut Vec<TokenStream>) {
    for item in items {
        match item {
            syn::Item::Macro(m) if m.mac.path.is_ident("worktable") => {
                out.push(m.mac.tokens.clone());
            }
            syn::Item::Mod(m) => {
                if let Some((_, inner)) = &m.content {
                    collect_invocations(inner, out);
                }
            }
            _ => {}
        }
    }
}

struct Cursor<'a> {
    iter: Peekable<proc_macro2::token_stream::IntoIter>,
    file: &'a str,
    /// The last line a token was seen on, so an error at end-of-stream can
    /// still point somewhere useful.
    line: usize,
}

impl<'a> Cursor<'a> {
    fn new(tokens: TokenStream, file: &'a str) -> Self {
        Self {
            iter: tokens.into_iter().peekable(),
            file,
            line: 0,
        }
    }

    fn err<T>(&self, message: impl Into<String>) -> Result<T> {
        Err(Error {
            file: self.file.to_string(),
            line: self.line,
            message: message.into(),
        })
    }

    fn next(&mut self) -> Option<TokenTree> {
        let tt = self.iter.next();
        if let Some(tt) = &tt {
            self.line = tt.span().start().line;
        }
        tt
    }

    fn peek_ident(&mut self) -> Option<String> {
        match self.iter.peek() {
            Some(TokenTree::Ident(i)) => Some(i.to_string()),
            _ => None,
        }
    }

    /// Consume `name` when it is the next identifier, and say whether it was.
    fn eat_ident(&mut self, name: &str) -> bool {
        if self.peek_ident().as_deref() == Some(name) {
            self.next();
            true
        } else {
            false
        }
    }

    fn ident(&mut self, what: &str) -> Result<(String, usize)> {
        match self.next() {
            Some(TokenTree::Ident(i)) => Ok((i.to_string(), i.span().start().line)),
            Some(other) => self.err(format!("expected {what}, found `{other}`")),
            None => self.err(format!("expected {what}, found end of declaration")),
        }
    }

    fn colon(&mut self) -> Result<()> {
        match self.next() {
            Some(TokenTree::Punct(p)) if p.as_char() == ':' => Ok(()),
            Some(other) => self.err(format!("expected `:`, found `{other}`")),
            None => self.err("expected `:`, found end of declaration"),
        }
    }

    fn eat_comma(&mut self) {
        if matches!(self.iter.peek(), Some(TokenTree::Punct(p)) if p.as_char() == ',') {
            self.next();
        }
    }

    fn literal(&mut self, what: &str) -> Result<String> {
        match self.next() {
            Some(TokenTree::Literal(l)) => Ok(l.to_string().replace('_', "")),
            Some(other) => self.err(format!("expected {what}, found `{other}`")),
            None => self.err(format!("expected {what}, found end of declaration")),
        }
    }

    /// The `{ ... }` after a section name.
    fn brace(&mut self, section: &str) -> Result<TokenStream> {
        match self.next() {
            Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Brace => Ok(g.stream()),
            Some(other) => self.err(format!(
                "expected a `{{ }}` block after `{section}`, found `{other}`"
            )),
            None => self.err(format!("expected a `{{ }}` block after `{section}`")),
        }
    }

    /// The `( ... )` argument list of a query.
    fn paren(&mut self, what: &str) -> Result<TokenStream> {
        match self.next() {
            Some(TokenTree::Group(g)) if g.delimiter() == Delimiter::Parenthesis => Ok(g.stream()),
            Some(other) => self.err(format!("expected `(` after {what}, found `{other}`")),
            None => self.err(format!("expected `(` after {what}")),
        }
    }

    fn done(&mut self) -> bool {
        self.iter.peek().is_none()
    }
}

fn parse_invocation(tokens: TokenStream, file: &str, lines: &[&str]) -> Result<Table> {
    let mut c = Cursor::new(tokens, file);

    // `name: Ident,` is required, and comes first.
    let (field, _) = c.ident("`name`")?;
    if field != "name" {
        return c.err(format!("expected `name` first, found `{field}`"));
    }
    c.colon()?;
    let (name, _) = c.ident("the table's name")?;
    c.eat_comma();

    // `version`, `persist` and `partition_by` are positional in WorkTable's own
    // parser, in that order, and each is optional.
    let mut version = None;
    if c.eat_ident("version") {
        c.colon()?;
        let raw = c.literal("a version number")?;
        version = Some(raw.parse::<u32>().map_err(|_| Error {
            file: file.to_string(),
            line: c.line,
            message: format!("`version: {raw}` is not a u32"),
        })?);
        c.eat_comma();
    }

    let mut persist = None;
    if c.eat_ident("persist") {
        c.colon()?;
        let (value, _) = c.ident("`true` or `false`")?;
        persist = match value.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            other => {
                return c.err(format!(
                    "expected `true` or `false` after `persist:`, found `{other}`"
                ));
            }
        };
        c.eat_comma();
    }

    let mut partition_by = None;
    if c.eat_ident("partition_by") {
        c.colon()?;
        let (key, _) = c.ident("a partition key name")?;
        c.colon()?;
        let (ty, _) = c.ident("a partition key type")?;
        c.eat_comma();
        partition_by = Some(PartitionKey { name: key, ty });
    }

    let mut columns = Vec::new();
    let mut indexes = Vec::new();
    let mut queries = Queries::default();
    let mut page_size = None;

    while !c.done() {
        let (section, _) = c.ident("a section name")?;
        c.colon()?;
        match section.as_str() {
            "columns" => {
                let body = c.brace("columns")?;
                columns = parse_columns(body, file, lines)?;
            }
            "indexes" => {
                let body = c.brace("indexes")?;
                indexes = parse_indexes(body, file)?;
            }
            "queries" => {
                let body = c.brace("queries")?;
                queries = parse_queries(body, file)?;
            }
            "config" => {
                let body = c.brace("config")?;
                page_size = parse_config(body, file)?;
            }
            other => {
                return c.err(format!(
                    "unknown section `{other}`; expected `columns`, `indexes`, `queries` or `config`"
                ));
            }
        }
        c.eat_comma();
    }

    if columns.is_empty() {
        return c.err(format!("`{name}` declares no columns"));
    }

    Ok(Table {
        table_name: snake_case(&name),
        name,
        file: file.to_string(),
        doc: String::new(),
        persist,
        version,
        partition_by,
        page_size,
        columns,
        indexes,
        queries,
    })
}

fn parse_columns(body: TokenStream, file: &str, lines: &[&str]) -> Result<Vec<Column>> {
    let mut c = Cursor::new(body, file);
    let mut out = Vec::new();
    while !c.done() {
        let (name, line) = c.ident("a column name")?;
        c.colon()?;
        let (ty, _) = c.ident("a column type")?;

        let primary_key = c.eat_ident("primary_key");
        let generator = if c.eat_ident("autoincrement") {
            Some("autoincrement".to_string())
        } else if c.eat_ident("custom") {
            Some("custom".to_string())
        } else {
            None
        };
        let optional = c.eat_ident("optional");
        let index_backend = parse_using(&mut c)?;

        c.eat_comma();
        out.push(Column {
            doc: comment_above(lines, line),
            name,
            ty,
            primary_key,
            generator,
            optional,
            index_backend,
        });
    }
    Ok(out)
}

/// `using <backend>`, shared by columns and indexes.
fn parse_using(c: &mut Cursor<'_>) -> Result<Option<String>> {
    if !c.eat_ident("using") {
        return Ok(None);
    }
    let (backend, _) = c.ident("an index backend after `using`")?;
    match backend.as_str() {
        "worktables_index" | "indexset" | "congee" | "arctic" => Ok(Some(backend)),
        other => c.err(format!(
            "unknown index backend `{other}`; expected `worktables_index`, `indexset`, `congee` or `arctic`"
        )),
    }
}

fn parse_indexes(body: TokenStream, file: &str) -> Result<Vec<Index>> {
    let mut c = Cursor::new(body, file);
    let mut out = Vec::new();
    while !c.done() {
        let (name, _) = c.ident("an index name")?;
        c.colon()?;
        let (column, _) = c.ident("the column the index covers")?;
        let unique = c.eat_ident("unique");
        let backend = parse_using(&mut c)?;
        c.eat_comma();
        out.push(Index {
            name,
            column,
            unique,
            backend,
        });
    }
    Ok(out)
}

fn parse_queries(body: TokenStream, file: &str) -> Result<Queries> {
    let mut c = Cursor::new(body, file);
    let mut queries = Queries::default();
    while !c.done() {
        let (kind, _) = c.ident("`update`, `delete` or `in_place`")?;
        c.colon()?;
        let block = c.brace(&kind)?;
        let ops = parse_operations(block, file)?;
        match kind.as_str() {
            "update" => queries.updates = ops,
            "delete" => queries.deletes = ops,
            "in_place" => queries.in_place = ops,
            other => {
                return c.err(format!(
                    "unknown query kind `{other}`; expected `update`, `delete` or `in_place`"
                ));
            }
        }
        c.eat_comma();
    }
    Ok(queries)
}

/// `Name(col, col) by column,` repeated.
fn parse_operations(body: TokenStream, file: &str) -> Result<Vec<Operation>> {
    let mut c = Cursor::new(body, file);
    let mut out = Vec::new();
    while !c.done() {
        let (name, _) = c.ident("a query name")?;
        let args = c.paren(&format!("`{name}`"))?;
        let columns = args
            .into_iter()
            .filter_map(|tt| match tt {
                TokenTree::Ident(i) => Some(i.to_string()),
                _ => None,
            })
            .collect();
        if !c.eat_ident("by") {
            return c.err(format!("expected `by` after `{name}(..)`"));
        }
        let (by, _) = c.ident("the column to select rows by")?;
        c.eat_comma();
        out.push(Operation { name, columns, by });
    }
    Ok(out)
}

/// Only `page_size` is read. `row_derives` describes the generated Rust rather
/// than the schema, and a diagram has nothing to do with it.
fn parse_config(body: TokenStream, file: &str) -> Result<Option<u32>> {
    let mut c = Cursor::new(body, file);
    let mut page_size = None;
    while !c.done() {
        let (key, _) = c.ident("a config key")?;
        c.colon()?;
        if key == "page_size" {
            let raw = c.literal("a page size")?;
            page_size = raw.parse::<u32>().ok();
            c.eat_comma();
        } else {
            // Skip the value, whatever shape it has, up to the next comma.
            while !c.done() {
                if matches!(c.iter.peek(), Some(TokenTree::Punct(p)) if p.as_char() == ',') {
                    c.next();
                    break;
                }
                c.next();
            }
        }
    }
    Ok(page_size)
}
