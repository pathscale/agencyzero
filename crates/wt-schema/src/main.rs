//! `wt-schema`: print a WorkTable schema as JSON.
//!
//! ```text
//! wt-schema <path>... [--overlay <file>] [--out <file>]
//! ```
//!
//! Paths may be directories of schema files or individual `.rs` files. The
//! output is the input to the visual editor and is committed, so the frontend
//! needs no backend command to draw a diagram and the diagram can be reviewed
//! as a diff.

use std::path::PathBuf;
use std::process::ExitCode;

use wt_schema::{Overlay, read_dir_with, read_files};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("wt-schema: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut overlay_path: Option<PathBuf> = None;
    let mut out_path: Option<PathBuf> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--overlay" => {
                overlay_path = Some(PathBuf::from(
                    args.next().ok_or("`--overlay` needs a file")?,
                ));
            }
            "--out" => {
                out_path = Some(PathBuf::from(args.next().ok_or("`--out` needs a file")?));
            }
            "-h" | "--help" => {
                println!("wt-schema <path>... [--overlay <file>] [--out <file>]");
                return Ok(());
            }
            other if other.starts_with('-') => return Err(format!("unknown flag `{other}`")),
            other => paths.push(PathBuf::from(other)),
        }
    }

    if paths.is_empty() {
        return Err("no paths given; pass a schema directory or one or more .rs files".to_string());
    }

    let overlay = match &overlay_path {
        Some(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("cannot read overlay {}: {e}", path.display()))?;
            serde_json::from_str::<Overlay>(&text)
                .map_err(|e| format!("overlay {} is not valid: {e}", path.display()))?
        }
        None => Overlay::default(),
    };

    let mut tables = Vec::new();
    let mut relationships = Vec::new();
    let mut unresolved = Vec::new();
    let mut loose: Vec<PathBuf> = Vec::new();

    for path in &paths {
        if path.is_dir() {
            let schema = read_dir_with(path, &overlay).map_err(|e| e.to_string())?;
            tables.extend(schema.tables);
            relationships.extend(schema.relationships);
            unresolved.extend(schema.unresolved);
        } else {
            loose.push(path.clone());
        }
    }
    if !loose.is_empty() {
        let schema = read_files(&loose, &overlay).map_err(|e| e.to_string())?;
        tables.extend(schema.tables);
        relationships.extend(schema.relationships);
        unresolved.extend(schema.unresolved);
    }

    tables.sort_by(|a, b| a.table_name.cmp(&b.table_name));
    let schema = wt_schema::Schema {
        tables,
        relationships,
        unresolved,
    };
    let json = serde_json::to_string_pretty(&schema).map_err(|e| e.to_string())?;

    match out_path {
        // A trailing newline, so the committed file is a well-formed text file
        // and re-running the reader produces no diff.
        Some(path) => std::fs::write(&path, format!("{json}\n"))
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?,
        None => println!("{json}"),
    }
    Ok(())
}
