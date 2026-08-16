//! The `agency-tools` binary: read-only queries over the GUI's store, one JSON
//! object per line on stdout, errors on stderr with a nonzero exit.
//!
//! Arguments are parsed by hand. Three subcommands and one flag do not earn a
//! parser dependency, and every crate in this workspace that could avoid a
//! heavy dependency has.

use std::process::ExitCode;

/// What the argument list asked for.
#[derive(Debug, PartialEq, Eq)]
enum Command {
    ListProjects,
    ListItems {
        project: Option<String>,
    },
    SearchItems {
        query: String,
    },
    ListRules {
        project: Option<String>,
    },
    ListMessages {
        project: Option<String>,
        bodies: bool,
    },
    ListSessions {
        project: Option<String>,
    },
    AuditSessions {
        project: Option<String>,
    },
    Usage {
        project: Option<String>,
    },
    PsUsageReport {
        blinded: bool,
        start: Option<String>,
        end: Option<String>,
    },
}

const USAGE: &str = "\
usage: agency-tools <command>

Read-only queries over the agencyzero GUI's WorkTable store.
Prints one JSON object per line. Never writes to the store; safe to run
while the GUI is open. A store that does not exist yet reads as empty.

commands:
  list-projects              every project, ordered by position
  list-items [--project ID]  items, optionally narrowed to one project
  search-items <QUERY>       items whose title contains QUERY (case-insensitive)
  list-rules [--project ID]  remembered approvals (\"always allow similar\" grants)
  list-messages [--project ID] [--bodies]
                             one row per message, oldest first, with the usage
                             the turn reported
  list-sessions [--project ID]
                             provider-session ownership, including empty resets
  audit-sessions [--project ID]
                             current pointers missing from db.snapshot-1/2,
                             with project names and exact recovery candidates
  usage [--project ID]       token/cost rollup: whole-store totals, the single
                             largest turn, and per-model / per-day breakdowns
  ps-usage-report [--blinded] [--start RFC3339] [--end RFC3339]
                             directive-usage statistics over a closed window:
                             incidence, per-surface and per-verb counts,
                             outcomes and per-day activity. Prints a table on
                             stdout and the same numbers as JSON on the last
                             line. --blinded substitutes every verb through a
                             fixed mapping and drops identifying strings.
                             The window has no default and must be given.

The store location honours the same overrides as the GUI: $AZ_DATA_DIR,
then the data-location.json pointer next to the app's config, then the
platform app-data directory.";

fn parse_args(args: &[String]) -> Result<Command, String> {
    let mut args = args.iter();
    let command = args.next().ok_or("missing command")?;
    /// The shared `[--project ID]` tail, for the commands that narrow.
    fn project_filter<'a>(
        mut args: impl Iterator<Item = &'a String>,
    ) -> Result<Option<String>, String> {
        let mut project = None;
        while let Some(flag) = args.next() {
            match (flag.as_str(), flag.strip_prefix("--project=")) {
                ("--project", _) => {
                    project = Some(
                        args.next()
                            .ok_or("--project needs a project id")?
                            .to_string(),
                    );
                }
                (_, Some(value)) => project = Some(value.to_string()),
                _ => return Err(format!("unexpected argument: {flag}")),
            }
        }
        Ok(project)
    }

    let command = match command.as_str() {
        "list-projects" => Command::ListProjects,
        "list-items" => {
            return Ok(Command::ListItems {
                project: project_filter(args)?,
            });
        }
        "list-rules" => {
            return Ok(Command::ListRules {
                project: project_filter(args)?,
            });
        }
        "list-messages" => {
            // `--bodies` may sit on either side of `--project`, so it is pulled
            // out before the project filter reads what is left.
            let rest: Vec<String> = args.map(ToString::to_string).collect();
            let bodies = rest.iter().any(|arg| arg == "--bodies");
            let kept: Vec<String> = rest.into_iter().filter(|arg| arg != "--bodies").collect();
            return Ok(Command::ListMessages {
                project: project_filter(&mut kept.iter())?,
                bodies,
            });
        }
        "list-sessions" => {
            return Ok(Command::ListSessions {
                project: project_filter(args)?,
            });
        }
        "audit-sessions" => {
            return Ok(Command::AuditSessions {
                project: project_filter(args)?,
            });
        }
        "search-items" => {
            let query = args.next().ok_or("search-items needs a query")?.to_string();
            Command::SearchItems { query }
        }
        "ps-usage-report" => {
            let mut blinded = false;
            let mut start = None;
            let mut end = None;
            while let Some(flag) = args.next() {
                match flag.as_str() {
                    "--blinded" => blinded = true,
                    "--start" => {
                        start = Some(args.next().ok_or("--start needs a value")?.to_string());
                    }
                    "--end" => {
                        end = Some(args.next().ok_or("--end needs a value")?.to_string());
                    }
                    other => return Err(format!("unexpected argument: {other}")),
                }
            }
            return Ok(Command::PsUsageReport {
                blinded,
                start,
                end,
            });
        }
        "usage" => {
            return Ok(Command::Usage {
                project: project_filter(args)?,
            });
        }
        "-h" | "--help" | "help" => return Err(String::new()),
        other => return Err(format!("unknown command: {other}")),
    };
    if let Some(extra) = args.next() {
        return Err(format!("unexpected argument: {extra}"));
    }
    Ok(command)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse_args(&args) {
        Ok(command) => command,
        Err(message) => {
            // An empty message is `--help`: usage on stdout, success. Anything
            // else is a real mistake: complaint plus usage on stderr, exit 2 so
            // a caller can tell "you asked wrong" from "the store failed".
            if message.is_empty() {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            eprintln!("agency-tools: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("agency-tools: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> eyre::Result<()> {
    let location = agency_tools::data_location()?;
    let dir = location.path;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        match command {
            Command::ListProjects => {
                let table = agency_tools::open_projects(&dir).await?;
                print_lines(&agency_tools::list_projects(&table)?)
            }
            Command::ListItems { project } => {
                let table = agency_tools::open_items(&dir).await?;
                let kv = agency_tools::open_kv(&dir).await?;
                print_lines(&agency_tools::list_items_with_descriptions(
                    &table,
                    &kv,
                    project.as_deref(),
                )?)
            }
            Command::SearchItems { query } => {
                let table = agency_tools::open_items(&dir).await?;
                print_lines(&agency_tools::search_items(&table, &query)?)
            }
            Command::ListRules { project } => {
                let table = agency_tools::open_rules(&dir).await?;
                print_lines(&agency_tools::list_rules(&table, project.as_deref())?)
            }
            Command::ListMessages { project, bodies } => {
                let table = agency_tools::open_messages(&dir).await?;
                print_lines(&agency_tools::list_messages(
                    &table,
                    project.as_deref(),
                    bodies,
                )?)
            }
            Command::ListSessions { project } => {
                let kv = agency_tools::open_kv(&dir).await?;
                print_lines(&agency_tools::list_sessions(&kv, project.as_deref())?)
            }
            Command::AuditSessions { project } => {
                let projects = agency_tools::open_projects(&dir).await?;
                let current = agency_tools::open_kv(&dir).await?;
                let current = agency_tools::list_sessions(&current, project.as_deref())?;
                let name = dir
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("db");
                let mut snapshots = Vec::new();
                for suffix in ["snapshot-1", "snapshot-2"] {
                    let path = dir.with_file_name(format!("{name}.{suffix}"));
                    let table = agency_tools::open_kv(&path).await?;
                    snapshots.push((
                        suffix.to_string(),
                        agency_tools::list_sessions(&table, None)?,
                    ));
                }
                print_lines(&agency_tools::session_recovery_report(
                    &projects,
                    &current,
                    &snapshots,
                    project.as_deref(),
                )?)
            }
            Command::Usage { project } => {
                let ledger = agency_tools::open_usage(&dir).await?;
                let cache = agency_tools::open_usage_cache(&dir).await?;
                let summary = agency_tools::usage_summary(&cache, &ledger, project.as_deref())?;
                println!("{}", serde_json::to_string_pretty(&summary)?);
                Ok(())
            }
            Command::PsUsageReport {
                blinded,
                start,
                end,
            } => {
                use agency_tools::ps_usage;
                use worktable::prelude::SelectQueryExecutor;

                // A flag beats editing the constants for a one-off window, but
                // the constants stay the declared default so an unset window is
                // still a refusal rather than a silent choice.
                let start = start.unwrap_or_else(|| ps_usage::WINDOW_START.to_owned());
                let end = end.unwrap_or_else(|| ps_usage::WINDOW_END.to_owned());

                let table = agency_tools::open_study_events(&dir).await?;
                let rows = table.select_all().execute()?;
                let report = ps_usage::build(&rows, &start, &end)?;
                let report = if blinded {
                    ps_usage::blind(&report)
                } else {
                    report
                };
                print!("{}", ps_usage::render(&report));
                println!("{}", serde_json::to_string(&report)?);
                Ok(())
            }
        }
    })
}

fn print_lines<T: serde::Serialize>(rows: &[T]) -> eyre::Result<()> {
    for row in rows {
        println!("{}", serde_json::to_string(row)?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Command, parse_args};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn parses_each_command() {
        assert_eq!(
            parse_args(&args(&["list-projects"])),
            Ok(Command::ListProjects)
        );
        assert_eq!(
            parse_args(&args(&["list-items"])),
            Ok(Command::ListItems { project: None })
        );
        assert_eq!(
            parse_args(&args(&["list-items", "--project", "proj-1"])),
            Ok(Command::ListItems {
                project: Some("proj-1".into())
            })
        );
        assert_eq!(
            parse_args(&args(&["list-items", "--project=proj-1"])),
            Ok(Command::ListItems {
                project: Some("proj-1".into())
            })
        );
        assert_eq!(
            parse_args(&args(&["search-items", "deploy"])),
            Ok(Command::SearchItems {
                query: "deploy".into()
            })
        );
        assert_eq!(
            parse_args(&args(&["list-rules"])),
            Ok(Command::ListRules { project: None })
        );
        assert_eq!(
            parse_args(&args(&["list-rules", "--project=proj-1"])),
            Ok(Command::ListRules {
                project: Some("proj-1".into())
            })
        );
        assert_eq!(
            parse_args(&args(&["list-sessions", "--project", "proj-1"])),
            Ok(Command::ListSessions {
                project: Some("proj-1".into())
            })
        );
        assert_eq!(
            parse_args(&args(&["audit-sessions", "--project", "proj-1"])),
            Ok(Command::AuditSessions {
                project: Some("proj-1".into())
            })
        );
    }

    #[test]
    fn rejects_bad_invocations() {
        assert!(parse_args(&[]).is_err());
        assert!(parse_args(&args(&["frobnicate"])).is_err());
        assert!(parse_args(&args(&["search-items"])).is_err());
        assert!(parse_args(&args(&["list-items", "--project"])).is_err());
        assert!(parse_args(&args(&["list-projects", "extra"])).is_err());
    }
}
