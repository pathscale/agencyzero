# Handover: the blank content pane

Untracked-style working note, committed on `fix/ui-bug-sweep` because the next
person needs it. Written 2026-08-17 after failing to find the cause across a
long session. **Four hypotheses are dead. Read those first so you do not spend
the afternoon re-killing them.**

## The symptom

The window chrome paints correctly: tab strip, tab labels, traffic lights,
the rounded border of the content area. **Inside that border there is
nothing.** Owner screenshot: `~/Pictures/Screenshot 2026-08-17 at 14.52.16.png`.

It recovers the instant anything scrolls. It comes back on its own later.
It happens on the Settings pane and has been seen on project panes.

## What is measured, and true, while it is blank

Driven through the MCP control socket against the live process, deep
profiling on:

| reading | value |
| --- | --- |
| frames presented | 1,964, still climbing |
| active fps | 89 |
| renderer | 3.4ms mean, 8.5ms max |
| newest frame age | 426ms |
| layers wanted / used | 13 / 13, nothing dropped |
| document | 3,800-5,027 nodes, fully laid out |
| main thread | idle in `nextEventMatchingMask`, 0.1% CPU |
| Metal | command buffers submitting continuously |

So: the renderer is healthy, the document exists, layout has run, frames reach
the compositor. **Every subsystem reads correct while the user sees nothing.**
That is the whole difficulty. Do not trust a green metric here; four of them
were green through every reproduction.

## Dead hypotheses

1. **"A frame was never requested."** Wrong. Frames are produced continuously
   at 89fps during the blank. The reading that suggested otherwise
   (`no frame window yet: the app has not presented frames since launch`) is
   an artifact: `blitz_shell::latest_frame_stats()` returns `None` whenever
   deep profiling is off, regardless of how many frames rendered. **Always
   launch with `--blitz-deep-profiling` or that number lies.**

2. **The 1024-layer limit.** Wrong. High-water mark is 49 against a limit of
   1024, and `layers_wanted_max == layers_used_max` on every frame.

3. **Glass cost.** Real, fixed, and *not* this. The renderer was 119-181ms
   mean with a 448ms worst case because AgencyZero's panels sat 12px apart
   inside a 36px blur reach, so six panels cost seven render passes. `gap-10`
   and ps-anyrender#10 took it to 3.19ms with 0 missed refreshes. The blank
   still happens at 3ms a frame.

4. **The viewport parked past the end of its content.** Wrong, and this one is
   a trap: the inspector prints `scrollOffset` in *zoomed* coordinates while
   `clientSize` and `scrollSize` are *unzoomed* (`tauri-runtime-blitz/src/
   runtime.rs:100-113`). Comparing them directly makes every scroller look
   overscrolled. Converted properly, settings sat at 7003 against a max of
   7043 and the transcript at 2214 against 2227 - both correctly at the tail.
   **Fix that inspector output before trusting any scroll arithmetic.**

## What has not been tried, and is the obvious next move

**Get the paint list, not another metric.** Everything above measures whether
work happened; nothing measures *what was drawn*. The question that matters is
whether the pane's own paint commands are in the scene at all while it is
blank, and no reading taken so far answers it.

Two routes:

- `TAURI_BLITZ_DRIVER` / `--driver` exposes a loopback WebDriver with a
  `screenshot` command (`docs/debugging.md`, "Layer two"). A capture taken
  *while blank* settles instantly whether the renderer's own output is empty
  or whether the window is showing something stale. Note the documented trap:
  screenshot text metrics differ from the window, so trust it for "did this
  paint" and for colour, never for geometry.
- Failing that, dump the scene's command count for the pane's subtree per
  frame and compare a good frame with a blank one.

A secondary lead worth one measurement: the node count grows across tab
switches (3,776 -> 3,800 -> 4,715 -> 5,027 in one session) and a duplicated
tab label `"SettingsSettings"` appeared, alongside two pane nodes at the
identical position (14,65) with the same box, one holding 707.8 of content and
one holding 7750.9. That may be an accumulating mount rather than a paint
problem, and it would explain a pane that is present but covered.

## How to reproduce and observe

```sh
# Never against the owner's running instance. Check first:
lsof +D ~/Library/Application\ Support/com.pathscale.agencyzero/db

cd ~/code/agencyzero
rm -f target/blitz-frame.log
BLITZ_FRAME_STATS=1 BLITZ_FRAME_STATS_FILE="$PWD/target/blitz-frame.log" \
TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json" \
  target/release/bundle/macos/AgencyZero.app/Contents/MacOS/az-gui \
  --blitz-control --blitz-deep-profiling &

cargo build -p blitz-bench
./target/debug/blitz-bench nodes        # tree size and roles
./target/debug/blitz-bench frames       # frame window, needs deep profiling
./target/debug/blitz-bench layout ""    # every box, with scroll/client/content
./target/debug/blitz-bench dom "<text>" 2
```

**A release build into `target/` unlinks a running app's control socket.** The
descriptor is written once at startup (`agent_control_server.rs:63`) and never
re-checked, and an unlinked unix socket cannot be reconnected by path, so the
MCP surface is dead for the life of that process. Rebuild, then relaunch.

## Fixed on this branch, for context

Renderer 458ms -> 3.19ms (glass batching). Double-click word select, copy,
`offsetWidth`/`offsetHeight`/`offsetLeft`/`offsetTop`, `autofocus` as a boolean
attribute - all ps-blitz#45. Glass 6 controls -> 3, Opus 5 at 200k, PR bar,
zebra rows, item priority, the glass axes actually persisting, and the desk
preview matching the stylesheet - all agencyzero#162.

Guards so these cannot regress silently: `sliderAudit.test.tsx` (every slider
renders, is named, holds finite values, and moves), `appearanceAudit.test.tsx`
(every swatch paints a real colour and applies on click),
`every_glass_axis_survives_a_round_trip` in `settings.rs`, and
`glass_pass_count` in ps-blitz, which now asserts the app's own spacing
batches.
