//! Output formatting.
//!
//! Every line here is load-bearing: `docs/performance.md` quotes these numbers,
//! and two runs of this tool are meant to be diffed against each other
//! directly. Widths and field order match the Python this replaced, so a
//! measurement taken before the port is still comparable with one taken after.

use std::collections::HashMap;

use blitz_control_protocol::{RendererMetrics, ScriptSource, SemanticNode, TimingStats};
use serde::Serialize;

/// The five frame series, in the order every reader has learned to expect.
const SERIES: [&str; 5] = ["resolve", "scene", "renderer", "total", "interval"];

fn series_of(
    window: &blitz_control_protocol::FrameWindowMetrics,
) -> [(&'static str, TimingStats); 5] {
    [
        (SERIES[0], window.resolve),
        (SERIES[1], window.scene),
        (SERIES[2], window.renderer),
        (SERIES[3], window.total),
        (SERIES[4], window.interval),
    ]
}

/// Python's `repr()` for a `str`, so quoted names in the output keep the shape
/// the previous tool produced.
pub fn py_repr(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    let quote = if text.contains('\'') && !text.contains('"') {
        '"'
    } else {
        '\''
    };
    out.push(quote);
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// Python prints `1.0` where Rust's `Display` prints `1`. The dump lines carry
/// raw values rather than fixed precision, so keep them recognisable.
pub fn py_float(value: f64) -> String {
    let text = value.to_string();
    if text.contains(['.', 'e', 'N', 'i']) {
        text
    } else {
        format!("{text}.0")
    }
}

pub fn py_opt_float(value: Option<f64>) -> String {
    value.map(py_float).unwrap_or_else(|| "None".into())
}

pub fn py_opt_u64(value: Option<u64>) -> String {
    value
        .map(|v| v.to_string())
        .unwrap_or_else(|| "None".into())
}

/// Characters, not bytes: the Python sliced `label[:34]`, and a byte slice
/// would panic partway through a multi-byte accessible name.
fn clip(text: &str, width: usize) -> String {
    text.chars().take(width).collect()
}

/// `json.dumps(value, indent=1)[:limit]`.
///
/// One-space indent and insertion order both matter: these dumps get diffed
/// against earlier captures, and re-indenting or alphabetising the keys would
/// make every historical comparison noise.
pub fn dump(value: &serde_json::Value, limit: usize) -> String {
    let mut buffer = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut buffer, formatter);
    value
        .serialize(&mut serializer)
        .expect("a parsed JSON value re-serializes");
    String::from_utf8(buffer)
        .expect("serde_json emits UTF-8")
        .chars()
        .take(limit)
        .collect()
}

/// The one-shot summary printed by `idle`, and before and after a driven run.
pub fn show(label: &str, metrics: &RendererMetrics) {
    let Some(window) = &metrics.frame_window else {
        println!("{label}: no frames in window");
        return;
    };
    println!(
        "{label}: fps={:.1} missed={}/{} frames={}",
        window.active_fps, window.missed_refreshes, window.window_frames, window.frames_total
    );
    if let Some(script) = &metrics.script {
        println!(
            "    {:<9} mean={:>7.2} p95={:>7.2} max={:>8.2}  (ran {}/{} polls, {:.0}ms total)",
            "script",
            script.mean_ms,
            script.p95_ms,
            script.max_ms,
            script.productive_polls,
            script.total_polls,
            script.spent_ms
        );
        for source in script.breakdown.iter().take(8) {
            println!(
                "        {:<34} calls={:>5} total={:>8.1}ms  worst={:>7.1}ms",
                clip(&source.label, 34),
                source.calls,
                source.total_ms,
                source.worst_ms
            );
        }
    }
    for (name, stats) in series_of(window) {
        println!(
            "    {:<9} mean={:>7.2} p95={:>7.2} max={:>8.2}",
            name, stats.mean_ms, stats.p95_ms, stats.max_ms
        );
    }
}

/// The `frames` dump: the same window, laid out for reading rather than diffing.
pub fn show_frames(metrics: &RendererMetrics) {
    match &metrics.frame_window {
        None => println!("no frame window yet: the app has not presented frames since launch"),
        Some(window) => {
            println!(
                "frames={} window={} activeFps={} missedRefreshes={} refreshHz={}",
                window.frames_total,
                window.window_frames,
                py_float(window.active_fps),
                window.missed_refreshes,
                py_opt_float(window.display_refresh_hz)
            );
            for (name, stats) in series_of(window) {
                println!(
                    "  {:<9} mean={:>8.2}  p95={:>8.2}  max={:>8.2}",
                    name, stats.mean_ms, stats.p95_ms, stats.max_ms
                );
            }
        }
    }
    if let Some(frame) = &metrics.frame {
        println!(
            "latest frame: resolve={} scene={} renderer={} total={} age={}ms",
            py_float(frame.resolve_ms),
            py_float(frame.scene_ms),
            py_float(frame.renderer_ms),
            py_float(frame.total_ms),
            py_float(frame.age_ms)
        );
    }
    if let Some(cost) = &metrics.snapshot {
        // Reported at all because reading metrics perturbs the app: this is the
        // observer's cost, and folding it into the app's would be the exact
        // mistake the original instrumentation made for a year.
        println!(
            "observer cost (not the app): {}",
            serde_json::json!({
                "pollMs": cost.poll_ms,
                "resolveMs": cost.resolve_ms,
                "totalMs": cost.total_ms,
            })
        );
    }
    println!("residentBytes={}", py_opt_u64(metrics.resident_bytes));
}

/// Tree size and a role histogram: the input to every layout cost.
pub fn show_nodes(nodes: &[SemanticNode], inspect_ms: f64) {
    let mut counts: Vec<(String, u64)> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for node in nodes {
        match index.get(node.role.as_str()) {
            Some(&at) => counts[at].1 += 1,
            None => {
                index.insert(node.role.as_str(), counts.len());
                counts.push((node.role.clone(), 1));
            }
        }
    }
    // Stable sort on count alone, so ties keep first-seen order exactly as the
    // Python's stable sort did.
    counts.sort_by(|left, right| right.1.cmp(&left.1));
    let top: Vec<String> = counts
        .iter()
        .take(8)
        .map(|(role, count)| format!("{role}={count}"))
        .collect();
    println!("nodes={} inspect_ms={:.1}", nodes.len(), inspect_ms);
    println!("  {}", top.join("  "));
}

/// Ack latency for a burst of driven events.
pub fn show_latencies(what: &str, count: usize, latencies: &mut Vec<f64>) {
    latencies.sort_by(|a, b| a.partial_cmp(b).expect("latencies are finite"));
    let mean = latencies.iter().sum::<f64>() / latencies.len() as f64;
    // Index as the Python did, including its off-by-one, so the reported p95
    // means the same thing across the port.
    let p95_index = ((latencies.len() as f64 * 0.95) as usize).saturating_sub(1);
    println!(
        "drove {count} {what}: ack mean={:.2}ms p95={:.2}ms max={:.2}ms",
        mean,
        latencies[p95_index],
        latencies.last().copied().unwrap_or_default()
    );
}

fn breakdown_of(metrics: &RendererMetrics) -> HashMap<&str, &ScriptSource> {
    metrics
        .script
        .as_ref()
        .map(|script| {
            script
                .breakdown
                .iter()
                .map(|source| (source.label.as_str(), source))
                .collect()
        })
        .unwrap_or_default()
}

/// What this run cost, per source.
///
/// `script.breakdown` is cumulative since launch, so the totals include startup
/// and every interaction before this one. Only the delta describes the
/// interaction: without it the first typing measurement read 198 ms when the
/// truth was 22 ms, and the rest belonged to earlier shortcuts.
pub fn show_delta(before: &RendererMetrics, after: &RendererMetrics, events: usize) {
    let start = breakdown_of(before);
    let end = breakdown_of(after);

    let mut rows: Vec<(f64, &str, i64, f64)> = Vec::new();
    for (label, source) in &end {
        let (previous_calls, previous_total) = start
            .get(label)
            .map(|prior| (prior.calls, prior.total_ms))
            .unwrap_or((0, 0.0));
        let delta_calls = source.calls as i64 - previous_calls as i64;
        let delta_total = source.total_ms - previous_total;
        if delta_calls != 0 || delta_total > 0.01 {
            // `worst` stays cumulative on purpose: it is the worst single call
            // ever seen for that source, and a delta of a maximum is not a
            // maximum of anything.
            rows.push((delta_total, label, delta_calls, source.worst_ms));
        }
    }
    rows.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .expect("script totals are finite")
            .then_with(|| right.1.cmp(left.1))
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| {
                right
                    .3
                    .partial_cmp(&left.3)
                    .expect("script worst cases are finite")
            })
    });

    println!("\ncost of this run ({events} events):");
    if rows.is_empty() {
        println!("    nothing attributed: did the interaction reach the app?");
        return;
    }
    for (total, label, calls, worst) in rows {
        let per_event = if events > 0 {
            format!("{:>8.2}", total / events as f64)
        } else {
            "       -".to_string()
        };
        // Reading metrics polls the script loop, so poll_hook in a delta is the
        // observer measuring itself. Kept in the output rather than filtered
        // out, because a reader who does not see it will look for it.
        let note = if label == "poll_hook" {
            "   <- observer"
        } else {
            ""
        };
        println!(
            "    {:<34} calls={:>6} total={:>9.2}ms per_event={per_event}ms worst={:>7.2}ms{note}",
            clip(label, 34),
            calls,
            total,
            worst
        );
    }
}
