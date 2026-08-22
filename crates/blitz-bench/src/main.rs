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

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use blitz_control_protocol::{
    AgentAction, AgentControlRequest, AgentSnapshot, CaptureRequest, CapturedImage, DebugResponse,
    DebugStream, DiagnosticsRequest, InputCommand, KeyPhase, Modifiers, PointerPhase,
    RendererMetrics, SemanticNode, SnapshotRequest, WheelPhase,
};
use eyre::{Result, bail};

mod audit;
mod inspector;
mod qa;
mod report;
mod sweep;

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
  ghost [min-area] [max]      hidden nodes that still own a painted box, worst
                              first. Retention keeps some on purpose, so this
                              exits 1 only past a budget (default 64px2, 400)
  drift [seconds]             what the app does while nothing happens (default 20)
  frames                      one metrics read, laid out for reading
  metrics                     the raw metrics response
  tree                        the semantic tree
  layout [name-substr]        live boxes: x, y, w, h per named node
  dom <substr> [depth]        matching nodes with their attributes, plus the
                              ancestor chain, so a spill can be read against the
                              container that was meant to clip it (default 6)
  transcript                  transcript scroll state and lowest DOM descendants
  paint [name-substr] [min-area]  the colours the renderer resolved per node,
                              biggest box first, so a full-window wash names the
                              element that asked for it (default 10000px2)
  spill [h|v] [tolerance]     boxes that stick out of their container, worst first
  watch [seconds]             stream metrics/console/runtimeErrors (default 20)
  scroll [ticks] [delta] [over]  wheel events over a named node (default 120 -80 Conversation)
  drag [name-substr] [dy] [n]    scroll a named node's container directly, n times
  type [count] [name-substr]  drive real keystrokes into a text field (default 20)
  key <name> [count] [over]   pageup/pagedown/home/end/up/down/left/right/tab into a
                              named scroller, or into a bare node id
  reveal <name-substr>        scroll a named node into view, reporting its y before/after
  capture [name-substr] [scale]  render what the app actually drew and report the
                              visible ink in it. The whole window, or one named
                              node. This is the only mode that can tell a drawn
                              control from a blank box: every other reading here
                              comes from the tree, where the two are identical
  click <name-substring>      click the first matching visible, enabled node
  audit [family]              every button in the running app, measured against
                              what the renderer drew for it. Reports the ones
                              the owner cannot see. Exits 1 on any fault.
                              Families: close delete add edit disclosure copy
                              reorder run status fork reply attach clear other
  sweep [family]              CLICK every button and check it did what its name
                              says: a Collapse becomes an Expand, a Delete
                              removes its row, a Copy changes nothing. Point
                              AZ_DATA_DIR at a throwaway profile first, because
                              this presses destructive controls on purpose.
                              Exits 1 on any button that did not act
  qa [group]                  drive every panel control and check what the
                              renderer did with it: icons paint, hover reveals
                              the row actions, a status click does not remove
                              the row, revealing adds rows. Exits 1 on any
                              failure. Groups: icons hover status sections tasklog

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

/// What the renderer resolved every visible node to actually paint.
///
/// The reason this exists: on 2026-08-20 a window painted one flat colour and
/// took no clicks, and every other instrument said the app was healthy - 5,527
/// DOM nodes, correct content laid out in the visible band, 50fps, no GPU wait.
/// Four separate causes were proposed and eliminated, and the question "what
/// colour did the renderer think these pixels were" could not be asked at all,
/// because `include_computed_style` was in the protocol and nothing set it.
///
/// A screenshot shows the wrong colour; this says which node resolved to it,
/// which is the difference between blaming the rasteriser and finding the
/// element that asked for it. Colours arrive as `#rrggbbaa` straight from the
/// same conversion `blitz-paint` hands the rasteriser, so what is printed is
/// what was drawn, not what a stylesheet implies.
///
/// `min-area` skips the small stuff, because a full-window wash is a large box
/// and listing 5,000 glyph nodes buries it.
async fn paint(client: &mut Client, want: &str, min_area: f64) -> Result<()> {
    let answer = client
        .diagnostics(&DiagnosticsRequest::Snapshot(SnapshotRequest {
            include_dom: true,
            include_layout: true,
            include_computed_style: true,
        }))
        .await?;
    let DebugResponse::Snapshot(snapshot) = answer.response else {
        bail!("asked for a paint snapshot, got {:?}", answer.response);
    };

    let styles: HashMap<u64, serde_json::Value> = snapshot
        .computed_style
        .as_ref()
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| Some((row.get("nodeId")?.as_u64()?, row.clone())))
                .collect()
        })
        .unwrap_or_default();
    if styles.is_empty() {
        bail!("the snapshot carried no computed styles; is this build's diagnostics feature on?");
    }

    let bounds: HashMap<u64, (f64, f64, f64, f64)> = snapshot
        .layout
        .as_ref()
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let id = row.get("nodeId")?.as_u64()?;
                    let read = |key: &str, index: usize| {
                        row.get("bounds")
                            .and_then(|b| b.get(key).or_else(|| b.get(index)))
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0)
                    };
                    Some((
                        id,
                        (
                            read("x", 0),
                            read("y", 1),
                            read("width", 2),
                            read("height", 3),
                        ),
                    ))
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

    let mut rows: Vec<(f64, String)> = Vec::new();
    for node in &nodes {
        let Some(id) = node.get("id").and_then(|v| v.as_u64()) else {
            continue;
        };
        let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let role = node.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if !want.is_empty() && !name.contains(want) && !role.contains(want) {
            continue;
        }
        let (Some(style), Some(&(x, y, w, h))) = (styles.get(&id), bounds.get(&id)) else {
            continue;
        };
        let area = w * h;
        if area < min_area {
            continue;
        }
        let field = |key: &str| {
            style
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("-")
                .to_string()
        };
        let opacity = style
            .get("opacity")
            .and_then(|v| v.as_f64())
            .unwrap_or(f64::NAN);
        rows.push((
            area,
            format!(
                "  {id:>11}  {role:<12} {w:>7.1}x{h:<7.1} at {x:.0},{y:.0}  bg={:<10} fg={:<10} \
                 opacity={opacity:.2} {:<12} {name}",
                field("backgroundColor"),
                field("color"),
                field("visibility"),
            ),
        ));
    }

    // Largest first: a wash covering the window is the thing being looked for,
    // and it is by definition the biggest box that resolved to that colour.
    rows.sort_by(|a, b| b.0.total_cmp(&a.0));
    println!(
        "{} nodes, {} with computed styles, showing boxes of {min_area}px2 or more",
        nodes.len(),
        styles.len()
    );
    for (_, row) in &rows {
        println!("{row}");
    }
    if rows.is_empty() {
        println!("nothing matched");
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

/// Drive every panel check and report what the renderer did.
///
/// Each check runs against the live tree, and the three steps are separated on
/// purpose: hovering is what makes the row controls exist at all, and a check
/// that skips it reports a missing feature rather than a test driving the app
/// wrongly. That mistake is why the hover regression shipped.
///
/// Returns the number of failures, so the caller can set an exit code.
async fn run_qa(client: &mut Client, group: Option<&str>) -> Result<usize> {
    let all = qa::checks();
    let selected: Vec<&qa::Check> = all
        .iter()
        .filter(|check| group.is_none_or(|want| check.group == want))
        .collect();
    if selected.is_empty() {
        bail!("no checks in group {group:?}");
    }

    println!(
        "panel QA: {} checks against the running app\n",
        selected.len()
    );
    let mut results: Vec<(&qa::Check, std::result::Result<(), String>)> = Vec::new();

    for check in selected {
        let (before, _) = inspect(client).await?;

        // Hover first: the row actions do not exist until `pointerenter`.
        //
        // Aimed at a node inside the panel column, not merely one whose name
        // matches. Home renders the same control names, so hovering by name
        // alone landed on Home's list and reported the panel's arrows missing.
        if let Some(want) = check.hover {
            let target = if check.panel_only {
                let (tree, _) = inspect(client).await?;
                tree.nodes
                    .iter()
                    .filter(|node| node.name.contains(want) && node.visible)
                    .filter_map(|node| node.bounds.map(|b| (node, b)))
                    .find(|(_, b)| b[0] >= qa::PANEL_LEFT && b[2] > 0.0)
                    .map(|(_, b)| format!("{},{}", b[0] + b[2] / 2.0, b[1] + b[3] / 2.0))
            } else {
                None
            };
            hover_over(client, target.as_deref().unwrap_or(want)).await?;
            tokio::time::sleep(Duration::from_millis(150)).await;
        }

        // Then the action, if this check is about one. A click that cannot be
        // dispatched is itself a failure, not a skip.
        let mut click_error = None;
        if let Some(want) = check.click {
            if let Err(error) = click_named_quiet(client, want).await {
                click_error = Some(format!("could not click {want:?}: {error}"));
            }
            tokio::time::sleep(Duration::from_millis(600)).await;
        }

        let (after, _) = inspect(client).await?;
        let outcome = match click_error {
            Some(error) => Err(error),
            None => qa::verdict(check, &before.nodes, &after.nodes),
        };
        let mark = if outcome.is_ok() { "PASS" } else { "FAIL" };
        println!("  {mark}  [{}] {}", check.group, check.what);
        if let Err(error) = &outcome {
            println!("        {error}");
        }
        results.push((check, outcome));
    }

    let failed = results.iter().filter(|(_, out)| out.is_err()).count();
    let tally = qa::tally(&results);
    let mut groups: Vec<_> = tally.iter().collect();
    groups.sort_by_key(|(name, _)| *name);
    println!();
    for (name, (passed, total)) in groups {
        println!("  {name:<10} {passed}/{total}");
    }
    println!("\n{} passed, {failed} failed", results.len() - failed);
    Ok(failed)
}

/// Click one node by id, with no name lookup in between.
async fn click_by_id(client: &mut Client, node_id: u64) -> Result<()> {
    let answer = client
        .agent(&AgentControlRequest::Act(AgentAction::Click { node_id }))
        .await?;
    if let DebugResponse::Error(error) = answer.response {
        bail!("{} ({})", error.message, error.code);
    }
    Ok(())
}

/// `click_named` without the metrics report, for the QA runner's inner loop.
async fn click_named_quiet(client: &mut Client, want: &str) -> Result<()> {
    let (snapshot, _) = inspect(client).await?;
    let wanted = want.to_lowercase();
    let Some(target) = snapshot
        .nodes
        .iter()
        .find(|node| node.name.to_lowercase().contains(&wanted) && node.visible && node.enabled)
    else {
        bail!("no visible, enabled node matching it");
    };
    let target_id = target.id;
    // Off-screen controls get scrolled to first: a click at a point nothing is
    // at dispatches a `pointerdown` and no click, which reads as a dead button.
    if target
        .bounds
        .is_some_and(|b| b[1] + b[3] < 0.0 || b[0] + b[2] < 0.0 || b[1] > 4000.0)
    {
        client
            .agent(&AgentControlRequest::Act(AgentAction::ScrollIntoView {
                node_id: target_id,
            }))
            .await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    client
        .agent(&AgentControlRequest::Act(AgentAction::Click {
            node_id: target_id,
        }))
        .await?;
    Ok(())
}

/// What a captured frame contains, in the terms a person would use.
///
/// "Did it draw" is not answerable from a pixel count alone: an icon filled
/// black on a near-black surface is fully opaque and completely invisible, and
/// that exact failure shipped. What separates ink from background is contrast,
/// so that is what this measures.
struct Ink {
    /// Pixels that differ enough from the most common colour to be seen.
    visible: usize,
    total: usize,
    /// The colour occupying the most pixels, taken as the background.
    background: (u8, u8, u8),
}

impl Ink {
    fn fraction(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            self.visible as f64 / self.total as f64
        }
    }
}

/// Measure the visible ink in a captured frame.
///
/// The background is discovered rather than assumed, so this works against any
/// app's surface colour without being told what it is. Contrast is relative
/// luminance, because that is what decides whether a person can see the mark:
/// raw channel distance calls black-on-near-black "different" while being the
/// one case worth catching.
fn measure_ink(image: &CapturedImage) -> Result<Ink> {
    use base64::Engine as _;

    let rgba = base64::engine::general_purpose::STANDARD
        .decode(&image.rgba_base64)
        .map_err(|error| eyre::eyre!("the capture was not valid base64: {error}"))?;
    let expected = (image.width as usize) * (image.height as usize) * 4;
    if rgba.len() != expected {
        bail!(
            "capture is {} bytes, expected {expected} for {}x{}",
            rgba.len(),
            image.width,
            image.height
        );
    }

    let mut histogram: HashMap<(u8, u8, u8), usize> = HashMap::new();
    for pixel in rgba.chunks_exact(4) {
        *histogram.entry((pixel[0], pixel[1], pixel[2])).or_default() += 1;
    }
    let background = histogram
        .iter()
        .max_by_key(|(_, count)| **count)
        .map(|(colour, _)| *colour)
        .unwrap_or((0, 0, 0));

    let luminance = |(r, g, b): (u8, u8, u8)| {
        0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b)
    };
    let background_luminance = luminance(background);

    let visible = rgba
        .chunks_exact(4)
        .filter(|pixel| {
            // Transparent pixels are not ink whatever their colour.
            if pixel[3] < 32 {
                return false;
            }
            (luminance((pixel[0], pixel[1], pixel[2])) - background_luminance).abs() > 24.0
        })
        .count();

    Ok(Ink {
        visible,
        total: (image.width as usize) * (image.height as usize),
        background,
    })
}

/// Ask the app for a frame: the whole window, or one named node.
async fn capture(client: &mut Client, want: &str, scale: f32) -> Result<()> {
    let node_id = if want.is_empty() {
        None
    } else {
        let (snapshot, _) = inspect(client).await?;
        let node = snapshot
            .nodes
            .iter()
            .filter(|node| node.name.contains(want) && node.visible)
            .filter_map(|node| node.bounds.map(|bounds| (node, bounds)))
            .filter(|(_, bounds)| bounds[2] > 0.0 && bounds[3] > 0.0)
            .max_by(|a, b| {
                (a.1[2] * a.1[3])
                    .partial_cmp(&(b.1[2] * b.1[3]))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(node, _)| node);
        let Some(node) = node else {
            bail!("no visible node with a box whose name contains {want:?}");
        };
        println!(
            "capturing {} role={} name={}",
            node.id,
            node.role,
            report::py_repr(&node.name.chars().take(50).collect::<String>())
        );
        Some(node.id)
    };

    let answer = client
        .diagnostics(&DiagnosticsRequest::Capture(CaptureRequest {
            node_id,
            scale,
        }))
        .await?;
    let image = match answer.response {
        DebugResponse::Captured(image) => image,
        DebugResponse::Error(error) => bail!("capture refused: {} ({})", error.message, error.code),
        other => bail!("asked for a capture, got {other:?}"),
    };

    let ink = measure_ink(&image)?;
    println!(
        "{}x{} at {scale}x, background #{:02x}{:02x}{:02x}",
        image.width, image.height, ink.background.0, ink.background.1, ink.background.2
    );
    println!(
        "visible ink: {} of {} pixels ({:.2}%)",
        ink.visible,
        ink.total,
        ink.fraction() * 100.0
    );
    if ink.visible == 0 {
        println!("nothing was drawn: every pixel is the background colour");
    }
    Ok(())
}

/// Audit every button in the running application.
///
/// Reads the renderer's own paint output rather than capturing each control.
/// The paint snapshot reports, per node, the style the renderer resolved and
/// the box it drew into, which answers the same question a capture does and
/// answers it for the whole window in one call.
///
/// Capturing per button was tried first and was worse in both directions. It
/// took 19 seconds against well under one, and it reported false faults: a crop
/// taken from a full-document paint cannot see content a clipping scroller drew
/// into its own layer, so three `Edit` buttons were flagged that the paint
/// output proved were drawn, with colours identical to their working siblings.
async fn run_audit(client: &mut Client, family: Option<&str>) -> Result<usize> {
    use audit::{Audited, Verdict};

    let (snapshot, _) = inspect(client).await?;

    /*
     * The viewport, read from the tree rather than assumed.
     *
     * A control below the fold is clipped, not broken. The panel's own Settings
     * and Notes headers sit at y=939 in a 900px window and draw perfectly once
     * scrolled to, so a hardcoded bound reported them as faults. Reading the
     * `main` box also keeps this right when the window is resized.
     */
    let viewport = snapshot
        .nodes
        .iter()
        .filter(|node| node.role == "main")
        .filter_map(|node| node.bounds)
        .map(|b| (b[1], b[1] + b[3]))
        .max_by(|a, b| {
            (a.1 - a.0)
                .partial_cmp(&(b.1 - b.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or((0.0, f64::MAX));

    let painted = painted_nodes(client).await?;

    let mut rows: Vec<Audited> = Vec::new();
    for node in audit::buttons(&snapshot.nodes) {
        let family_name = audit::family_of(&node.name);
        if family.is_some_and(|want| family_name != want) {
            continue;
        }
        let (width, height) = node.bounds.map(|b| (b[2], b[3])).unwrap_or((0.0, 0.0));

        let verdict = if !node.visible {
            Verdict::Hidden
        } else if width <= 0.0 || height <= 0.0 {
            Verdict::NoBox
        } else if node
            .bounds
            .is_some_and(|b| b[1] + b[3] < viewport.0 || b[0] + b[2] < 0.0 || b[1] > viewport.1)
        {
            Verdict::Offscreen
        } else if painted.contains(&node.id) {
            Verdict::Drawn
        } else {
            Verdict::Blank
        };

        rows.push(Audited {
            name: node.name.clone(),
            family: family_name,
            width,
            height,
            verdict,
        });
    }

    if rows.is_empty() {
        bail!("no buttons matched {family:?}");
    }
    println!("auditing {} buttons in the running app\n", rows.len());

    let faults: Vec<&Audited> = rows.iter().filter(|row| row.verdict.is_fault()).collect();
    if faults.is_empty() {
        println!("no faults: every visible button was painted");
    } else {
        println!("{} button(s) the owner cannot see:\n", faults.len());
        for row in &faults {
            println!(
                "  {:<8} {:<52} {:.0}x{:.0}",
                row.verdict.label(),
                row.name.chars().take(52).collect::<String>(),
                row.width,
                row.height
            );
        }
        println!();
    }

    let mut families: Vec<_> = audit::by_family(&rows).into_iter().collect();
    families.sort_by_key(|(name, _)| *name);
    for (name, (passed, total)) in families {
        let mark = if passed == total { " " } else { "!" };
        println!("{mark} {name:<12} {passed}/{total}");
    }
    println!("\n{} audited, {} faults", rows.len(), faults.len());
    Ok(faults.len())
}

/// The nodes the renderer resolved and drew, from one paint snapshot.
///
/// A button absent from this was not painted, which is what "the owner cannot
/// see it" means. Asked once for the whole window rather than per control.
async fn painted_nodes(client: &mut Client) -> Result<HashSet<u64>> {
    let answer = client
        .diagnostics(&DiagnosticsRequest::Snapshot(SnapshotRequest {
            include_dom: false,
            include_layout: false,
            include_computed_style: true,
        }))
        .await?;
    let DebugResponse::Snapshot(snapshot) = answer.response else {
        bail!("asked for a paint snapshot, got {:?}", answer.response);
    };
    Ok(snapshot
        .computed_style
        .as_ref()
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("nodeId")?.as_u64())
                .collect()
        })
        .unwrap_or_default())
}

/// Click every button and report the ones that did not act.
///
/// The tree is re-read after each click rather than once at the end, because a
/// click changes what is on screen and a stale node id is a click on nothing.
/// Buttons are addressed by name for the same reason: ids do not survive the
/// re-render that a working button causes.
async fn run_sweep(client: &mut Client, family: Option<&str>) -> Result<usize> {
    let (snapshot, _) = inspect(client).await?;
    let viewport = snapshot
        .nodes
        .iter()
        .filter(|node| node.role == "main")
        .filter_map(|node| node.bounds)
        .map(|b| (b[1], b[1] + b[3]))
        .max_by(|a, b| {
            (a.1 - a.0)
                .partial_cmp(&(b.1 - b.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or((0.0, f64::MAX));
    let planned = sweep::cases(&snapshot.nodes, family, audit::family_of);
    if planned.is_empty() {
        bail!("no clickable buttons matched {family:?}");
    }
    println!("clicking {} buttons\n", planned.len());

    let mut outcomes: Vec<sweep::Outcome> = Vec::new();
    for case in planned {
        let (before, _) = inspect(client).await?;

        /*
         * Re-resolved by id, freshly, every time.
         *
         * Clicking by name cannot work here: fifteen task-log rows are all
         * called "Show the whole command", so after the first click the lookup
         * is ambiguous and every later one reports a failure that is the
         * harness's, not the application's. That produced 24 false failures in
         * the first run and buried whatever was real.
         *
         * The id is re-checked against the current tree rather than trusted
         * from the plan, because a working button re-renders its own row and a
         * stale id is a click on nothing.
         */
        let Some(node) = before.nodes.iter().find(|node| node.id == case.id) else {
            // Gone since the plan was made, which a working button often
            // causes: closing one tab removes the close buttons of its
            // neighbours. Not a failure.
            continue;
        };
        if !node.visible || !node.enabled {
            continue;
        }
        /*
         * Off the viewport is not clickable, and clicking it anyway tests the
         * harness rather than the application. A transcript keeps hundreds of
         * controls at negative coordinates and the panel's lower sections sit
         * below the fold; both reported as failures until they were skipped.
         */
        if node
            .bounds
            .is_some_and(|b| b[1] + b[3] < viewport.0 || b[0] + b[2] < 0.0 || b[1] > viewport.1)
        {
            continue;
        }

        if let Err(error) = click_by_id(client, case.id).await {
            outcomes.push(sweep::Outcome {
                case,
                failure: Some(format!("could not be clicked: {error}")),
            });
            continue;
        }
        // Long enough for a synchronous handler and its re-render. A backend
        // round trip is slower, and a button that only fails under that delay
        // is reported rather than waited for: the owner sees the same thing.
        tokio::time::sleep(Duration::from_millis(250)).await;

        let (after, _) = inspect(client).await?;
        let failure = sweep::judge(&case, &before.nodes, &after.nodes);
        outcomes.push(sweep::Outcome { case, failure });
    }

    let failures: Vec<&sweep::Outcome> = outcomes.iter().filter(|o| o.failure.is_some()).collect();
    if failures.is_empty() {
        println!("every button acted");
    } else {
        println!("{} button(s) did not act:\n", failures.len());
        for outcome in &failures {
            println!(
                "  {:<48} {}",
                outcome.case.name.chars().take(48).collect::<String>(),
                outcome.failure.as_deref().unwrap_or("")
            );
        }
        println!();
    }

    let mut by_family: HashMap<&'static str, (usize, usize)> = HashMap::new();
    for outcome in &outcomes {
        let entry = by_family.entry(outcome.case.family).or_insert((0, 0));
        entry.1 += 1;
        if outcome.failure.is_none() {
            entry.0 += 1;
        }
    }
    let mut families: Vec<_> = by_family.into_iter().collect();
    families.sort_by_key(|(name, _)| *name);
    for (name, (passed, total)) in families {
        let mark = if passed == total { " " } else { "!" };
        println!("{mark} {name:<12} {passed}/{total}");
    }
    println!(
        "\n{} clicked, {} did not act",
        outcomes.len(),
        failures.len()
    );
    Ok(failures.len())
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
        "paint" => {
            let want = args.get(1).map(String::as_str).unwrap_or("");
            let min_area: f64 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(10_000.0);
            paint(&mut client, want, min_area).await?;
        }
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
        "capture" => {
            let want = args.get(1).map(String::as_str).unwrap_or("");
            let scale: f32 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(1.0);
            capture(&mut client, want, scale).await?;
        }
        "audit" => {
            let family = args.get(1).map(String::as_str);
            let faults = run_audit(&mut client, family).await?;
            if faults > 0 {
                std::process::exit(1);
            }
        }
        "sweep" => {
            let family = args.get(1).map(String::as_str);
            let failures = run_sweep(&mut client, family).await?;
            if failures > 0 {
                std::process::exit(1);
            }
        }
        "qa" => {
            let group = args.get(1).map(String::as_str);
            let failed = run_qa(&mut client, group).await?;
            if failed > 0 {
                std::process::exit(1);
            }
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
