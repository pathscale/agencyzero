//! Copy the GUI's schema into `OUT_DIR` with every `queries` block removed.
//!
//! The sidecar must see the same *columns* as the GUI, because those decide the
//! on-disk layout it reads. It has no use for the queries: it calls only
//! `name_snake_case`, `version`, `load` and `select_all`.
//!
//! Sharing the files verbatim coupled the two anyway, and the coupling broke
//! CI. This crate is pinned to `worktable_dsl 1.0.0-beta.18.1` on purpose,
//! because that is the DSL whose reader understands v2 pages, while the GUI has
//! moved to 1.10. When the GUI adopted 1.10's `update_in_place`, beta.18.1's
//! parser reached a token that did not exist when it was written:
//!
//!     error: Unexpected token `update_in_place`;
//!            expected one of `update`, `delete`, `in_place`
//!
//! A `#[cfg]` on the block does not help, because the macro parses its own body
//! and rejects attributes there. Stripping the block before it is ever parsed
//! does, and it holds for whatever query syntax 1.11 introduces next.

use std::path::{Path, PathBuf};

const SCHEMA: &str = "../../../apps/gui/src/db/schema";

fn main() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(SCHEMA);
    let out =
        PathBuf::from(std::env::var_os("OUT_DIR").expect("cargo sets OUT_DIR")).join("schema");
    std::fs::create_dir_all(&out).expect("the schema output directory is created");

    println!("cargo:rerun-if-changed={}", source.display());
    for entry in std::fs::read_dir(&source).expect("the GUI schema directory is readable") {
        let entry = entry.expect("the schema entry is readable");
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "rs") {
            continue;
        }
        println!("cargo:rerun-if-changed={}", path.display());
        let text = std::fs::read_to_string(&path).expect("the schema file is readable");
        let name = path.file_name().expect("the schema file has a name");
        let body = demote_inner_docs(&strip_queries(&text));
        std::fs::write(out.join(name), body).expect("the stripped schema is written");
    }
}

/// Turn each `//!` into `//`, because these files are `include!`d into a module
/// rather than being one, and an inner doc comment is only legal at the top of
/// the thing it documents. The text is worth keeping: it is where the schema
/// explains why its columns are what they are, which is the part this crate
/// most depends on.
fn demote_inner_docs(text: &str) -> String {
    text.lines()
        .map(|line| match line.trim_start().strip_prefix("//!") {
            Some(rest) => {
                let indent = &line[..line.len() - line.trim_start().len()];
                format!("{indent}//{rest}")
            }
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Remove the `queries: { ... }` block from one `worktable!` invocation.
///
/// Brace-counting rather than a parser: the input is a macro body this crate
/// cannot parse by definition, and the block is well formed by construction
/// because the GUI compiles it. A file without one is returned unchanged.
fn strip_queries(text: &str) -> String {
    let Some(start) = text.find("queries:") else {
        return text.to_string();
    };
    let bytes = text.as_bytes();
    let Some(open) = text[start..].find('{').map(|offset| start + offset) else {
        return text.to_string();
    };
    let mut depth = 0usize;
    let mut end = None;
    for (index, byte) in bytes.iter().enumerate().skip(open) {
        match byte {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(index + 1);
                    break;
                }
            }
            _ => {}
        }
    }
    let Some(mut end) = end else {
        return text.to_string();
    };
    // Take the separating comma with it, so what is left still parses.
    if bytes.get(end) == Some(&b',') {
        end += 1;
    }
    let mut stripped = text[..start].to_string();
    stripped.push_str(&text[end..]);
    stripped
}
