//! The `wt-tools` binary: read-only queries over the GUI's store, one JSON
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
}

const USAGE: &str = "\
usage: wt-tools <command>

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
        "search-items" => {
            let query = args.next().ok_or("search-items needs a query")?.to_string();
            Command::SearchItems { query }
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
            eprintln!("wt-tools: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("wt-tools: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> eyre::Result<()> {
    let location = wt_tools::data_location()?;
    let dir = location.path;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        match command {
            Command::ListProjects => {
                let table = wt_tools::open_projects(&dir).await?;
                print_lines(&wt_tools::list_projects(&table)?)
            }
            Command::ListItems { project } => {
                let table = wt_tools::open_items(&dir).await?;
                print_lines(&wt_tools::list_items(&table, project.as_deref())?)
            }
            Command::SearchItems { query } => {
                let table = wt_tools::open_items(&dir).await?;
                print_lines(&wt_tools::search_items(&table, &query)?)
            }
            Command::ListRules { project } => {
                let table = wt_tools::open_rules(&dir).await?;
                print_lines(&wt_tools::list_rules(&table, project.as_deref())?)
            }
            Command::ListMessages { project, bodies } => {
                let table = wt_tools::open_messages(&dir).await?;
                print_lines(&wt_tools::list_messages(
                    &table,
                    project.as_deref(),
                    bodies,
                )?)
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
