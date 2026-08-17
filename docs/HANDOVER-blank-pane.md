# Handover: the blank content pane, and the two smaller bugs behind it

Written 2026-08-17 after a long session that fixed a lot and did **not** fix
this. Committed rather than left untracked because the next person needs the
dead ends more than the leads.

**Read "Dead hypotheses" before you touch anything.** Four plausible causes are
already eliminated, two of them by measurements that *look* like evidence for
them. You will re-derive all four in an afternoon otherwise.

---

## 1. The symptom, and the reproducer

The window chrome paints: tab strip, tab labels, traffic lights, the rounded
border of the content area. **Inside that border, nothing.** Owner screenshot:
`~/Pictures/Screenshot 2026-08-17 at 14.52.16.png`.

It recovers the moment anything scrolls, and returns on its own later.

**Owner's reproducer, and the single most valuable fact here:**

> "so far it's 0 item list, expand can reproduce it"

A project group with **zero items**, then **expand**. That is
`HomeTab.tsx:1435`:

```tsx
<Show when={!collapsed()}>
  <For each={items()}>
```

Expanding mounts the item rows. With zero items the `For` renders nothing, so
the container's height changes while no row is added. A layout pass runs, the
subtree it produces is empty, and that is exactly the state the blank shows.
**Start here.** Everything below was measured before this reproducer was known
and none of it was taken in this state.

The toggle is `toggleCollapsed`, driven through a 230ms timer that
distinguishes single click (fold) from double click (open) — see
`HomeTab.tsx:1272-1297`. If you need to drive it, note the timer: an immediate
second event claims the gesture.

---

## 2. What is measured and true *while blank*

Taken through the MCP control socket against the live process, deep profiling
on. All of these were healthy during the failure:

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

**Every subsystem reads correct while the user sees nothing.** That is the
whole difficulty, and it is why metric-driven debugging failed four times. Do
not accept a green number as evidence of anything here.

---

## 3. Dead hypotheses — do not re-derive these

**a. "A frame was never requested."** Wrong. Frames are produced continuously
at 89fps during the blank.

The reading that suggested it — `no frame window yet: the app has not
presented frames since launch` — is an **artifact**:
`blitz_shell::latest_frame_stats()` returns `None` whenever deep profiling is
off, regardless of how many frames rendered.
**Always pass `--blitz-deep-profiling` or that number lies to you.**

**b. The 1024-layer limit.** Wrong. High-water mark is 49 against a limit of
1024, and `layers_wanted_max == layers_used_max` on every frame. (A truncated
`grep` once made this look like "13 wanted, 1 used". Read the raw line.)

**c. Glass cost.** Real, fixed, and **not this**. The renderer *was* 119-181ms
mean with a 448ms worst case, because panels sat 12px apart inside a 36px blur
reach so six panels cost seven render passes. `gap-10` plus ps-anyrender#10
took it to **3.19ms with 0 missed refreshes**. The blank still happens at 3ms
a frame.

**d. The viewport parked past the end of its content.** Wrong, and this is a
trap worth fixing:

> The inspector prints `scrollOffset` in **zoomed** coordinates while
> `clientSize` and `scrollSize` are **unzoomed**
> (`tauri-runtime-blitz/src/runtime.rs:100-113`).

Comparing them directly makes every scroller look overscrolled. Converted
properly: settings sat at 7003 against a max of 7043, the transcript at 2214
against 2227 — **both correctly at the tail**. Fix that output before trusting
any scroll arithmetic from `blitz-bench layout`.

---

## 4. What has *not* been tried, and is the obvious next move

**Get the paint list, not another metric.** Everything measured so far asks
whether work happened. Nothing asks *what was drawn*. The unanswered question
is whether the pane's paint commands are in the scene at all while blank.

1. **Screenshot from inside the renderer while blank.**
   `TAURI_BLITZ_DRIVER` / `--driver` exposes a loopback WebDriver with a
   `screenshot` command (`docs/debugging.md`, "Layer two"). If the capture is
   also blank, the renderer's output is genuinely empty and the bug is
   upstream in scene building. If the capture is *correct*, the window is
   showing something stale and the bug is in presentation.
   Documented trap: screenshot text metrics differ from the window. Trust it
   for "did this paint" and for colour, **never** for geometry.

2. **Count scene commands for the pane's subtree**, good frame versus blank
   frame. A zero-command subtree inside a non-zero scene localises it
   immediately.

3. **Secondary lead, unexplained:** node count grows across tab switches
   (3,776 → 3,800 → 4,715 → 5,027 in one session), a duplicated tab label
   `"SettingsSettings"` appeared, and **two pane nodes sat at the identical
   position (14,65) with the same box** — one holding 707.8 of content, one
   holding 7750.9. That may be an accumulating mount rather than a paint
   problem, and it would explain a pane that is present but covered by an
   empty sibling. Worth one measurement before the harder work.

---

## 5. How to reproduce and observe

**Never against the owner's running instance.** Check first:

```sh
lsof +D ~/Library/Application\ Support/com.pathscale.agencyzero/db
```

Empty means free. Any output means stop.

```sh
cd ~/code/agencyzero
rm -f target/blitz-frame.log
BLITZ_FRAME_STATS=1 BLITZ_FRAME_STATS_FILE="$PWD/target/blitz-frame.log" \
TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json" \
  target/release/bundle/macos/AgencyZero.app/Contents/MacOS/az-gui \
  --blitz-control --blitz-deep-profiling &

cargo build -p blitz-bench
./target/debug/blitz-bench nodes         # tree size and role histogram
./target/debug/blitz-bench frames        # frame window; needs deep profiling
./target/debug/blitz-bench layout ""     # every box: scroll/range/client/content
./target/debug/blitz-bench dom "<text>" 2
./target/debug/blitz-bench click "<name substring>"
```

**A release build into `target/` unlinks a running app's control socket.** The
descriptor is written once at startup (`agent_control_server.rs:63`) and never
re-checked; an unlinked unix socket cannot be reconnected by path. The MCP
surface is then dead for the life of that process. Rebuild, *then* relaunch.

---

## 6. Fixed on `fix/ui-bug-sweep`, for context

Do not re-open these; each has a test that fails without the fix.

**ps-blitz#45** — double-click word / triple-click line selection in document
text; the Cmd+C path end to end; `offsetWidth`/`offsetHeight`/`offsetLeft`/
`offsetTop` (their absence made every slider's inset arithmetic `NaN`);
`autofocus` as a boolean attribute rather than the literal string `"true"`.

**ps-anyrender#10** — `mark_boundary_dirty`, so a backdrop segment re-copies
only the textures it wrote instead of every texture in the pool.

**agencyzero#162** — glass 6 controls to 3; Opus 5 selectable at 200k; the PR
bar's branch name as the link; zebra rows; item priority with a schema
migration; the glass axes **actually persisting** (Rust `Theme` never declared
`glass_blur`/`glass_refraction`/`glass_depth`, and `#[serde(default)]` drops an
unknown key silently, so every slider snapped back); and the desk preview
using `var(--az-tint)`/`var(--az-hue)` instead of hardcoded `0.004`/`240`,
which is why the strength and softness swatches showed the wrong colour.

**Guards, so none of it regresses silently:**

- `sliderAudit.test.tsx` — every slider renders, is named, holds finite values,
  moves, and **stays moved** after release.
- `appearanceAudit.test.tsx` — every swatch paints a real colour and applies on
  click.
- `every_glass_axis_survives_a_round_trip` in `settings.rs`.
- `glass_pass_count` in ps-blitz — asserts the app's own spacing batches.
- `scroll_offset_survives_shrink.rs` — eliminates the shrink-after-scroll path,
  which is **not** the cause.

---

## 7. Still open, besides the blank

- **The inspector's zoomed/unzoomed mismatch** (§3d). Cheap, and it removes a
  live trap.
- **`Layout::scroll_height`** reads larger than `content - client` on real
  panes even after unit conversion. Not the blank, but not understood either.
- **The control socket dying on rebuild** (§5). One-line fix: re-assert the
  descriptor when it goes missing, or put the socket outside `target/`.
