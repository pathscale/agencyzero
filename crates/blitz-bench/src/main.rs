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

use std::collections::HashMap;
use std::time::{Duration, Instant};

use blitz_control_protocol::{
    AgentAction, AgentControlRequest, AgentSnapshot, DebugResponse, DebugStream,
    DiagnosticsRequest, InputCommand, KeyPhase, Modifiers, PointerPhase, RendererMetrics,
    SemanticNode, SnapshotRequest, WheelPhase,
};
use eyre::{Result, bail};

mod inspector;
mod report;

use inspector::Client;

const USAGE: &str = "\
usage: blitz-bench <mode> [args]

  nodes                       tree size and a role histogram
  panes                       node count per retained pane, and what
                              retention costs against the whole tree
  idle                        one metrics read, as a frame-window summary
  blink [allowed-missed]      assert the owner's blinking-rectangle repro: no
                              missed refreshes and no frame interval past two
                              refresh periods. Exits 1 when the blink is present
  ghost [min-area]            hidden nodes that still own a painted box, worst
                              first. Exits 1 when any is found (default 64px2)
  drift [seconds]             what the app does while nothing happens (default 20)
  frames                      one metrics read, laid out for reading
  metrics                     the raw metrics response
  tree                        the semantic tree
  layout [name-substr]        live boxes: x, y, w, h per named node
  dom <substr> [depth]        matching nodes with their attributes, plus the
                              ancestor chain, so a spill can be read against the
                              container that was meant to clip it (default 6)
  transcript                  transcript scroll state and lowest DOM descendants
  spill [h|v] [tolerance]     boxes that stick out of their container, worst first
  watch [seconds]             stream metrics/console/runtimeErrors (default 20)
  scroll [ticks] [delta] [over]  wheel events over a named node (default 120 -80 Conversation)
  drag [name-substr] [dy] [n]    scroll a named node's container directly, n times
  type [count] [name-substr]  drive real keystrokes into a text field (default 20)
  key <name> [count] [over]   pageup/pagedown/home/end/up/down/left/right/tab into a
                              named scroller, or into a bare node id
  reveal <name-substr>        scroll a named node into view, reporting its y before/after
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
/// Print the live box of every named node, optionally filtered by name.
///
/// The reason this exists: a layout complaint that cannot be reproduced from
/// the markup is answered by the boxes the running app actually computed, not
/// by another screenshot. `include_layout` has been in the diagnostics snapshot
/// all along; nothing exposed it.
async fn layout(client: &mut Client, want: &str) -> Result<()> {
    let answer = client
        .diagnostics(&DiagnosticsRequest::Snapshot(SnapshotRequest {
            include_dom: true,
            include_layout: true,
            include_computed_style: false,
        }))
        .await?;
    let DebugResponse::Snapshot(snapshot) = answer.response else {
        bail!("asked for a layout snapshot, got {:?}", answer.response);
    };
    let bounds: HashMap<u64, serde_json::Value> = snapshot
        .layout
        .as_ref()
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let id = row.get("nodeId")?.as_u64()?;
                    Some((id, row.get("bounds")?.clone()))
                })
                .collect()
        })
        .unwrap_or_default();

    let nodes = snapshot
        .dom
        .as_ref()
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let mut shown = 0usize;
    for node in &nodes {
        let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let role = node.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if !want.is_empty() && !name.contains(want) && !role.contains(want) {
            continue;
        }
        let Some(id) = node.get("id").and_then(|v| v.as_u64()) else {
            continue;
        };
        let Some(box_) = bounds.get(&id) else {
            continue;
        };
        // `bounds` arrives as `[x, y, width, height]`. Reading it as an object
        // with named keys returned `None` for every one of them, and the
        // fallback was `f64::NAN`, so this printed four NaNs per row for every
        // node and never said why: a silently broken instrument, which is the
        // one thing a measurement tool must not be. Both shapes are accepted
        // now, so a protocol that grows named fields does not break it again.
        let read = |key: &str, index: usize| {
            box_.get(key)
                .or_else(|| box_.get(index))
                .and_then(|v| v.as_f64())
                .unwrap_or(f64::NAN)
        };
        let row = snapshot
            .layout
            .as_ref()
            .and_then(|value| value.as_array())
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row.get("nodeId").and_then(|value| value.as_u64()) == Some(id))
            });
        let pair = |field: &str, index: usize| {
            row.and_then(|row| row.get(field))
                .and_then(|value| value.get(index))
                .and_then(|value| value.as_f64())
                .unwrap_or(f64::NAN)
        };
        println!(
            "{:>6}  {:<16} {:>8.1} {:>8.1} {:>8.1} {:>8.1}  scroll={:.1},{:.1} range={:.1},{:.1} client={:.1},{:.1} content={:.1},{:.1}  {}",
            id,
            role,
            read("x", 0),
            read("y", 1),
            read("width", 2),
            read("height", 3),
            pair("scrollOffset", 0),
            pair("scrollOffset", 1),
            pair("scrollRange", 0),
            pair("scrollRange", 1),
            pair("clientSize", 0),
            pair("clientSize", 1),
            pair("scrollSize", 0),
            pair("scrollSize", 1),
            name.chars().take(60).collect::<String>()
        );
        shown += 1;
    }
    if shown == 0 {
        println!(
            "no named node matched {want:?} ({} in the tree)",
            nodes.len()
        );
    }
    Ok(())
}

/// The scroll state and bottom-most descendants of the visible transcript.
///
/// A screenshot can show that a reply is clipped, but cannot distinguish the
/// scroller being short of max from a child being laid out below the clip. This
/// walks the actual DOM parent chain and reports both in one read-only sample.
async fn transcript(client: &mut Client) -> Result<()> {
    let answer = client
        .diagnostics(&DiagnosticsRequest::Snapshot(SnapshotRequest {
            include_dom: true,
            include_layout: true,
            include_computed_style: false,
        }))
        .await?;
    let DebugResponse::Snapshot(snapshot) = answer.response else {
        bail!("asked for a transcript snapshot, got {:?}", answer.response);
    };
    let nodes = snapshot
        .dom
        .as_ref()
        .and_then(|value| value.as_array())
        .ok_or_else(|| eyre::eyre!("snapshot omitted DOM rows"))?;
    let rows = snapshot
        .layout
        .as_ref()
        .and_then(|value| value.as_array())
        .ok_or_else(|| eyre::eyre!("snapshot omitted layout rows"))?;
    let conversation = nodes
        .iter()
        .find(|node| node.get("name").and_then(|value| value.as_str()) == Some("Conversation"))
        .and_then(|node| node.get("id").and_then(|value| value.as_u64()))
        .ok_or_else(|| eyre::eyre!("no Conversation node"))?;
    let parent: HashMap<u64, Option<u64>> = nodes
        .iter()
        .filter_map(|node| {
            Some((
                node.get("id")?.as_u64()?,
                node.get("parent").and_then(|value| value.as_u64()),
            ))
        })
        .collect();
    let named: HashMap<u64, (&str, &str)> = nodes
        .iter()
        .filter_map(|node| {
            Some((
                node.get("id")?.as_u64()?,
                (
                    node.get("role")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                    node.get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
            ))
        })
        .collect();
    let layout: HashMap<u64, &serde_json::Value> = rows
        .iter()
        .filter_map(|row| Some((row.get("nodeId")?.as_u64()?, row)))
        .collect();
    let conversation_row = layout
        .get(&conversation)
        .ok_or_else(|| eyre::eyre!("Conversation has no layout row"))?;
    let pair = |row: &serde_json::Value, field: &str, index: usize| {
        row.get(field)
            .and_then(|value| value.get(index))
            .and_then(|value| value.as_f64())
            .unwrap_or(f64::NAN)
    };
    let bounds = conversation_row
        .get("bounds")
        .ok_or_else(|| eyre::eyre!("Conversation has no bounds"))?;
    let viewport_bottom = bounds.get(1).and_then(|v| v.as_f64()).unwrap_or(f64::NAN)
        + bounds.get(3).and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
    println!(
        "Conversation id={conversation} top={:.1} bottom={viewport_bottom:.1} scrollTop={:.1} max={:.1} clientHeight={:.1} scrollHeight={:.1} gapToMax={:.1}",
        bounds.get(1).and_then(|v| v.as_f64()).unwrap_or(f64::NAN),
        pair(conversation_row, "scrollOffset", 1),
        pair(conversation_row, "scrollRange", 1),
        pair(conversation_row, "clientSize", 1),
        pair(conversation_row, "scrollSize", 1),
        pair(conversation_row, "scrollRange", 1) - pair(conversation_row, "scrollOffset", 1),
    );
    let is_descendant = |mut id: u64| {
        for _ in 0..512 {
            let Some(Some(next)) = parent.get(&id) else {
                return false;
            };
            if *next == conversation {
                return true;
            }
            id = *next;
        }
        false
    };
    let mut descendants: Vec<(f64, u64, f64)> = layout
        .iter()
        .filter_map(|(id, row)| {
            if *id == conversation || !is_descendant(*id) {
                return None;
            }
            let box_ = row.get("bounds")?;
            let top = box_.get(1)?.as_f64()?;
            let height = box_.get(3)?.as_f64()?;
            Some((top + height, *id, top))
        })
        .collect();
    descendants.sort_by(|left, right| right.0.total_cmp(&left.0));
    for (bottom, id, top) in descendants.into_iter().take(12) {
        let (role, name) = named.get(&id).copied().unwrap_or(("", ""));
        println!(
            "  id={id} top={top:.1} bottom={bottom:.1} fromViewportBottom={:.1} role={role} name={}",
            bottom - viewport_bottom,
            name.chars().take(100).collect::<String>()
        );
    }
    Ok(())
}

/// Every box that sticks out of the box that contains it, worst first.
///
/// The reason this exists: "text spills past its container" is a claim about
/// one node's relationship to another node, and a three-element fixture cannot
/// express it. Two candidate mechanisms were built as fixtures and both were
/// refuted, which proved only that those two fixtures were wrong. The running
/// document already knows the answer; nothing asked it.
///
/// Horizontal by default, because vertical overflow is how a scroll container
/// works and would bury the signal. `spill v` includes the vertical axis.
async fn spill(client: &mut Client, axis: &str, tolerance: f64) -> Result<()> {
    let (snapshot, elapsed) = inspect(client).await?;
    let boxes: HashMap<u64, [f64; 4]> = snapshot
        .nodes
        .iter()
        .filter_map(|node| node.bounds.map(|bounds| (node.id, bounds)))
        .collect();

    // A spilling node is almost always an unnamed generic, so the row is
    // unreadable without saying what it sits inside. Walk up to the nearest
    // ancestor that carries a name.
    let by_id: HashMap<u64, &SemanticNode> =
        snapshot.nodes.iter().map(|node| (node.id, node)).collect();
    let describe = |mut id: u64| -> String {
        for _ in 0..12 {
            let Some(node) = by_id.get(&id) else { break };
            if !node.name.is_empty() {
                return format!(
                    "in {} \"{}\"",
                    node.role,
                    node.name.chars().take(60).collect::<String>()
                );
            }
            let Some(parent) = node.parent else { break };
            id = parent;
        }
        String::from("(no named ancestor)")
    };

    let vertical = axis.starts_with('v') || axis.starts_with('a');
    let mut by_owner: HashMap<String, (usize, f64)> = HashMap::new();
    let mut rows: Vec<(f64, String)> = Vec::new();
    for node in &snapshot.nodes {
        let (Some(child), Some(parent_id)) = (node.bounds, node.parent) else {
            continue;
        };
        let Some(parent) = boxes.get(&parent_id) else {
            continue;
        };
        // A zero-sized parent is a node that has not been laid out, not a
        // container something escaped from.
        if parent[2] <= 0.0 || parent[3] <= 0.0 || child[2] <= 0.0 {
            continue;
        }
        let left = parent[0] - child[0];
        let right = (child[0] + child[2]) - (parent[0] + parent[2]);
        let mut worst = left.max(right);
        let mut how = if right >= left { "right" } else { "left" };
        if vertical {
            let top = parent[1] - child[1];
            let bottom = (child[1] + child[3]) - (parent[1] + parent[3]);
            if top > worst {
                worst = top;
                how = "top";
            }
            if bottom > worst {
                worst = bottom;
                how = "bottom";
            }
        }
        if worst <= tolerance {
            continue;
        }
        let owner = describe(parent_id);
        let entry = by_owner.entry(owner).or_insert((0, 0.0));
        entry.0 += 1;
        entry.1 = entry.1.max(worst);
        rows.push((
            worst,
            format!(
                "{:>8.1}px {how:<6} {:<11} child[{:.0},{:.0} {:.0}x{:.0}] parent[{:.0},{:.0} {:.0}x{:.0}]  {} {}",
                worst,
                node.role,
                child[0], child[1], child[2], child[3],
                parent[0], parent[1], parent[2], parent[3],
                node.name.chars().take(40).collect::<String>(),
                describe(parent_id),
            ),
        ));
    }
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    println!(
        "{} nodes inspected in {elapsed:.1}ms, {} axis, tolerance {tolerance}px",
        snapshot.nodes.len(),
        if vertical { "both" } else { "horizontal" }
    );
    if rows.is_empty() {
        println!("nothing sticks out of its container");
    }
    for (_, row) in rows.iter().take(40) {
        println!("{row}");
    }
    if rows.len() > 40 {
        println!("... and {} more", rows.len() - 40);
    }
    // Parent-relative overflow is blind to the case where a box and every
    // ancestor up to the pane are all too wide together: each one fits inside
    // the next and nothing reports. So also measure everything against the
    // transcript itself, which is the edge the owner can see.
    if let Some((pane, pane_box)) = snapshot
        .nodes
        .iter()
        .filter(|node| node.name.contains("Conversation"))
        .filter_map(|node| node.bounds.map(|bounds| (node, bounds)))
        .max_by(|a, b| {
            (a.1[2] * a.1[3])
                .partial_cmp(&(b.1[2] * b.1[3]))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    {
        let right = pane_box[0] + pane_box[2];
        let mut out: Vec<(f64, u64, String)> = snapshot
            .nodes
            .iter()
            .filter_map(|node| node.bounds.map(|b| (node, b)))
            // Descendants of the pane only. The project panel sits to the
            // right of the transcript and every row in it is "past" the
            // transcript's edge without overflowing anything.
            .filter(|(node, _)| {
                let mut id = node.parent;
                for _ in 0..64 {
                    match id {
                        Some(current) if current == pane.id => return true,
                        Some(current) => id = by_id.get(&current).and_then(|n| n.parent),
                        None => return false,
                    }
                }
                false
            })
            .filter_map(|(node, b)| {
                let over = (b[0] + b[2]) - right;
                (over > 0.5 && b[2] > 0.0 && b[3] > 0.0).then(|| {
                    (
                        over,
                        node.id,
                        format!("{} {}", node.role, describe(node.id)),
                    )
                })
            })
            .collect();
        out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        // Is the transcript actually sitting on its tail? The complaint
        // "dialogs do not push the chat up" is this number: the gap between the
        // bottom of the last thing in the pane and the bottom of the pane. A
        // pinned transcript ends flush; anything else means the newest message
        // is cut off under the chrome below.
        let pane_bottom = pane_box[1] + pane_box[3];
        let deepest = snapshot
            .nodes
            .iter()
            .filter_map(|node| node.bounds.map(|b| (node, b)))
            .filter(|(node, b)| node.id != pane.id && b[2] > 0.0 && b[3] > 0.0)
            .filter(|(node, _)| {
                let mut id = node.parent;
                for _ in 0..64 {
                    match id {
                        Some(current) if current == pane.id => return true,
                        Some(current) => id = by_id.get(&current).and_then(|n| n.parent),
                        None => return false,
                    }
                }
                false
            })
            .map(|(_, b)| b[1] + b[3])
            .fold(f64::NEG_INFINITY, f64::max);
        if deepest.is_finite() {
            println!(
                "tail: last content ends at {deepest:.1}, pane ends at {pane_bottom:.1}, gap {:.1}",
                pane_bottom - deepest
            );
        }
        println!(
            "\ntranscript pane [{:.0},{:.0} {:.0}x{:.0}], right edge {right:.0}",
            pane_box[0], pane_box[1], pane_box[2], pane_box[3]
        );
        if out.is_empty() {
            println!("  nothing reaches past it");
        }
        for (over, id, what) in out.iter().take(15) {
            println!("  {over:>8.1}px past  {id:>12}  {what}");
        }
        // The chain, for the worst few. A box in the wrong place is explained by
        // whichever ancestor it was placed against, and that ancestor is never
        // the one in the row above.
        for (_, id, _) in out.iter().take(3) {
            println!("  chain for {id}:");
            let mut current = Some(*id);
            for _ in 0..16 {
                let Some(node) = current.and_then(|id| by_id.get(&id)) else {
                    break;
                };
                let b = node.bounds.unwrap_or([f64::NAN; 4]);
                println!(
                    "    {:>12} {:<12} [{:>7.1},{:>7.1} {:>7.1}x{:>6.1}]  {}",
                    node.id,
                    node.role,
                    b[0],
                    b[1],
                    b[2],
                    b[3],
                    node.name.chars().take(40).collect::<String>()
                );
                if node.id == pane.id {
                    break;
                }
                current = node.parent;
            }
        }
    }

    // The per-row list is dominated by whichever container repeats most, so
    // the grouping is what says where to look. A `truncate` row overflows by
    // design and clips in paint; a container that appears here once, deep in
    // the transcript, does not.
    if !by_owner.is_empty() {
        let mut owners: Vec<(String, (usize, f64))> = by_owner.into_iter().collect();
        owners.sort_by(|a, b| {
            b.1.1
                .partial_cmp(&a.1.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        println!("\nby container, worst first:");
        for (owner, (count, worst)) in owners {
            println!("  {count:>4} nodes  worst {worst:>7.1}px  {owner}");
        }
    }
    Ok(())
}

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

/// Nodes matching `want`, each with its attributes and its ancestor chain.
///
/// `spill` says a box sticks out; it cannot say whether that is a scroller
/// doing its job or a control escaping a clip. The difference is in the
/// attributes of the ancestors — which one carries the overflow and the
/// isolation — and the semantic snapshot already reports every attribute of a
/// generic node in `value`. So this needs no new server surface: the state was
/// already on the wire and nothing printed it.
async fn dom(client: &mut Client, want: &str, depth: usize) -> Result<()> {
    if want.is_empty() {
        bail!("dom needs a substring to match");
    }
    let (snapshot, elapsed) = inspect(client).await?;
    let by_id: HashMap<u64, &SemanticNode> =
        snapshot.nodes.iter().map(|node| (node.id, node)).collect();

    let describe = |node: &SemanticNode| -> String {
        let bounds = node
            .bounds
            .map(|b| format!("[{:.0},{:.0} {:.0}x{:.0}]", b[0], b[1], b[2], b[3]))
            .unwrap_or_else(|| "[no box]".into());
        format!(
            "{} {:<10} {:<28} {bounds}{}\n      attrs: {}",
            node.id,
            node.role,
            format!("{:?}", node.name),
            if node.visible { "" } else { "  HIDDEN" },
            node.value.as_deref().unwrap_or("(none)")
        )
    };

    let matched: Vec<&SemanticNode> = snapshot
        .nodes
        .iter()
        .filter(|node| {
            node.name.contains(want)
                || node.role.contains(want)
                || node.value.as_deref().is_some_and(|v| v.contains(want))
        })
        .collect();

    println!(
        "{} of {} nodes match {want:?} (inspect {elapsed:.1}ms)\n",
        matched.len(),
        snapshot.nodes.len()
    );
    for node in &matched {
        println!("{}", describe(node));
        let mut parent = node.parent;
        for level in 0..depth {
            let Some(current) = parent.and_then(|id| by_id.get(&id)) else {
                break;
            };
            println!(
                "  {}^{} {}",
                "  ".repeat(level),
                level + 1,
                describe(current)
            );
            parent = current.parent;
        }
        println!();
    }
    Ok(())
}

async fn nodes(client: &mut Client) -> Result<usize> {
    let (snapshot, elapsed) = inspect(client).await?;
    report::show_nodes(&snapshot.nodes, elapsed);
    Ok(snapshot.nodes.len())
}

/// What each retained pane costs in nodes.
///
/// `RETAINED_PROJECT_LIMIT` keeps eight project panes mounted, and a hidden
/// pane is a full DOM subtree: it is invisible, not absent. Nobody had priced
/// one, so this walks every node to its nearest `data-retained-*` ancestor and
/// totals the subtree. The visible pane is the one the owner is looking at;
/// every other line is what retention is charging for.
async fn panes(client: &mut Client) -> Result<()> {
    let (snapshot, elapsed) = inspect(client).await?;
    let by_id: HashMap<u64, &SemanticNode> =
        snapshot.nodes.iter().map(|node| (node.id, node)).collect();

    // The semantic snapshot carries no `data-*` attributes, so a pane cannot be
    // named by the attribute the shell stamps on it. It can still be found by
    // shape: a pane is a subtree hanging off a shared shell ancestor, and each
    // one contains exactly one "Conversation" region. Anchoring on that names
    // panes without needing new server surface.
    const ANCHOR: &str = "Conversation";

    let depth_of = |start: u64| -> usize {
        let mut cursor = Some(start);
        let mut depth = 0usize;
        for _ in 0..256 {
            let Some(current) = cursor.and_then(|id| by_id.get(&id)) else {
                break;
            };
            let Some(parent) = current.parent else { break };
            cursor = Some(parent);
            depth += 1;
        }
        depth
    };

    // Pane roots are the anchors' common-depth ancestors. Walk each anchor up a
    // fixed number of levels to the subtree the shell swaps, then total by root.
    let anchors: Vec<&SemanticNode> = snapshot
        .nodes
        .iter()
        .filter(|node| node.name.contains(ANCHOR))
        .collect();

    let mut roots: HashMap<u64, (bool, Option<[f64; 4]>)> = HashMap::new();
    for anchor in &anchors {
        let mut cursor = anchor.parent;
        let mut root = anchor.id;
        // Climb to the highest ancestor that is not shared by every pane: the
        // shell container has many anchor descendants, a pane root has one.
        for _ in 0..12 {
            let Some(current) = cursor.and_then(|id| by_id.get(&id)) else {
                break;
            };
            let descendants = anchors
                .iter()
                .filter(|other| {
                    let mut walk = Some(other.id);
                    for _ in 0..256 {
                        let Some(step) = walk.and_then(|id| by_id.get(&id)) else {
                            return false;
                        };
                        if step.id == current.id {
                            return true;
                        }
                        walk = step.parent;
                    }
                    false
                })
                .count();
            if descendants > 1 {
                break;
            }
            root = current.id;
            cursor = current.parent;
        }
        let node = by_id.get(&root).copied();
        roots.insert(
            root,
            (
                node.map(|n| n.visible).unwrap_or(false),
                node.and_then(|n| n.bounds),
            ),
        );
    }

    let mut totals: HashMap<u64, usize> = HashMap::new();
    let mut unattributed = 0usize;
    for node in &snapshot.nodes {
        let mut cursor = Some(node.id);
        let mut found = None;
        for _ in 0..256 {
            let Some(current) = cursor.and_then(|id| by_id.get(&id)) else {
                break;
            };
            if roots.contains_key(&current.id) {
                found = Some(current.id);
                break;
            }
            cursor = current.parent;
        }
        match found {
            Some(root) => *totals.entry(root).or_default() += 1,
            None => unattributed += 1,
        }
    }

    let mut rows: Vec<(u64, usize)> = totals.into_iter().collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.1));
    println!(
        "{} nodes total, {} panes found via {ANCHOR:?} (inspect {elapsed:.1}ms)\n",
        snapshot.nodes.len(),
        rows.len()
    );
    let mut hidden_cost = 0usize;
    for (root, count) in &rows {
        let (visible, bounds) = roots.get(root).copied().unwrap_or((false, None));
        let box_text = bounds
            .map(|b| format!("[{:.0},{:.0} {:.0}x{:.0}]", b[0], b[1], b[2], b[3]))
            .unwrap_or_else(|| "[no box]".into());
        println!(
            "  {count:>6}  node {root:<14} {:<8} depth {:<3} {box_text}",
            if visible { "VISIBLE" } else { "hidden" },
            depth_of(*root)
        );
        if !visible {
            hidden_cost += count;
        }
    }
    println!("\n  {unattributed:>6}  outside any pane (chrome, tab strip, overlays)");
    println!(
        "  {hidden_cost:>6}  in hidden panes = {:.0}% of the tree",
        100.0 * hidden_cost as f64 / snapshot.nodes.len().max(1) as f64
    );
    Ok(())
}

/// A fixed scroll burst, paced like a trackpad rather than a firehose.
/// Put the pointer over a named node, so the next wheel event goes to the
/// scroller under it.
///
/// A wheel event carries no coordinates. It lands on whatever the document
/// last saw the pointer over, which after a fresh launch is nothing, and the
/// scroll then goes to the root or to whichever container happened to be
/// hovered. Three scroll sweeps over a transcript changed the mounted rows not
/// at all and read as "the bug does not reproduce", when the transcript had
/// never been scrolled.
async fn hover_over(client: &mut Client, want: &str) -> Result<bool> {
    // "x,y" targets a point directly. A scroll container often has no
    // accessible name, so naming is not always enough to put the pointer inside
    // the thing you mean to scroll: aiming at "Settings" found a button in the
    // sidebar and every wheel event went there.
    if let Some((x, y)) = want.split_once(',')
        && let (Ok(x), Ok(y)) = (x.trim().parse::<f64>(), y.trim().parse::<f64>())
    {
        {
            client
                .agent(&AgentControlRequest::Act(AgentAction::Input(
                    InputCommand::Pointer {
                        phase: PointerPhase::Move,
                        x,
                        y,
                        button: 0,
                        modifiers: Modifiers::default(),
                    },
                )))
                .await?;
            println!("pointer at {x:.0},{y:.0}");
            return Ok(true);
        }
    }
    let (snapshot, _) = inspect(client).await?;
    let Some(node) = snapshot
        .nodes
        .iter()
        .filter(|node| node.visible && node.name.contains(want))
        .filter_map(|node| node.bounds.map(|bounds| (node, bounds)))
        .max_by(|a, b| {
            (a.1[2] * a.1[3])
                .partial_cmp(&(b.1[2] * b.1[3]))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(node, bounds)| (node.name.clone(), bounds))
    else {
        println!("no visible node named {want:?} to hover; wheel goes wherever it goes");
        return Ok(false);
    };
    let (name, bounds) = node;
    let (x, y) = (bounds[0] + bounds[2] / 2.0, bounds[1] + bounds[3] / 2.0);
    client
        .agent(&AgentControlRequest::Act(AgentAction::Input(
            InputCommand::Pointer {
                phase: PointerPhase::Move,
                x,
                y,
                button: 0,
                modifiers: Modifiers::default(),
            },
        )))
        .await?;
    println!("pointer over {name:?} at {x:.0},{y:.0}");
    Ok(true)
}

async fn scroll(client: &mut Client, ticks: usize, delta: f64) -> Result<()> {
    // Say what the pace is, every time, before any number is printed.
    //
    // The default sends a wheel event every 1/60s, so the app is asked for
    // roughly 60 frames a second and answers about 53 once the sleep overhead
    // is counted. Read without this line, that 53 looks like the application
    // failing to keep up on a 120Hz display, and the `missed_refreshes` figure
    // beside it appears to confirm it. Both are describing this loop.
    //
    // `BENCH_PACE=0` sends as fast as the app accepts, which is what measures
    // the application: it reaches 120fps with no missed refreshes.
    let pace = pace();
    if pace.is_zero() {
        println!("pace: unpaced (BENCH_PACE=0) - measures app throughput");
    } else {
        println!(
            "pace: {:.2}ms between events ({:.0} Hz requested); fps and missed_refreshes \
             below describe this pace, not the app's limit. BENCH_PACE=0 to remove it",
            pace.as_secs_f64() * 1000.0,
            1.0 / pace.as_secs_f64(),
        );
    }

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
/// Send a named key, optionally repeated, after focusing something inside a
/// named container.
///
/// Wheel events could not scroll the transcript: they carry no coordinates, and
/// pointing them at the pane still moved nothing. Page Up does, because it goes
/// to the focused scroller, and without it every attempt to reach the rows the
/// owner was looking at meant asking the owner to scroll. A bug that only
/// reproduces by hand is a bug that gets one measurement per message.
async fn press_key(client: &mut Client, name: &str, count: usize, over: &str) -> Result<()> {
    // A key goes to the focused node, so click the container first. Clicking a
    // scroll container's own body focuses it without activating anything: the
    // transcript section carries `tabindex="0"` for exactly this.
    let (snapshot, _) = inspect(client).await?;
    // A control whose only label is `sr-only` reaches the semantic tree with an
    // empty name, so no substring can address it. The slider is one, which is
    // why targeting by node id has to be possible at all.
    let by_id = over.parse::<u64>().ok().filter(|id| {
        snapshot
            .nodes
            .iter()
            .any(|node| node.id == *id && node.visible)
    });
    if let Some(target) = by_id.or_else(|| {
        snapshot
            .nodes
            .iter()
            .filter(|node| node.visible && !over.is_empty() && node.name.contains(over))
            .filter_map(|node| node.bounds.map(|b| (node, b)))
            .max_by(|a, b| {
                (a.1[2] * a.1[3])
                    .partial_cmp(&(b.1[2] * b.1[3]))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(node, _)| node.id)
    }) {
        client
            .agent(&AgentControlRequest::Act(AgentAction::Click {
                node_id: target,
            }))
            .await?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        println!("focused node {target} for {name} x{count}");
    } else {
        println!("no visible node named {over:?}; sending {name} to whatever has focus");
    }

    // `key` and `code` are both what the DOM calls them. They are not
    // interchangeable and sending the wrong one is a silent no-op.
    let (key, code) = match name.to_ascii_lowercase().as_str() {
        "pageup" | "pgup" => ("PageUp", "PageUp"),
        "pagedown" | "pgdn" => ("PageDown", "PageDown"),
        "home" => ("Home", "Home"),
        "end" => ("End", "End"),
        "up" | "arrowup" => ("ArrowUp", "ArrowUp"),
        "down" | "arrowdown" => ("ArrowDown", "ArrowDown"),
        "left" | "arrowleft" => ("ArrowLeft", "ArrowLeft"),
        "right" | "arrowright" => ("ArrowRight", "ArrowRight"),
        "tab" => ("Tab", "Tab"),
        other => {
            bail!("unknown key {other:?}: pageup, pagedown, home, end, up, down, left, right, tab")
        }
    };

    for _ in 0..count {
        for phase in [KeyPhase::Down, KeyPhase::Up] {
            client
                .agent(&AgentControlRequest::Act(AgentAction::Input(
                    InputCommand::Key {
                        phase,
                        key: key.to_string(),
                        code: code.to_string(),
                        modifiers: Modifiers::default(),
                    },
                )))
                .await?;
        }
        sleep_pace().await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(())
}

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

    // A click is dispatched at the node's coordinates, so a node scrolled out
    // of the viewport gets a `pointerdown` at a point nothing is at and no
    // click at all. "Show 12 earlier messages" sat at y=-2246 and every attempt
    // to press it read as the button doing nothing.
    let offscreen = target
        .bounds
        .is_some_and(|b| b[1] + b[3] < 0.0 || b[0] + b[2] < 0.0);
    let target_id = target.id;
    if offscreen {
        println!("  offscreen, scrolling it into view first");
        client
            .agent(&AgentControlRequest::Act(AgentAction::ScrollIntoView {
                node_id: target_id,
            }))
            .await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    let before = metrics(client).await?;
    let started = Instant::now();
    client
        .agent(&AgentControlRequest::Act(AgentAction::Click {
            node_id: target_id,
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
        "layout" => {
            let want = args.get(1).map(String::as_str).unwrap_or("");
            layout(&mut client, want).await?;
        }
        "transcript" => transcript(&mut client).await?,
        "nodes" => {
            nodes(&mut client).await?;
        }
        "panes" => panes(&mut client).await?,
        "dom" => {
            let want = args.get(1).map(String::as_str).unwrap_or("");
            let depth: usize = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(6);
            dom(&mut client, want, depth).await?;
        }
        "spill" => {
            let axis = args.get(1).map(String::as_str).unwrap_or("h");
            let tolerance: f64 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(0.5);
            spill(&mut client, axis, tolerance).await?;
        }
        "idle" => report::show("idle", &metrics(&mut client).await?),
        // Every counter the app publishes is cumulative since launch, and a
        // mount costs thousands of DOM writes. Reading them once and calling
        // the total a rate is how "3,698 attribute writes" got recorded as 230
        // a second when it was actually the startup mount, counted once.
        // Two reads and a subtraction is the only honest way to ask what an
        // idle app is still doing.
        "drift" => {
            let seconds: f64 = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(20.0);
            let before = metrics(&mut client).await?;
            println!("== holding still for {seconds}s, nothing driven ==");
            tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
            let after = metrics(&mut client).await?;
            let frames_of =
                |m: &RendererMetrics| m.frame_window.as_ref().map(|w| w.frames_total).unwrap_or(0);
            let frames = frames_of(&after).saturating_sub(frames_of(&before));
            println!(
                "frames={frames} over {seconds}s = {:.1}fps with no input",
                frames as f64 / seconds
            );
            report::show_delta(&before, &after, 0);
        }
        /*
         * The owner's blinking-rectangle repro, asserted rather than described.
         *
         * The repro is a project with 0 items and the item list expanded, which
         * is the state this reads. It exists because the fault was reported
         * four times and twice called fixed from a reading that did not
         * actually cover it: an idle window is not quiet here, and saying so
         * once in prose has not been enough.
         *
         * What it asserts, and why each is the honest form of the question:
         *
         * - `missed_refreshes` over the sample window. A blink is a frame that
         *   did not land, so this is the number that has to be zero. It is a
         *   count over a fixed 256-frame window, not a rate, so it is
         *   comparable between runs.
         * - the worst frame interval against the display's own period. A single
         *   72ms gap on a 60Hz display is four dropped refreshes and is visible
         *   as a flash; a mean of 13ms is not. The mean is what a naive reading
         *   reports and it hides exactly this.
         *
         * Both are read from one metrics response so they describe the same
         * window. Exits non-zero when the fault is present, so it can gate a
         * fix instead of being read by eye.
         *
         * Deliberately not asserted: fps. It averages over the window and a
         * blink does not move it enough to fail on, which is how "the window is
         * quiet" was concluded from a sample that contained a 477ms stall.
         */
        /*
         * Controls that are meant to be hidden and still take up space.
         *
         * The class of fault this catches has now shipped twice, and neither
         * time did a component test see it, because both are about geometry in
         * the real renderer rather than behaviour in a DOM stub. A field hidden
         * by styling the input alone leaves the library's wrapper in the
         * layout: measured beside every project name, a 101x46 box painting as
         * a black rectangle and squeezing the name next to it down to a few
         * characters.
         *
         * The rule is narrow on purpose. A node whose accessible name says it
         * belongs to an inactive control - a rename editor with no editor open
         * - must not own a painted box. Anything genuinely displayed is
         * expected to have one, so this reports only boxes that are both
         * sizeable and attached to something the tree calls hidden.
         */
        "ghost" => {
            let min_area: f64 = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(64.0);
            // Second argument so `ghost 64 0` can still demand a perfectly clean
            // tree when a caller wants that, without editing this default.
            let max_ghosts: usize = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(400);
            let answer = client
                .diagnostics(&DiagnosticsRequest::Snapshot(SnapshotRequest {
                    include_dom: true,
                    include_layout: true,
                    include_computed_style: false,
                }))
                .await?;
            let DebugResponse::Snapshot(snapshot) = answer.response else {
                bail!("asked for a layout snapshot, got {:?}", answer.response);
            };

            let mut boxes: HashMap<u64, (f64, f64, f64, f64)> = HashMap::new();
            if let Some(rows) = snapshot.layout.as_ref().and_then(|v| v.as_array()) {
                for row in rows {
                    let Some(id) = row.get("nodeId").and_then(|v| v.as_u64()) else {
                        continue;
                    };
                    let read = |key: &str, index: usize| {
                        row.get("bounds")
                            .and_then(|b| b.get(key).or_else(|| b.get(index)))
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0)
                    };
                    boxes.insert(
                        id,
                        (
                            read("x", 0),
                            read("y", 1),
                            read("width", 2),
                            read("height", 3),
                        ),
                    );
                }
            }

            let nodes = snapshot
                .dom
                .as_ref()
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut ghosts = Vec::new();
            for node in &nodes {
                // The snapshot spells this as `visible`, which is what `dom`
                // mode prints as HIDDEN. Reading a `hidden` key instead found
                // nothing and reported a clean run, which is the failure mode a
                // check like this must not have.
                let visible = node
                    .get("visible")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                if visible {
                    continue;
                }
                let Some(id) = node.get("id").and_then(|v| v.as_u64()) else {
                    continue;
                };
                let Some(&(x, y, w, h)) = boxes.get(&id) else {
                    continue;
                };
                if w * h >= min_area {
                    let name = node
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    ghosts.push((id, name, x, y, w, h));
                }
            }
            ghosts.sort_by(|a, b| (b.4 * b.5).total_cmp(&(a.4 * a.5)));

            println!(
                "{} nodes inspected, reporting hidden boxes of {min_area}px2 or more",
                nodes.len()
            );
            for (id, name, x, y, w, h) in &ghosts {
                println!("  {id:>10}  {w:>7.1}x{h:<7.1} at {x:.0},{y:.0}  {name}");
            }
            if ghosts.is_empty() {
                println!("\nno ghosts: nothing hidden is holding a painted box");
            } else {
                println!(
                    "\nGHOSTS PRESENT: {} hidden node(s) still occupy layout",
                    ghosts.len()
                );
                // Retention is deliberate, so some ghosts are the design rather
                // than a leak: `RETAINED_PROJECT_LIMIT` keeps Home, Settings and
                // two project panes mounted-but-hidden on purpose. A healthy app
                // measures 58. Failing on any ghost at all therefore fails on a
                // correct build, which is why this reported and never guarded.
                //
                // What a leak looks like: the 2026-08-20 window that painted one
                // flat colour and took no clicks measured 2,404 ghosts on a
                // comparable tree (5,527 nodes vs 5,098), a 41x rise. The budget
                // sits between the two, far enough above the healthy figure that
                // ordinary drift in the retained panes does not trip it.
                if ghosts.len() > max_ghosts {
                    println!(
                        "over budget: {} ghosts, limit {max_ghosts}. Hidden subtrees are not \
                         being unmounted.",
                        ghosts.len()
                    );
                    std::process::exit(1);
                }
                println!("within budget: limit {max_ghosts}");
            }
        }
        "blink" => {
            let allowed_missed: u64 = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
            let reading = metrics(&mut client).await?;
            report::show("blink", &reading);

            let Some(window) = reading.frame_window.as_ref() else {
                eyre::bail!(
                    "the app published no frame window, so there is nothing to assert; \
                     launch it with --blitz-deep-profiling"
                );
            };

            // The refresh period the app itself reports, so this stays right on
            // a 120Hz panel rather than assuming 60. Unknown falls back to 60,
            // which is the more forgiving of the two.
            let period_ms = 1000.0
                / window
                    .display_refresh_hz
                    .filter(|hz| *hz > 0.0)
                    .unwrap_or(60.0);
            // Two periods: one late frame is a hiccup, two is a gap a person
            // sees. Anything under this is not the reported fault.
            let interval_budget = period_ms * 2.0;
            let worst_interval = window.interval.max_ms;

            println!();
            println!("== the owner's repro: a project with 0 items, item list expanded ==");
            println!(
                "  missed refreshes : {} over {} frames (allowed {allowed_missed})",
                window.missed_refreshes, window.window_frames
            );
            println!(
                "  worst interval   : {worst_interval:.1}ms against a {period_ms:.1}ms refresh \
                 (budget {interval_budget:.1}ms)"
            );

            let mut faults = Vec::new();
            if window.missed_refreshes > allowed_missed {
                faults.push(format!(
                    "{} missed refreshes over {} frames",
                    window.missed_refreshes, window.window_frames
                ));
            }
            if worst_interval > interval_budget {
                faults.push(format!(
                    "a {worst_interval:.1}ms frame interval, {:.1}x the refresh period",
                    worst_interval / period_ms
                ));
            }

            if faults.is_empty() {
                println!("\nno blink: the window is quiet by both measures");
            } else {
                println!("\nBLINK PRESENT: {}", faults.join(", "));
                std::process::exit(1);
            }
        }
        "click" => {
            let want = args.get(1).map(String::as_str).unwrap_or("Settings");
            nodes(&mut client).await?;
            click_named(&mut client, want).await?;
        }
        "reveal" => {
            let want = args.get(1).map(String::as_str).unwrap_or("");
            let (snapshot, _) = inspect(&mut client).await?;
            let Some(target) = snapshot
                .nodes
                .iter()
                .find(|node| node.name.contains(want) && node.bounds.is_some())
            else {
                bail!("no node named {want:?}");
            };
            let before = target.bounds.unwrap();
            let id = target.id;
            println!("{id} {:?} y={:.1}", target.role, before[1]);
            client
                .agent(&AgentControlRequest::Act(AgentAction::ScrollIntoView {
                    node_id: id,
                }))
                .await?;
            tokio::time::sleep(Duration::from_millis(400)).await;
            let (after_snapshot, _) = inspect(&mut client).await?;
            let after = after_snapshot
                .nodes
                .iter()
                .find(|node| node.id == id)
                .and_then(|node| node.bounds);
            match after {
                Some(b) => println!("after: y={:.1} (moved {:.1})", b[1], b[1] - before[1]),
                None => println!("after: the node is gone from the tree"),
            }
        }
        "key" => {
            let name = args.get(1).map(String::as_str).unwrap_or("pageup");
            let count: usize = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(1);
            let over = args.get(3).map(String::as_str).unwrap_or("Conversation");
            press_key(&mut client, name, count, over).await?;
        }
        "type" => {
            let count: usize = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(20);
            let want = args.get(2).map(String::as_str).unwrap_or("");
            nodes(&mut client).await?;
            type_keys(&mut client, count, want).await?;
        }
        // Wheel events go to whatever the document last saw hovered, which an
        // injected pointer move does not reliably set, so they scroll nothing.
        // This asks the node's own scroll container to move, which is what
        // `scroll` should have been able to do all along.
        "drag" => {
            let want = args.get(1).map(String::as_str).unwrap_or("Conversation");
            let dy: f64 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(-400.0);
            let times: usize = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(1);
            let (snapshot, _) = inspect(&mut client).await?;
            let Some(target) = snapshot
                .nodes
                .iter()
                .filter(|node| node.visible && node.name.contains(want))
                .filter_map(|node| node.bounds.map(|b| (node, b)))
                .max_by(|a, b| {
                    (a.1[2] * a.1[3])
                        .partial_cmp(&(b.1[2] * b.1[3]))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(node, _)| node.id)
            else {
                bail!("no visible node named {want:?}");
            };
            println!("scrolling node {target} by {dy} x{times}");
            for _ in 0..times {
                client
                    .agent(&AgentControlRequest::Act(AgentAction::ScrollBy {
                        node_id: target,
                        delta_x: 0.0,
                        delta_y: dy,
                    }))
                    .await?;
                sleep_pace().await;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        "scroll" => {
            let ticks: usize = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(120);
            let delta: f64 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(-80.0);
            let over = args.get(3).map(String::as_str).unwrap_or("Conversation");
            let count = nodes(&mut client).await?;
            hover_over(&mut client, over).await?;
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
