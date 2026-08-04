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
     * recover-task-log-index <source> <target>: recover rows when the task
     * log's string primary index is torn but its project index and data pages
     * still read. The source is copied to scratch before any index is opened
     * for writing, and the target receives a brand-new task_log only.
     */
    if args.first().map(String::as_str) == Some("recover-task-log-index") {
        args.remove(0);
        let [source, target] = args.as_slice() else {
            eprintln!("usage: wt-migrate recover-task-log-index <source-store> <new-target-store>");
            return ExitCode::from(2);
        };
        let source = PathBuf::from(source);
        let target = PathBuf::from(target);
        if !source.join("task_log/.wt.data").is_file()
            || !source.join("task_log/project_idx.wt.idx").is_file()
        {
            eprintln!(
                "{} does not contain task_log data plus project_idx.wt.idx; nothing was touched",
                source.display()
            );
            return ExitCode::from(2);
        }
        if target.exists() {
            eprintln!(
                "{} already exists; recover into a new directory",
                target.display()
            );
            return ExitCode::from(2);
        }
        let _source_lock = match wt_migrate::lock_store(&source) {
            Ok(lock) => lock,
            Err(message) => {
                eprintln!("{message}");
                return ExitCode::FAILURE;
            }
        };
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_io()
            .enable_time()
            .build()
            .expect("runtime");
        return match runtime.block_on(wt_migrate::recover_task_log_index(&source, &target)) {
            Ok(report) => {
                println!(
                    "recovered {} task-log row(s) across {} project key(s) into {}",
                    report.rows,
                    report.projects,
                    target.display()
                );
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!(
                    "task-log recovery failed: {error:#}. The source was not modified; the target may be partial."
                );
                ExitCode::FAILURE
            }
        };
    }

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

        /*
         * Checked before anything opens, because this verb is the one that
         * writes into a store you already care about: it deletes every target
         * row that does not look like an item, on the reading that a garbled
         * row is worse than a missing one. That is right when the source
         * really holds the history, and catastrophic otherwise.
         *
         * A mistyped source used to be the worst case. Nothing checked it
         * existed, the read-write engine created the missing `project_item`
         * inside it, zero rows came back, and the target was then scrubbed
         * against nothing: rows whose ids did not match the convention were
         * deleted and the command printed `salvaged 0 row(s)` and exited 0.
         */
        if !source.join("project_item").is_dir() {
            eprintln!(
                "{source:?} has no project_item table, so there is nothing to salvage from it.\n\
                 Nothing was touched. Check the path: a store is the directory holding \
                 project_item, message and the rest."
            );
            return ExitCode::from(2);
        }
        if source == target || source.canonicalize().ok() == target.canonicalize().ok() {
            eprintln!("the source and the target are the same store; nothing to do.");
            return ExitCode::from(2);
        }

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

    /*
     * rebuild-store <source> <target>: every table, row by row, into a brand
     * new store. For when a table's page accounting is poisoned and the
     * poisoned table cannot be named with certainty: rows are carried
     * verbatim (the kv rows bring the fingerprint), accounting starts from
     * zero everywhere. Target must not exist; run against a snapshot or a
     * copy, never the live store.
     */
    if args.first().map(String::as_str) == Some("rebuild-store") {
        args.remove(0);
        let [source, target] = args.as_slice() else {
            eprintln!("usage: wt-migrate rebuild-store <source-store> <new-target-store>");
            return ExitCode::from(2);
        };
        let source = PathBuf::from(source);
        let target = PathBuf::from(target);
        if !source.join("kv").is_dir() {
            eprintln!("{source:?} has no kv table, so it is not a store. Nothing was touched.");
            return ExitCode::from(2);
        }
        if target.exists() {
            eprintln!(
                "{} already exists; rebuild into a new directory",
                target.display()
            );
            return ExitCode::from(2);
        }
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
        return match runtime.block_on(wt_migrate::rebuild_store(&source, &target)) {
            Ok(report) => {
                for (table, rows) in report {
                    println!("rebuilt {table}: {rows} row(s)");
                }
                println!("written to {}", target.display());
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!(
                    "rebuild failed: {error}. The target is partial; delete it and \
                     investigate before re-running."
                );
                ExitCode::FAILURE
            }
        };
    }

    /*
     * rebuild-task-log <source> <target>: read every task_log row out of the
     * source store and insert it into a brand-new task_log in the target
     * store. Not a migration — same shape both sides. The verb exists because
     * a table that ever refused an oversized insert carries inconsistent page
     * accounting that a file copy preserves; only a row-by-row rebuild sheds
     * it. Run it against a copy of the source: the scan opens it read-write.
     */
    if args.first().map(String::as_str) == Some("rebuild-task-log") {
        args.remove(0);
        let [source, target] = args.as_slice() else {
            eprintln!("usage: wt-migrate rebuild-task-log <source-store> <target-store>");
            return ExitCode::from(2);
        };
        let source = PathBuf::from(source);
        let target = PathBuf::from(target);
        if !source.join("task_log").is_dir() {
            eprintln!(
                "{source:?} has no task_log table, so there is nothing to rebuild from it. \
                 Nothing was touched."
            );
            return ExitCode::from(2);
        }
        if source == target || source.canonicalize().ok() == target.canonicalize().ok() {
            eprintln!("the source and the target are the same store; rebuild into another one.");
            return ExitCode::from(2);
        }
        // A fresh table is the entire point; a target that already has one is
        // either the wrong path or an old attempt that must be removed first.
        if target.join("task_log").exists() {
            eprintln!(
                "{target:?} already has a task_log; remove or rename it first. \
                 Rebuilding into existing accounting would keep the damage."
            );
            return ExitCode::from(2);
        }
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
        return match runtime.block_on(wt_migrate::rebuild_task_log(&source, &target)) {
            Ok((rebuilt, dropped)) => {
                println!("rebuilt {rebuilt} row(s), dropped {dropped} debris row(s)");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!(
                    "rebuild failed: {error}. The target's task_log may be partial; \
                     remove it and re-run."
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
            /*
             * The losses, said out loud and answered in the exit code.
             *
             * Both lists were built and then thrown away: a table the engine
             * could not carry, and the count of rows dropped as unreadable,
             * were constructed with their reasons and never printed. So a run
             * that recovered one row out of five hundred printed
             * `migrated: project_item`, `written to ...`, and exited 0. An
             * operator checking a migration before trusting it was shown the
             * good half only.
             */
            for (table, reason) in &report.failed {
                eprintln!("FAILED    {table}: {reason}");
            }
            for (table, rows) in &report.dropped {
                eprintln!("dropped   {table}: {rows} row(s) unreadable in either shape");
            }
            println!("written to {}", target.display());
            if report.failed.is_empty() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("migration failed: {error}");
            eprintln!("{} is unchanged", source.display());
            ExitCode::FAILURE
        }
    }
}
