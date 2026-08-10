//! Drive a repeatable interaction against a running AgencyZero and measure it.
//!
//! The point is to remove the human from the measurement. Hand-scrolling
//! produces numbers nobody can reproduce or compare; this sends a fixed number
//! of identical events at a fixed cadence and reports the frame window that
//! resulted.
//!
//! Two levels, as built into the bundle:
//!   `blitz.agent.control`  -> Inspect / Click / SetValue / ScrollIntoView / Key
//!   `blitz.diagnostics`    -> Observe / Snapshot / Metrics / WaitForIdle
//!
//! Requests are encoded from `blitz-control-protocol`, which is the server's
//! own definition of the wire. The previous client hand-wrote this JSON and got
//! the adjacent tagging of `AgentAction` wrong, which presented as a hung app.

use std::time::{Duration, Instant};

use blitz_control_protocol::{
    AgentAction, AgentControlRequest, AgentSnapshot, DebugResponse, DebugStream,
    DiagnosticsRequest, InputCommand, KeyPhase, Modifiers, RendererMetrics, SemanticNode,
    WheelPhase,
};
use eyre::{Result, bail};

mod inspector;
mod report;

use inspector::Client;

const USAGE: &str = "\
usage: blitz-bench <mode> [args]

  nodes                       tree size and a role histogram
  idle                        one metrics read, as a frame-window summary
  frames                      one metrics read, laid out for reading
  metrics                     the raw metrics response
  tree                        the semantic tree
  watch [seconds]             stream metrics/console/runtimeErrors (default 20)
  scroll [ticks] [delta]      paced wheel events, then metrics (default 120 -80)
  type [count] [name-substr]  drive real keystrokes into a text field (default 20)
  click <name-substring>      click the first matching visible, enabled node

env:
  TAURI_BLITZ_CONTROL_DESCRIPTOR  the descriptor to attach to
  BENCH_PACE                      inter-event delay in seconds, 0 saturates
";

/// Inter-event delay. **Leave it at 0 when measuring a ceiling.** At the 1/60
/// default the harness sets the cadence and the reported frame interval
/// describes the harness rather than the application: that mistake produced
/// "49fps" on a build that actually did 308fps.
fn pace() -> Duration {
    let seconds = std::env::var("BENCH_PACE")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(1.0 / 60.0);
    Duration::from_secs_f64(seconds.max(0.0))
}

async fn sleep_pace() {
    let pace = pace();
    if !pace.is_zero() {
        tokio::time::sleep(pace).await;
    }
}

async fn metrics(client: &mut Client) -> Result<RendererMetrics> {
    match client
        .diagnostics(&DiagnosticsRequest::Metrics)
        .await?
        .response
    {
        DebugResponse::Metrics(metrics) => Ok(metrics),
        other => bail!("asked for metrics, got {other:?}"),
    }
}

/// The whole tree. `max_depth` is snake_case inside the variant even though the
/// frame wrapper is camelCase, which is the trap the shared types remove.
async fn inspect(client: &mut Client) -> Result<(AgentSnapshot, f64)> {
    let started = Instant::now();
    let answer = client
        .agent(&AgentControlRequest::Inspect {
            root: None,
            max_depth: 40,
        })
        .await?;
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    match answer.response {
        DebugResponse::AgentSnapshot(snapshot) => Ok((snapshot, elapsed)),
        other => bail!("asked for a semantic snapshot, got {other:?}"),
    }
}

async fn nodes(client: &mut Client) -> Result<usize> {
    let (snapshot, elapsed) = inspect(client).await?;
    report::show_nodes(&snapshot.nodes, elapsed);
    Ok(snapshot.nodes.len())
}

/// A fixed scroll burst, paced like a trackpad rather than a firehose.
async fn scroll(client: &mut Client, ticks: usize, delta: f64) -> Result<()> {
    let mut latencies = Vec::with_capacity(ticks);
    for _ in 0..ticks {
        let started = Instant::now();
        client
            .agent(&AgentControlRequest::Act(AgentAction::Input(
                InputCommand::Wheel {
                    delta_x: 0.0,
                    delta_y: delta,
                    phase: WheelPhase::Moved,
                    modifiers: Modifiers::default(),
                },
            )))
            .await?;
        latencies.push(started.elapsed().as_secs_f64() * 1000.0);
        sleep_pace().await;
    }
    report::show_latencies("wheel events", ticks, &mut latencies);
    Ok(())
}

/// The first enabled, visible textbox whose name mentions `want`.
fn find_text_field<'a>(nodes: &'a [SemanticNode], want: &str) -> Option<&'a SemanticNode> {
    let fields: Vec<&SemanticNode> = nodes
        .iter()
        .filter(|node| {
            matches!(node.role.as_str(), "textbox" | "textarea" | "input")
                && node.enabled
                && node.visible
        })
        .collect();
    if !want.is_empty() {
        let wanted = want.to_lowercase();
        if let Some(named) = fields
            .iter()
            .find(|node| node.name.to_lowercase().contains(&wanted))
        {
            return Some(named);
        }
    }
    fields.first().copied()
}

/// Drive real key events into a focused text field and price them.
///
/// Typing is the interaction the composer autosizes on: it writes
/// `style.height`, reads `scrollHeight`, and writes it again, so every
/// keystroke forces a synchronous layout resolve. Scrolling never exercises
/// that path, which is why a scroll benchmark cannot stand in for this one.
async fn type_keys(client: &mut Client, count: usize, want: &str) -> Result<()> {
    let (snapshot, _) = inspect(client).await?;
    let Some(field) = find_text_field(&snapshot.nodes, want) else {
        bail!("no enabled, visible text field found; open a tab with a composer");
    };
    println!(
        "typing into node {} role={} name={}",
        field.id,
        field.role,
        report::py_repr(&field.name.chars().take(40).collect::<String>())
    );
    client
        .agent(&AgentControlRequest::Act(AgentAction::Click {
            node_id: field.id,
        }))
        .await?;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let before = metrics(client).await?;
    let mut latencies = Vec::with_capacity(count);
    for index in 0..count {
        let letter = (b'a' + (index % 26) as u8) as char;
        let started = Instant::now();
        for phase in [KeyPhase::Down, KeyPhase::Up] {
            client
                .agent(&AgentControlRequest::Act(AgentAction::Input(
                    InputCommand::Key {
                        phase,
                        key: letter.to_string(),
                        code: format!("Key{}", letter.to_ascii_uppercase()),
                        modifiers: Modifiers::default(),
                    },
                )))
                .await?;
        }
        latencies.push(started.elapsed().as_secs_f64() * 1000.0);
        sleep_pace().await;
    }
    let after = metrics(client).await?;

    report::show_latencies("keystrokes", count, &mut latencies);
    report::show("before", &before);
    report::show("after", &after);
    report::show_delta(&before, &after, count);
    Ok(())
}

/// Price a single click, such as switching to a tab.
///
/// A tab switch flips `display: none` to `flex` over that tab's whole subtree,
/// so taffy lays out in one pass everything the tab retained while hidden. That
/// is a different cost from typing and needs its own measurement.
async fn click_named(client: &mut Client, want: &str) -> Result<()> {
    let (snapshot, _) = inspect(client).await?;
    let wanted = want.to_lowercase();
    let Some(target) = snapshot
        .nodes
        .iter()
        .find(|node| node.name.to_lowercase().contains(&wanted) && node.visible && node.enabled)
    else {
        bail!(
            "no visible, enabled node whose name contains {}",
            report::py_repr(want)
        );
    };
    println!(
        "clicking node {} role={} name={}",
        target.id,
        target.role,
        report::py_repr(&target.name.chars().take(50).collect::<String>())
    );

    let before = metrics(client).await?;
    let started = Instant::now();
    client
        .agent(&AgentControlRequest::Act(AgentAction::Click {
            node_id: target.id,
        }))
        .await?;
    let ack = started.elapsed().as_secs_f64() * 1000.0;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = metrics(client).await?;

    println!("click acked in {ack:.1}ms");
    report::show("before", &before);
    report::show("after", &after);
    report::show_delta(&before, &after, 1);
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("idle");
    if matches!(mode, "-h" | "--help" | "help") {
        print!("{USAGE}");
        return Ok(());
    }

    let descriptor = inspector::discover(None)?;
    descriptor.warn_if_stale();

    // The dump modes announce what they attached to, because the answer to
    // "why is this number wrong" is usually "a different process".
    let verbose = matches!(mode, "metrics" | "watch" | "frames" | "tree");
    if verbose {
        println!("descriptor: {}", descriptor.path.display());
        println!("{}", report::dump(&descriptor.raw, usize::MAX));
    }

    let mut client = Client::connect(&descriptor.socket_path()).await?;
    let initialize = client.initialize().await?;
    if verbose {
        println!("\n== initialize ==");
        println!("{}", report::dump(&initialize, 800));
        println!("\n== tools ==");
        let tools = client.tools_list().await?;
        println!("{}", report::dump(&tools, 1200));
    }

    match mode {
        "metrics" => {
            println!("\n== metrics ==");
            let answer = client.diagnostics(&DiagnosticsRequest::Metrics).await?;
            println!("{}", report::dump(&answer.envelope, 2000));
        }
        "watch" => {
            let seconds: f64 = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(20.0);
            println!("\n== observing metrics/console/runtimeErrors for {seconds}s ==");
            // Tolerates a protocol error on purpose: the server answers
            // `streamingUnavailable` because `observe` is not implemented, and
            // reporting that is more useful than exiting on it.
            let answer = client
                .diagnostics_envelope(&DiagnosticsRequest::Observe {
                    streams: vec![
                        DebugStream::Metrics,
                        DebugStream::Console,
                        DebugStream::RuntimeErrors,
                    ],
                })
                .await?;
            println!("{}", report::dump(&answer, 400));
            for message in client.drain(seconds).await? {
                println!("{}", report::dump(&message, 400));
            }
        }
        "frames" => report::show_frames(&metrics(&mut client).await?),
        "tree" => {
            println!("\n== semantic tree ==");
            // The Python sent `maxDepth` here, which the server rejects: fields
            // inside protocol variants are snake_case. Encoding from the shared
            // type is what makes that unrepresentable rather than a silent
            // error nobody read.
            let answer = client
                .agent(&AgentControlRequest::Inspect {
                    root: None,
                    max_depth: 3,
                })
                .await?;
            println!("{}", report::dump(&answer.envelope, 3000));
        }
        "nodes" => {
            nodes(&mut client).await?;
        }
        "idle" => report::show("idle", &metrics(&mut client).await?),
        "click" => {
            let want = args.get(1).map(String::as_str).unwrap_or("Settings");
            nodes(&mut client).await?;
            click_named(&mut client, want).await?;
        }
        "type" => {
            let count: usize = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(20);
            let want = args.get(2).map(String::as_str).unwrap_or("");
            nodes(&mut client).await?;
            type_keys(&mut client, count, want).await?;
        }
        "scroll" => {
            let ticks: usize = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(120);
            let delta: f64 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(-80.0);
            let count = nodes(&mut client).await?;
            report::show("before", &metrics(&mut client).await?);
            scroll(&mut client, ticks, delta).await?;
            report::show("after", &metrics(&mut client).await?);
            println!("tree size during run: {count} nodes");
        }
        other => {
            eprintln!("unknown mode {other}\n");
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    }
    Ok(())
}
