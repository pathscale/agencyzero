# Blitz performance architecture

> We reviewed EVERY Rust UI project available and blended the best together.

This is the design thesis for AgencyZero's native UI stack. Each borrowed idea below remains tied to its source, the problem it solves, a tracked workstream, and a measurable validation gate.

## Priorities

AgencyZero optimizes this Blitz fork for design correctness and measured performance. Compatibility with Blitz upstream is not a goal.

Delivery order:

1. macOS interaction correctness and smooth rendering
2. macOS profiling and retained-work optimization
3. Linux and Windows renderer validation

The platform boundary must remain clean even when macOS receives the first optimized implementation.

## Decisions

### Use Vello on wgpu for the window renderer

The Tauri Blitz runtime should use `anyrender_vello::VelloWindowRenderer` instead of `anyrender_vello_cpu::VelloCpuWindowRenderer` and softbuffer.

Why:

- wgpu uses Metal on macOS and preserves Vulkan and D3D12 paths for later Linux and Windows delivery.
- Vello submits vector work to the GPU instead of rasterizing and copying the entire window through the CPU on every interaction frame.
- Xilem already validates the winit, Vello/wgpu, Parley/Fontique, and AccessKit stack as a coherent native UI architecture.

Reference: https://docs.rs/wgpu/latest/wgpu/

The CPU renderer remains a supported reference path until GPU and CPU measurements cover both interaction latency and resident memory. A mostly idle monitoring UI can save substantial RSS by avoiding a GPU context, while AgencyZero's current full-window CPU rasterization causes visible interaction stalls. GPU is therefore the macOS default hypothesis, not an unmeasured universal rule.

Case study: https://trystan-sarrade.com/article/rust-gui-135mb-to-30mb-egui-to-slint/

### Make redraw demand explicit and coalesced

DOM mutations and input events may invalidate a window many times before the platform is ready to draw. `blitz-shell::View` must retain one pending redraw bit and issue at most one outstanding platform frame request.

Input handlers update state. The platform frame callback resolves style/layout, builds or reuses the scene, and presents it.

This follows GPUI's dirty invalidator and platform `on_request_frame` design.

Reference: https://github.com/zed-industries/zed/tree/main/crates/gpui

### Preserve native macOS trackpad deltas

macOS already supplies smooth pixel deltas and kinetic scrolling. Do not low-pass filter them again.

Discrete mouse-wheel line steps may be smoothed over subsequent frames with a time-based filter, but only after frame timing instrumentation is available. This matches egui's distinction between native smooth input and large wheel notches.

Reference: https://github.com/emilk/egui

### Retain DOM state and incrementally reuse rendered work

The DOM remains the retained element tree. Stylo snapshots, restyle hints, layout damage, and stable node identities should determine dirty subtrees.

Unchanged nodes should replay cached paint ranges or scene fragments. Event routing and accessibility state remain independent from paint caching.

This combines GPUI's cached paint replay with Xilem's short-lived view diff over a retained element tree.

References:

- https://github.com/zed-industries/zed/tree/main/crates/gpui
- https://github.com/linebender/xilem

### Cache expensive renderer resources and batch submission

Retain glyph and path resources across frames, collect scene commands, and submit them in batches. Tight clips must be preserved, especially for rounded and transparent elements.

Repeated expensive shadows can be cached to textures after shadow and clip correctness is covered by regression captures.

FemtoVG demonstrates retained glyph atlases, batched vertices and commands, tight scissoring, and zero-work transparent shadows. Vello/wgpu remains the selected AgencyZero backend.

Reference: https://github.com/femtovg/femtovg

### Treat browser-quality text as a correctness requirement

AgencyZero is a text-reading application. Font output must remain clean, stable, and comfortable at
normal and Retina scales. A roughly one-percent rendering cost is an acceptable trade for visibly
better text; font quality must not be reduced merely to improve a throughput benchmark.

Preserve correct font fallback, shaping, kerning, ligatures, variable-font axes, weight/style
selection, line metrics, baselines, glyph positioning, hinting, and antialiasing. Optimize font
discovery, shaped-run caches, glyph atlases, and GPU batching only when cached and uncached output
remain equivalent. Validate long chat/browser-like passages, small secondary text, bold labels,
mixed scripts, emoji, zoom, and Retina scale transitions against the platform/WebKit reference.

Performance measurements should identify text cost separately, but the quality baseline is the
constraint: accept about a one-percent regression for materially cleaner text, and require explicit
visual evidence before adopting any faster lower-quality mode.

### Keep runtime data compact and renderer backends replaceable

Slint stores component elements, items, and properties in compact regions to reduce allocation overhead, while keeping rendering backends selectable behind one runtime boundary. Its compiler can eliminate constant or unchanged property work before runtime.

AgencyZero cannot compile arbitrary web content ahead of time, but it can apply the same principles:

- keep hot per-node paint and layout metadata contiguous
- intern repeated computed values instead of cloning them per node
- separate the DOM/style/layout pipeline from the selected window renderer
- short-circuit unchanged computed properties before layout or paint damage is propagated

Reference: https://github.com/slint-ui/slint

### Stage rendering and carry change metadata forward

Bevy separates the main application world from a render world, extracts only render-relevant state, prepares GPU resources, batches queued work, and can pipeline rendering alongside subsequent application work. Its data-oriented change detection keeps unchanged data out of downstream systems.

AgencyZero should adopt the staging without adopting a game-engine ECS:

- resolve DOM/style/layout mutations into an explicit frame change set
- extract only visible, paint-dirty nodes into renderer-owned frame data
- prepare reusable GPU resources independently from scene ordering
- batch and submit after extraction is complete
- preserve timing boundaries for each stage

Reference: https://github.com/bevyengine/bevy

### Keep runtime actions and rendering independent

Iced keeps its native runtime renderer-agnostic and offers both wgpu and tiny-skia implementations. Runtime actions such as input, window operations, resource polling, and redraw are distinct from the renderer.

AgencyZero should keep `blitz-shell` and the Tauri runtime generic over the renderer, preserve CPU rendering as a fallback/reference, and expose the same frame diagnostics regardless of backend.

Reference: https://github.com/iced-rs/iced

### Keep macOS presentation damage-aware and truly idle

Cocoa-Way's macOS compositor uses Metal with Retina scaling, damage-aware shared-memory uploads, on-demand rendering, and telemetry that does not force continuous GUI redraws. Static displays report zero frames per second.

AgencyZero should use the same macOS behavior as a validation target:

- no polling render loop while the window is unchanged
- damage-aware texture or scene updates
- correct Retina scale transitions
- background telemetry and timers update model state without repainting unrelated UI
- native input and window lifecycle remain platform-specific adapters around the shared runtime

Reference: https://github.com/J-x-Z/cocoa-way

### Use indexed in-process tables only for measured data hot spots

WorkTable provides typed in-memory tables with generated primary and secondary indexes, paged
zero-copy row storage, concurrent read publication, optional persistence, and explicit memory
accounting. It is a candidate for complex tabular application state where profiling shows repeated
linear scans, expensive ad hoc indexes, or high-contention keyed access.

AgencyZero should not put the DOM, paint tree, or small UI collections behind a table abstraction.
Evaluate WorkTable for large project, task, event, or telemetry collections only when a benchmark
captures the real query mix and compares latency, tail latency, memory, update cost, and iteration
cost against the current structure. Use the in-memory tier unless persistence semantics are
explicitly required; its optional persistence is best-effort rather than an ACID database.

For concurrent ordered indexes, benchmark WorkTable's Arctic backend first and Congee as a
comparison. Arctic combines linearizable lock-free writes, linearizable wait-free point reads, and
ordered range/prefix scans. Its upstream results are x86-64-focused and its strongest guarantees
depend on efficient 128-bit atomics, so Apple-silicon behavior must be measured rather than assumed.

References:

- https://github.com/pathscale/WorkTable/
- https://github.com/pathscale/arctic-wt

## Current fixes

- Coalesce repeated redraw requests with one pending frame bit.
- Compute outset-shadow compositing bounds from actual outset shadows only. Never union with `Rect::ZERO`, and never let inset shadows enlarge the outset layer.
- Add deterministic headless hover and scroll positioning so interaction styles can be regression-captured.
- Migrate the Tauri Blitz runtime to the Vello/wgpu window renderer.
- Keep `AutoVsync` and a two-frame surface queue, but never fence on
  `device.poll(wait_indefinitely())` after each present. Use a non-blocking poll so CPU scene work
  and GPU execution can overlap.
- Record the display mode, active-scroll frame intervals, missed refresh intervals, style/layout,
  paint-scene, and renderer time from the real window.
- Keep the CPU image renderer behind an opt-in capture feature. The normal 0.3.59 bundle uses thin
  LTO and symbol stripping, reducing the measured app from 45 MiB to 28 MiB without size-oriented
  optimization levels that could harm interaction latency.

## Performance gates

Before claiming a scrolling improvement, record:

- input-to-present latency
- invalidations coalesced per frame
- style and layout time
- scene build or replay time
- GPU submission and presentation time
- dropped frames and p95 frame time at 60 Hz and 120 Hz
- idle CPU use
- cache sizes over a sustained session
- resident memory and startup time for both CPU and GPU renderers

Correctness captures must cover hover, selected radio rings, rounded clips, transparent shadows, nested scrolling, and scrollbar interaction. GPU output should also be compared with a CPU reference capture using a bounded pixel-difference threshold.

## Tracked workstreams

The local AgencyZero item tracker contains separate workstreams for:

- the macOS GPU-backed renderer migration
- retained scene reuse and dirty-region rendering
- Linux and Windows performance/rendering validation
- glyph and path caches with batched GPU submission
- browser-quality font shaping and rendering parity
- CPU-versus-GPU latency, startup, and resident-memory comparison
- benchmark-driven evaluation of WorkTable for complex tabular application state

The active Blitz compatibility item owns the immediate redraw, hover, scrolling, and shadow-artifact fixes.
