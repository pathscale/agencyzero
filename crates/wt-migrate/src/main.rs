//! Carry a store forward, out of band.
//!
//! The GUI runs the same migration at boot, before its window exists. This
//! binary is for doing it by hand: against a copy, before an upgrade, or to
//! inspect the result before letting anything open it.
//!
//! ```text
//! wt-migrate <source> <target>
//! ```
//!
//! `source` is only read. Nothing is deleted and nothing is swapped in: if the
//! result looks right, the caller moves it into place.

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();

    /*
     * salvage-items <source> <existing-target>: read a mixed-shape
     * project_item through both schema generations, keep every row that reads
     * sane in either, and insert the ones the target does not already have.
     * The repair verb for a table the engine's all-or-nothing pass cannot
     * carry. Unlike a full migration the target here is an existing store,
     * which is the point: history flows into the store you kept.
     */
    if args.first().map(String::as_str) == Some("salvage-items") {
        args.remove(0);
        let [source, target] = args.as_slice() else {
            eprintln!("usage: wt-migrate salvage-items <source-store> <existing-target-store>");
            return ExitCode::from(2);
        };
        let source = PathBuf::from(source);
        let target = PathBuf::from(target);
        let (_s, _t) = match (
            wt_migrate::lock_store(&source),
            wt_migrate::lock_store(&target),
        ) {
            (Ok(s), Ok(t)) => (s, t),
            (Err(m), _) | (_, Err(m)) => {
                eprintln!("{m}");
                return ExitCode::FAILURE;
            }
        };
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_io()
            .enable_time()
            .build()
            .expect("runtime");
        return match runtime.block_on(wt_migrate::salvage_items(&source, &target)) {
            Ok((salvaged, skipped, unreadable)) => {
                println!(
                    "salvaged {salvaged} row(s), {skipped} already present, {unreadable} unreadable in both shapes"
                );
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!(
                    "salvage failed: {error}. The target may hold a partial salvage; re-run after fixing the cause, inserts are by id and idempotent."
                );
                ExitCode::FAILURE
            }
        };
    }

    let [source, target] = args.as_slice() else {
        eprintln!("usage: wt-migrate <source-store> <target-store>");
        eprintln!();
        eprintln!("Reads <source-store>, writes a migrated copy to <target-store>.");
        eprintln!("The source is never modified.");
        return ExitCode::from(2);
    };

    let source = PathBuf::from(source);
    let target = PathBuf::from(target);
    if !source.exists() {
        eprintln!("no store at {}", source.display());
        return ExitCode::FAILURE;
    }
    if source == target {
        eprintln!("source and target are the same directory; migrate into a new one");
        return ExitCode::FAILURE;
    }
    if target.exists() {
        // Refused rather than merged into: a half-populated target that
        // already held rows is the one state nobody could reason about after.
        eprintln!(
            "{} already exists; migrate into a new directory",
            target.display()
        );
        return ExitCode::FAILURE;
    }
    /*
     * The single-writer rule, mechanically. The live store was once corrupted
     * by exactly this: a migration writing files a running GUI already had
     * open. Both directions matter — reading a store mid-write copies torn
     * pages, and two writers on the target is the same disease. The locks are
     * held for the whole run by staying in scope.
     */
    let _source_lock = match wt_migrate::lock_store(&source) {
        Ok(lock) => lock,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let _target_lock = match wt_migrate::lock_store(&target) {
        Ok(lock) => lock,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };

    /*
     * The fingerprint the source was written with, read from its own kv table.
     * Without it there is no way to tell which tables changed, and guessing is
     * how rows get read through the wrong layout in the first place.
     */
    let stored = match std::fs::read_to_string(source.join("schema-fingerprint.txt")) {
        Ok(text) => text.trim().to_string(),
        Err(_) => {
            eprintln!("no schema-fingerprint.txt beside the source store.");
            eprintln!("The app writes one when it carries a store forward; for a hand run,");
            eprintln!("put the fingerprint the source was written with in that file.");
            return ExitCode::FAILURE;
        }
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_io()
        .enable_time()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("could not start a runtime: {error}");
            return ExitCode::FAILURE;
        }
    };

    match runtime.block_on(wt_migrate::carry_forward(
        &source,
        &target,
        &stored,
        wt_migrate::CURRENT_FINGERPRINT,
    )) {
        Ok(report) => {
            println!("migrated: {}", report.migrated.join(", "));
            println!("copied:   {}", report.copied.join(", "));
            if !report.reset.is_empty() {
                println!("reset:    {}", report.reset.join(", "));
            }
            println!("written to {}", target.display());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("migration failed: {error}");
            eprintln!("{} is unchanged", source.display());
            ExitCode::FAILURE
        }
    }
}
