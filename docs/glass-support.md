# Glass support

Planning notes, written 2026-08-13 from a read of the window, runtime, render and
paint layers, then revised 2026-08-14 once most of it was built. Every claim
carries a file and line so the next person can check it rather than trust it.

**Status: Stages 0 through 4 are implemented; the one thing still missing is the
blur itself in the renderer the app actually runs.** Read
[Where this stands](#where-this-stands-2026-08-14) before the plan below, which
is kept as the reasoning that got here.

## The environment, verified on this machine

| | |
|---|---|
| macOS | 26.5 (build 25F71), Darwin 25.5 |
| SDK | `MacOSX.sdk` in CommandLineTools |
| `NSGlassEffectView.h` | present, `API_AVAILABLE(macos(26.0))` |

The Liquid Glass API is real and available here:

```objc
typedef NS_ENUM(NSInteger, NSGlassEffectViewStyle) { Regular, Clear };

@interface NSGlassEffectView : NSView
@property (nullable, strong) __kindof NSView *contentView;
@property CGFloat cornerRadius;
@property (nullable, copy) NSColor *tintColor;
@property NSGlassEffectViewStyle style;
@end

@interface NSGlassEffectContainerView : NSView
@property (nullable, strong) __kindof NSView *contentView;
@property CGFloat spacing;   // merges nearby glass shapes into one
@end
```

Note `contentView`: `NSGlassEffectView` **wraps** content rather than being a
backdrop you slide underneath. That matters for where it can be attached, below.

## Two different features share the word

They are worth separating, because one is cheap and one is not.

1. **Window glass.** The window itself becomes translucent and the desktop
   behind it is blurred by the compositor. Needs the window, the surface and the
   root background to cooperate. This is the expensive one.
2. **In-app glass.** Panels inside the app blur what is behind *them*, via CSS
   `backdrop-filter`. Entirely inside the renderer, no AppKit involved.

The second can ship without the first and is where the existing groundwork is.

## Where this stands (2026-08-14)

### Built and verified

- **`backdrop-filter` is implemented**, in
  [`anyrender_vello_cpu/src/scene.rs`](../../ps-anyrender/crates/anyrender_vello_cpu/src/scene.rs).
  The trick is that `render_to_pixmap` takes `&self`, so the scene so far can be
  snapshotted mid-frame without consuming it; that snapshot is then redrawn
  through a filtered layer clipped to the element. Stage 0's
  `backdrop_filter_blur.rs` is **green**, three tests, sampled across the seam as
  a monotonic ramp rather than at one pixel.
- **The `filters` cargo feature was never enabled by any consumer.** That, not a
  missing implementation, is why filters read as absent for a whole afternoon.
  `blitz-tests` now asks for it explicitly.
- Stage 1 (`with_transparent`), Stage 2 (transparent composite, clearing to
  `Color::TRANSPARENT` instead of the default opaque **white**) and Stage 3
  (`apply_liquid_glass` with an `apply_vibrancy` fallback, plus
  `set_window_glass(tint, radius, enabled)` over a `OnceLock`) are all in
  `tauri-runtime-blitz`. `window-vibrancy 0.8` was taken as a dependency after
  all: it had already solved the view-hierarchy placement.
- Stage 4 shipped as **three appearance sliders** — Panel lift, edge, depth —
  writing `--az-glass-lift`, `--az-glass-border` and `--az-glass-shadow`, with
  the CSS values bridged to the native window chrome. Each axis is asserted in
  pixels, because `getComputedStyle` over the debug driver answers for only a
  handful of properties and neither `outline` nor `box-shadow` is among them.
  See `tests/blitz-tests/tests/panel_axes.rs`.

### Not built: the blur, in the renderer that ships

This is the whole remaining gap, and it is worth stating precisely because
"backdrop-filter is implemented" and "the app cannot blur" are both true.

| renderer | ships in `az-gui`? | filters |
|---|---|---|
| `anyrender_vello` (GPU, vello 0.9) | **yes**, the default | **none.** `push_layer` takes `_filter` and `_backdrop_filter` and drops both ([`scene.rs:75`](../../ps-anyrender/crates/anyrender_vello/src/scene.rs)) |
| `anyrender_vello_cpu` | no, tests only | `filter` and `backdrop-filter`, both working |
| `anyrender_vello_hybrid` | behind `--features blitz-hybrid` | `filter` only, over the layer's **own** content |

So the blur landed in the one renderer the window does not use. Getting it on
screen means one of:

1. **Implement backdrop capture in `vello_hybrid`.** `FilterSource::BackgroundImage`
   is declared in `vello_common 0.0.9`
   (`filter_effects.rs:684`) and in `anyrender`
   ([`filters.rs:267`](../../ps-anyrender/crates/anyrender/src/filters.rs)), and is
   implemented nowhere. This is the honest route and it is upstream work.
2. Wait for vello proper to grow a layer filter. It has none in 0.9.
3. Ship the CPU renderer for the window, which trades the blur for the frame
   budget of every other pixel. Not seriously on the table.

Note also that the hybrid renderer rasterises visibly softer than vello proper.
That was measured and is **not** a scale-factor bug: scene and surface were both
2688x1800.

### Also open

- **Window transparency is off**, and native glass is gated behind
  `WINDOW_GLASS_ENABLED = false` in
  [`lib/theme.ts`](../gui/frontend/src/lib/theme.ts). Attaching Liquid Glass to
  an opaque window washed the entire app out, twice.
- Dark glass over a dark desktop only darkens. The owner's rule: **there is no
  frosted black**, so on a dark theme glass has to tint, never add white alpha.
  A glass mode that only lowers opacity will look broken and be correct.
- `outline-offset` is ignored by the renderer: a probe at `-2px` painted
  identically to no offset at all, so `.rounded-panel`'s inset hairline actually
  sits a pixel outside its border box. Engine bug, unrelated to the axes.

## What already exists

- `blitz-paint` carries `backdrop_filter` through the layer stack:
  [`layers.rs:162`](../../ps-blitz/packages/blitz-paint/src/layers.rs),
  [`render.rs:519`](../../ps-blitz/packages/blitz-paint/src/render.rs). **It is
  plumbing only — it does not blur.** Measured, see Stage 0 below.
- `anyrender` already models surface transparency:
  `CompositeAlphaMode` at
  [`types.rs:130`](../../ps-anyrender/crates/anyrender/src/types.rs), with a
  configurable `composite_alpha_mode` on the renderer options.
- The window is already borderless-ish: `titleBarStyle: "Overlay"` with a
  fullsize content view ([`runtime.rs:1815`](../../tauri-runtime-blitz/crates/tauri-runtime-blitz/src/runtime.rs)),
  so there is no native title bar to fight.

## The blockers, in the order they bite

### 1. The window is always opaque

`BlitzWindowBuilder` accepts `transparent`
([`lib.rs:178`](../../tauri-runtime-blitz/crates/tauri-runtime-blitz/src/lib.rs))
and stores it on the config. `window_attributes`
([`runtime.rs:1769`](../../tauri-runtime-blitz/crates/tauri-runtime-blitz/src/runtime.rs))
then builds the winit `WindowAttributes` and **never calls `.with_transparent`**.
The flag is accepted and dropped.

`background_color` is the same story: the setter exists
([`lib.rs:218`](../../tauri-runtime-blitz/crates/tauri-runtime-blitz/src/lib.rs),
[`window_dispatch.rs:351`](../../tauri-runtime-blitz/crates/tauri-runtime-blitz/src/window_dispatch.rs))
and nothing in `runtime.rs` reads it back.

So today, `"transparent": true` in `tauri.conf.json` would be a silent no-op.
This is the first thing to fix and the smallest change of the four.

**Fixed.** `window_attributes` now calls `.with_transparent(config.transparent)`.
The config itself still asks for an opaque window, deliberately.

### 2. Nothing inserts a glass view

Tauri's own `windowEffects` config targets Wry/WKWebView. This app does not use
Wry — it runs winit plus a Blitz surface — so that config path is inert here.

**The bindings are already in the dependency graph.** Before adding anything,
check what is there — `objc2-app-kit 0.3.2` is already resolved (winit pulls it)
and already generates both classes:

```
objc2-app-kit-0.3.2/src/generated/NSGlassEffectView.rs
objc2-app-kit-0.3.2/src/generated/NSVisualEffectView.rs
```

with the full API, behind a per-class cargo feature (`NSGlassEffectView`):

```rust
NSGlassEffectView::new(mtm) -> Retained<Self>
  setContentView(Option<&NSView>)   setCornerRadius(CGFloat)
  setTintColor(Option<&NSColor>)    setStyle(NSGlassEffectViewStyle)
```

The graph resolves **objc2 0.6.4 / objc2-app-kit 0.3.2 / objc2-foundation
0.3.2**, and has **no `objc` and no `cocoa`**. That matters for the crate
choices below: anything built on the older `objc`/`cocoa` layer adds a second
Objective-C runtime binding beside `objc2`, which is a known source of pain and
duplicate-class trouble.

So the cheapest correct route is **enable one cargo feature and write ~20 lines
against bindings already compiled into this build**. No new dependency, no
version negotiation, and it reaches `NSGlassEffectView` directly rather than
through someone else's abstraction.

### The reviewed alternatives, and why they rank below that

**`tauri-apps/window-vibrancy`** — the strongest *external* option, and worth
reading even if not depended on. Checked against its source rather than its
README:

```rust
pub fn apply_vibrancy(
    window: impl raw_window_handle::HasWindowHandle,
    effect: NSVisualEffectMaterial, state: Option<NSVisualEffectState>, radius: Option<f64>,
) -> Result<(), Error>;

#[cfg(target_os = "macos")]                                   // macOS 26+
pub fn apply_liquid_glass(
    window: impl raw_window_handle::HasWindowHandle,
    options: LiquidGlassOptions<'_>,
) -> Result<(), Error>;
pub fn clear_liquid_glass(window: impl ...HasWindowHandle) -> Result<bool, Error>;
```

It already ships Liquid Glass, and takes `HasWindowHandle` from
**raw-window-handle 0.6**; this graph resolves winit `0.31.0-beta.2` against
`raw-window-handle 0.6.2`, so the versions line up. Its value is that it has
already solved the fiddly parts — where in the view hierarchy the effect view
goes, keeping it behind the content, and tearing it down again. **Read it for
that even if the implementation ends up direct.** Take the dependency if the
hand-rolled version turns out to fight the winit view hierarchy.

**`Stapxs/liquid-glass-rs`** — wraps `NSGlassEffectView` for macOS 26+ with 24
material variants and a `GlassViewManager` (`add_glass_view`, `set_variant`,
`set_scrim_state`), configured by corner radius, hex tint and opacity. Richer
than what is needed for a window backdrop, and genuinely interesting later for
*per-control* glass. **But it is built on the `objc` and `cocoa` crates**, which
this graph does not contain and which are the superseded layer. Adding it would
introduce a second Objective-C binding stack next to `objc2`. Not recommended
now; worth revisiting as a reference for the variant list.

**`servo/core-foundation-rs`** — supplies `core-foundation`, `core-graphics`,
`core-text`, `io-surface`, and the older `cocoa` / `cocoa-foundation`. Two of
these are already here transitively (`core-foundation 0.10.1`,
`core-graphics 0.25.0`), and they are the right layer for CF/CG types — a
`CGFloat` or a colour — but they are **not** where AppKit views live. Its
`cocoa` crate is the old AppKit layer and carries the same objection as above.
Useful as a dependency we already have, not as the route to glass.

**But it must be called on the winit window, from inside the runtime crate.**
`tauri-runtime-blitz` stubs the Tauri-facing handle out:
[`window_dispatch.rs:213`](../../tauri-runtime-blitz/crates/tauri-runtime-blitz/src/window_dispatch.rs)
returns `Err(HandleError::NotSupported)` for `window_handle()`, and
[`runtime.rs:469`](../../tauri-runtime-blitz/crates/tauri-runtime-blitz/src/runtime.rs)
does the same for `display_handle()`. Calling `apply_liquid_glass` on a
`tauri::Window` from `az-gui` therefore fails with `NoWindowHandle`. The winit
`Window` implements the trait properly, so that is where the call goes — which
is another reason Glass cannot avoid touching that crate.

Its own documented requirements match the analysis above independently: the
window must be transparent, and the page must not paint an opaque root. Its
`macOSPrivateApi` note is a Wry concern and does not apply to this runtime.

`NSGlassEffectView` also wants to *own* its content (`contentView`), which suits
discrete controls better than a whole-window backdrop — worth knowing if the
crate's whole-window approach ever needs supplementing for individual chrome.

### 3. The surface composites opaque

`CompositeAlphaMode` exists but the app never selects a transparent mode. Until
it does, the renderer hands the compositor opaque pixels and a transparent
window shows black.

### 4. The app paints an opaque root

`tauri.conf.json` sets `backgroundColor: "#0a0b0d"`, and the theme paints opaque
surfaces down to the root. Every surface token is derived from `--az-surface`
with a hue and a lift ([`theme.css:228`](../gui/frontend/src/styles/theme.css)),
so "make the root transparent" is a theme-wide decision, not one declaration:
panels that currently sit on an opaque page would need their own alpha.

## Staged plan

Each stage is independently verifiable. Do not start the next before the current
one is proven, because failures here are all invisible in the same way: a black
window.

**Stage 0 — does the engine blur at all? Done. The answer was no, and is now
yes on the CPU renderer.** What follows is the original measurement, kept
because the reasoning was right and the conclusion in the last paragraph was
wrong.

`tests/blitz-tests/tests/backdrop_filter_blur.rs` puts a
`backdrop-filter: blur(12px)` panel across a hard black/white seam. A working
blur cannot leave either side pure. Measured: the pixel over the black half is
**`[0, 0, 0]`, unchanged**. The control test in the same file — the same fixture
with no panel — passes, so the fixture is sound and the property is a no-op.

That is confirmed by reading: `backdrop_filter` is used only to decide that a
layer is required ([`layers.rs:204`](../../ps-blitz/packages/blitz-paint/src/layers.rs))
and is then stored on the layer and never sampled. `blitz-dom` says as much in
passing, listing `backdrop-filter` among the properties it does not yet treat as
establishing a containing block
([`resolve.rs:751`](../../ps-blitz/packages/blitz-dom/src/resolve.rs)).

**So in-app glass is an implementation job in `blitz-paint`, not a wiring job.**

That last sentence was the wrong floor. `blitz-paint` was already correct: it
carries the filter down and the trace shows it arriving (`raw_len=1
converted=true`). The job was in the **renderer**, one layer lower, and the
first blocker was a cargo feature nobody had switched on. Four wrong causes were
announced before that was measured; the lesson is in
[`debugging.md`](debugging.md), not here.

`backdrop_filter_blur.rs` is now **green** — three tests. `hoisted_overflow_clip.rs`
is still deliberately red and must not be counted as passing.

Stages 1 to 4 are **all landed**; each heading below keeps the original
intent, and what actually happened is in
[Where this stands](#where-this-stands-2026-08-14).

**Stage 1 — honour `transparent`. Done.**
`window_attributes` gains `.with_transparent(config.transparent)`. Verify with a
window whose surface is cleared to zero alpha: the desktop should show through.
Expect black until Stage 2 lands, which is why they are adjacent.

**Stage 2 — transparent composite. Done.**
Select a non-opaque `CompositeAlphaMode` when the window is transparent, and
clear the surface to transparent rather than to `background_color`.

**Stage 3 — the effect view. Done, via `window-vibrancy` after all.**
Enable the `NSGlassEffectView` / `NSVisualEffectView` features on the
`objc2-app-kit` already in the graph, and insert the view behind the render
view on the winit window, from inside `tauri-runtime-blitz`. Gate on macOS 26
with a `NSVisualEffectView` fallback. Not callable from `az-gui` — see blocker
2. Read `window-vibrancy`'s macOS module first for the view-hierarchy details,
and fall back to depending on it if this fights winit.

**Stage 4 — theme. Done as three sliders, default-off.**
A `glass` theme mode where the root is transparent and panels carry their own
alpha. Keep the opaque theme as the default until the rest is proven; this is
the stage most likely to look wrong in a hundred small ways.

## The repository problem, settled

**Resolved by local `[patch]` entries**, the first option below. `.cargo/config.toml`
in both `agencyzero` and `ps-blitz` now redirects `ps-blitz`, `ps-anyrender` and
`tauri-runtime-blitz` to the checkouts beside them. Those files encode absolute
paths that exist on one machine, so they are **local only and must never be
committed**; every pinned rev in `Cargo.toml` is still the truth for anyone else.
The original reasoning follows.

### The original question

Stages 1–3 all live in **`tauri-runtime-blitz`**, and this app consumes it from a
**git rev** (`569870356`), not a path. Its local checkout at
`~/code/tauri-runtime-blitz` is on that exact commit but has a **dirty working
tree** (4 files, including `runtime.rs` and the control protocol) carrying
unrelated deep-profiling work.

So Glass cannot be implemented without either:

- adding a local `[patch]` for `tauri-runtime-blitz` — which pulls that dirty
  work into the binary along with the glass change, or
- committing or stashing that work first, or
- landing the glass change upstream and moving the pinned rev.

This was deliberately avoided during the 2026-08-13 bug session for exactly that
reason: patching it would have changed the binary under test. It is the first
question to settle before Stage 1.

## Risks

- **A black window is the failure mode for three separate stages.** Transparent
  window, opaque composite, opaque root all present identically. Change one
  thing at a time.
- **Blur is not free.** `backdrop-filter` forces a layer and a read of what is
  behind it, on every frame it is visible. This lands in the middle of the
  performance work, so measure it with the phase timings before and after rather
  than assuming it is a paint-only cost.
- **`titleBarStyle: Overlay` already claims the title bar.** The traffic lights
  sit over the tab strip today; glass changes what is behind them.
