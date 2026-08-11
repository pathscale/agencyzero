# WebRender: what it would cost, and what to take from it instead

Written 2026-08-11. Facts about WebRender come from reading its manifests and build script
on `servo/webrender@main`, plus the crates.io and GitHub APIs, all fetched that day. Facts
about this stack are reads of local code with file and line. Two claims are marked as
recollection where they could not be verified from a manifest. **No integration was
attempted and nothing here was benchmarked.**

[partial-paint.md](partial-paint.md) names WebRender as the best design in existence for
damage-region rendering of document-shaped content. This document answers the obvious
follow-up: could we just use it?

Short answer: no, and the blocker is not effort. It is OpenGL. The design is still worth
mining, which is what partial-paint.md already does.

## Which WebRender

Three repositories, three hops apart, and it matters which one anyone reads.

| | Canonical | [servo/webrender](https://github.com/servo/webrender) | [zng-ui/zng-webrender](https://github.com/zng-ui/zng-webrender) |
|---|---|---|---|
| What | `gfx/wr` in the Firefox tree | downstream mirror | fork of the mirror |
| Commits | upstream of both | 11,052 | 4,575 on its branch |
| Stars | n/a | 3,371 | 1 |
| crates.io | `webrender` **0.70.0**, 10 Jul 2026, ~124k recent downloads | same crate | `zng-webrender` **0.68.4**, 8 Jun 2026, 37.5k all time |

Patches land in mozilla-central and are mirrored to `servo/webrender`; Servo-specific
changes may be taken directly there. `zng-webrender` exists so the
[zng](https://github.com/zng-ui/zng) GUI framework could publish prefixed crates and carry
early patches, and its own `FORK.md` says that since 0.22 it prefers depending on the
original crates where feasible. Since `webrender` itself is now published to crates.io,
the fork's original reason has largely expired. It sits two minor versions behind.

**Read the canonical tree or the Servo mirror. Never the fork.**

**Licensing.** WebRender is MPL-2.0, which is file-level copyleft. Reading it for design
carries nothing. Vendoring its files into this repository would keep those files MPL and
require publishing modifications to them, which is a different obligation from the rest of
the Blitz stack. Reimplement the idea; do not paste the implementation.

## Does it hide C++ or system dependencies

Yes, though not in the shape WebKit does. WebKit is a large C++ runtime you link against.
WebRender is Rust that **compiles a large C/C++ codebase at build time** and calls
platform font frameworks at runtime.

### Build time, unconditional

`webrender/build.rs` optimizes every shader through `glslopt`, and it is not behind a
feature or a cfg:

```rust
let glslopt_ctx = glslopt::Context::new(target);
let output = glslopt_ctx.optimize(shader_type, shader_src.clone());
```

[glslopt](https://github.com/jamienicol/glslopt-rs) wraps the Mesa-derived GLSL optimizer:
roughly **64,000 lines of C++, 13,000 lines of C and 39,000 lines of C headers**, compiled
before WebRender itself compiles. Every build, every machine, every CI runner. The build
script also carries the comment "glsopt is known to leak, but we don't particularly care",
which is correct for a build tool and tells you what kind of component it is.

### Build time, optional

`swgl`, the software OpenGL backend, has `cc` and `glsl-to-cxx` as build dependencies: it
translates GLSL to C++ and compiles it. Optional, and avoidable on macOS if a real GL
context is used. `mozangle` (ANGLE, a very large C++ project) appears only in
dev-dependencies, so tests and `wrench` pull it and a consuming build does not.

### Runtime, per platform

From `wr_glyph_rasterizer/Cargo.toml`:

- **macOS and iOS**: `core-foundation`, `core-graphics`, `core-text`, `objc`. System
  frameworks, no build-time compile. This is the good case and it is our platform.
- **Linux and Android**: `freetype`, default feature `static_freetype`. C library, built
  or linked.
- **Windows**: `dwrote`, DirectWrite.

`gleam` is generated Rust OpenGL bindings, so it is not itself a C dependency, but it
implies a live OpenGL context, which leads to the actual blocker.

## The blocker: it is OpenGL only

The README says WebRender "currently uses the OpenGL API internally". `gleam` is a
non-optional dependency, and `build.rs` targets "either OpenGL or OpenGL ES 3.0". There is
no Metal backend and no wgpu backend.

This stack is wgpu to Metal, chosen explicitly in
[blitz-performance-architecture.md](blitz-performance-architecture.md) so that Vulkan and
D3D12 stay reachable later. Adopting WebRender means re-platforming the renderer onto
OpenGL, on macOS, which is where this product ships first.

*Recollection, not verified from a manifest:* Apple deprecated OpenGL in 10.14 and caps it
at 4.1, and Firefox on macOS runs WebRender over GL or its software backend rather than
Metal. If that is right, adopting WebRender trades a current graphics API for a deprecated
one on the primary target platform, which is a strategic step backwards even where it is a
performance step forward. Worth confirming before anyone argues from it.

## How much work

Servo is the existence proof that WebRender is consumable outside Gecko, so the honest way
to size this is to measure Servo's integration. Two layers, both fetched 2026-08-11:

**Display list building**, `components/layout/display_list`, 9 files, ~275 KB of Rust:

```
mod.rs 105K   stacking_context.rs 55K   paint_traversal.rs 26K   gradient.rs 24K
hit_test.rs 19K   background.rs 16K   clip.rs 14K   conversions.rs 8K   ...
```

**Compositor integration**, `components/paint`, ~240 KB of Rust: `painter.rs` 62K,
`webview_renderer.rs` 48K, `paint.rs` 38K, plus pinch zoom, refresh driver, external
images and screenshots.

**Servo is the expensive end of the range, and it is not the only data point.** zng
translates its own display-list IR into WebRender in **1,291 lines**
(`zng-view/src/display_list.rs`), because it starts from an IR rather than lowering from a
box tree. Sizing this work from Servo alone overstates it. The blocker below is not effort
in any case: WebRender's display list has **no path or polygon fill item**, only
`ImageMaskClip` and blob images, so a path-shaped sink like `anyrender` cannot be
translated to it without rasterizing paths to masks first. See
[GPUI-and-zng-what-we-should-learn.md](GPUI-and-zng-what-we-should-learn.md#5-a-display-list-ir-is-the-right-boundary-and-we-already-have-one).

For comparison, all of `blitz-paint` is 5,728 lines. Servo's file names mirror ours almost
exactly (`background.rs`, `clip.rs`, `gradient.rs`), and the equivalent layer is **larger**
than what we have, not smaller. The intuition that a CSS-shaped display list means less
code does not survive contact with stacking contexts, clip and scroll trees, and hit
testing.

What would have to change here:

1. **Rewrite the paint layer** against `DisplayListBuilder` instead of
   `anyrender::PaintScene`. Different vocabulary: push_rect, push_border, push_box_shadow,
   push_text, stacking contexts, clip chains.
2. **Add a GL context and surface** on macOS, replacing wgpu's Metal surface. Servo uses
   surfman for this.
3. **Adopt WebRender's threading and transaction model**: a scene builder thread, a render
   backend thread, and an API-plus-transaction protocol, in place of today's synchronous
   `resolve` then `paint_scene` then `render` inside one frame callback.
4. **Re-plumb fonts**: register font templates and instances, hand WebRender glyph indices
   and positions. Parley already produces those, so the mapping exists, but glyph
   rasterization moves from the current path to CoreText, which is a visual change needing
   verification.
5. **Move image and resource handling** onto WebRender's keyed resource cache.
6. **Give up the anyrender abstraction** and everything standing on it: the vello, vello_cpu,
   vello_hybrid and skia backends, the hybrid comparison in [performance.md](performance.md),
   `blitz-bench`, and the inspector's per-frame stats, which would need rebuilding against
   WebRender's own profiler.

Deleted in exchange: `ps-anyrender`, `wgpu_context`, the intermediate-texture blit. Real,
but a smaller thing replaced by a much larger one.

7. **Maintenance**: the canonical home is mozilla-central, so any fix we need goes through
   Mozilla's tree or a fork we carry. `zng-webrender` is the cautionary example of that
   path: created Dec 2023, now two minor versions behind, one star.

## What is genuinely better about it

Not a small list, and this is the part worth acting on.

- **Picture caching and tile damage.** Exactly what [partial-paint.md](partial-paint.md)
  proposes to build, already built, and shipping to hundreds of millions of Firefox
  installs. Display list rebuilt cheaply each frame, rasterization cached in tiles keyed by
  their dependencies.
- **Interned, cached expensive primitives.** A box shadow is keyed by its parameters and
  the blurred result is shared by every primitive with the same shadow, produced once by a
  two-pass separable blur render task. Our theme applies a handful of shadows to many
  elements and recomputes each one every frame.

  An earlier revision of this document claimed a CSS-shaped display list would collapse
  "roughly 2,600 lines of bezier lowering" here. **That was wrong.** Measuring both sides
  shows WebRender's border code is larger than ours (1,863 lines against 641), and two of
  the three files cited were never path lowering at all: `box_shadow.rs` calls a native
  `draw_box_shadow` command and `gradient.rs` produces native `peniko::Gradient` brushes.
  The measurement is in
  [webrender-good-design-to-review.md](webrender-good-design-to-review.md#5-css-shaped-primitives-and-a-correction).
- **A spatial tree with real scroll frames**, so scrolled content composites without
  re-rasterizing. partial-paint.md's stage 1 has to treat scroll as full-window damage
  precisely because we have no equivalent.
- **Native OS compositor surfaces**, so video and animation layers can be handed to
  CoreAnimation instead of being redrawn.
- **Platform glyph rasterization** through CoreText, which matches native text exactly.
  [blitz-performance-architecture.md](blitz-performance-architecture.md) makes
  browser-quality text a correctness requirement, and this is the shortest path to it.

## Verdict

Do not adopt it. The OpenGL constraint alone decides it, and the integration cost is a
re-platform rather than a port. Keep doing what partial-paint.md already does: read it as
the reference design, reimplement the ideas, cite it at the site.

Two items on that list are worth pulling forward as ideas rather than code, independently
of the damage work:

- **Scroll as a spatial concept** rather than a full-window repaint, once damage regions
  exist at all.
- **Interning and caching of blurred shadows**, which is self-contained, needs no new
  dependency, and does not wait on the damage work.

The specific code worth reading for each of these, with pinned line references and a
side-by-side against ours, is in
[webrender-good-design-to-review.md](webrender-good-design-to-review.md).

Revisit only if the Vello path is measured and found unable to reach acceptable frame
cost, **and** somebody is willing to own an OpenGL renderer on macOS.

## Related

- [partial-paint.md](partial-paint.md) for the damage-region design WebRender is the
  reference for.
- [blitz-performance-architecture.md](blitz-performance-architecture.md) for the wgpu
  decision this document is tested against.
- [performance.md](performance.md) for the measurements that make the renderer the
  interesting layer at all.
