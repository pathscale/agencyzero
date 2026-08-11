# The animation gap: what is missing, what is not, and what to do

Written 2026-08-11, from reading this stack, Blink at
[`7e6a84f`](https://github.com/chromium/chromium/tree/7e6a84f5165fd617dbf3d032f755e11804bf8ff6),
and a survey of the Rust animation crate ecosystem. **Nothing here was measured.**

This is about the **Blitz engine layer plus this app's own UI**. The engine half applies
equally to chuzz, which has its own copy at `chuzz/docs/animation-gap.md` framed for a
browser, where the exposure is worse.

## What is not missing

Worth stating first, because it is the thing that invites a wrong move.

**We are not missing an animation engine.** There are already two drivers in this app:

- **CSS animations and transitions**, run by Stylo. `DocumentAnimationSet` lives at
  `blitz-dom/src/document.rs:218`, is ticked inside `resolve_stylist`, and sets
  `has_active_animations` at `blitz-dom/src/stylo.rs:171`.
- **A JavaScript driver**, already wired: `enablePopmotion(animate)` at
  [index.tsx:11](../apps/gui/frontend/src/index.tsx), because `@pathscale/ui`'s motion
  system snaps to its end state without one.

**There is no action item in that paragraph.** It is context, and its only purpose is to
stop someone adding a third driver in the belief that animation is unimplemented. It is
not. Animations work. The composer ring drift is proof: it animates correctly, and that is
exactly the problem.

## What is missing

A cheap frame.

| Step | Where |
|---|---|
| Any animation anywhere sets one document-wide boolean | `blitz-dom/src/document.rs:1640` `is_animating()`, OR-ing `has_canvas`, `has_active_animations`, `subdoc_is_animating`, custom widgets and scroll |
| While it is true, the shell requests the next frame unconditionally | `blitz-shell/src/window.rs:614` |
| Each frame repaints the whole visible tree | `blitz-paint/src/render.rs:113` |
| and re-renders and presents the whole window | `anyrender_vello/src/window_renderer.rs:423` |

Blink answers the same question with `CompositorAnimations::CheckCanStartAnimationOnCompositor`
([`compositor_animations.h:146`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/animation/compositor_animations.h#L146)),
returning a bitfield of **21 enumerated reasons** an animation cannot be accelerated
([`:70-143`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/animation/compositor_animations.h#L70)),
and a compositor to run the survivors on. We have a boolean.

Note also that `has_active_animations` is computed as
`sets.values().any(|state| state.needs_animation_ticks())` (`stylo.rs:171`): it is
**document-wide, with no viewport or offscreen gating in this path**. An animation on an
element scrolled far out of view still ticks and still drives full-window redraws.

## Why plugging in an animation library makes it worse

The instinct is to reach for a Rust or JS tweening crate. In this stack that is a
measurable downgrade, and the reason is in our own source.

Stylo's CSS animation path sets the **narrowest possible** restyle hint on animating nodes:

```rust
// blitz-dom/src/stylo.rs:100
self.nodes[node_id].set_restyle_hint(RestyleHint::RESTYLE_SELF);
```

A JavaScript-driven animation writes style through `set_attribute`
(`blitz-dom/src/mutator.rs:245`), which sets `RestyleHint::restyle_subtree()` on the node
(`:252`) **and again on the parent** (`:261`).

Same full-window frame cost either way, plus a subtree restyle on two elements that the CSS
path avoids entirely. **Animating from JavaScript is strictly more expensive than animating
from CSS here**, which inverts the usual web intuition.

## The survey, so it is not repeated

- **[AarambhDevHub/animato](https://github.com/AarambhDevHub/animato)** (33 stars,
  Apache-2.0, v1.7.2, active) says it plainly: "Animato never renders. Your application
  reads the computed value and applies it to a UI widget, game transform, DOM style..." A
  tweening library. Applying its output to DOM style lands on `set_attribute` above.
- **[joone/rust-animation](https://github.com/joone/rust-animation)** (31 stars, BSD-3,
  last pushed Feb 2026) is a scene graph **with its own wgpu renderer**. A second render
  pipeline, not a plugin for ours.
- **crates.io sweep**: `easer` (last updated 2022), `keyframe` (2022), `pareen`,
  `easing-function`, `animato-*`, `dioxus-motion`, `leptos_animation`, `bevy_tweening`,
  `bevy_tween` are all value interpolation. `animate*` (Ratatui), `spire_tween` (Godot),
  `plutonium_engine`, `shadowengine2d` belong to other engines. **Nothing in Rust does
  layerization, property trees or damage tracking as a reusable library.**
- **C or C++ to port**: what makes browser animation cheap is the compositor, which in C++
  means Chromium's `cc`, Blink's `PaintLayer`, or Core Animation. None is a small
  extractable library, and that scale is already ruled out in
  [why-not-webrender.md](why-not-webrender.md). ThorVG, rlottie and Rive are animation
  **content** players, useful if we ever ship a Lottie file, irrelevant to the cost of
  animating a DOM element.

## TODO

### 1. Clamp animation-driven redraw to a lower cadence ENGINE

- **Where:** `ps-blitz-render/packages/blitz-shell/src/window.rs:614`, the unconditional
  `self.request_redraw()` while `is_animating`.
- **What:** gate it on elapsed time since the last animation-only frame, so a decorative
  animation runs at 20 to 30fps instead of the display rate.
- **Why:** best value per line available. A 12 second ease is indistinguishable at 30fps,
  and the saving is 2 to 3x on every frame the animation would otherwise force.
- **Depends on:** nothing.
- **Verify:** `blitz-bench frames` with the composer focused, before and after. Confirm no
  visible stutter on a fast interaction, which is the risk: the clamp must not apply to
  input-driven frames, only to animation-only ones.
- **Size:** small. Also fixes chuzz, which needs it more.

### 2. Refuse animations that cannot change a pixel ENGINE

- **Where:** the animation tick path around `blitz-dom/src/stylo.rs:100`.
- **What:** Blink's `kAnimationHasNoVisibleChange`
  ([`compositor_animations.h:120`](https://github.com/chromium/chromium/blob/7e6a84f5165fd617dbf3d032f755e11804bf8ff6/third_party/blink/renderer/core/animation/compositor_animations.h#L120)):
  do not tick, and do not set `has_active_animations`, for an animation whose keyframes
  cannot produce a visual difference.
- **Why:** the generic form of the trick the composer ring already performs by hand when it
  drops `az-ring-drift` on blur.
- **Depends on:** nothing.
- **Size:** small to medium, and it needs care to avoid refusing something that does matter.

### 3. Write down "animate in CSS, never in JavaScript" APP

- **Where:** [AGENTS.md](../AGENTS.md), one line.
- **What:** state the rule and its reason, so nobody reaches for popmotion, animato or a
  `requestAnimationFrame` loop to animate a style.
- **Why:** the `RESTYLE_SELF` versus `restyle_subtree()` asymmetry above is invisible unless
  you have read `mutator.rs`, and the cost is silent.
- **Caveat:** `popmotion` is already wired for `@pathscale/ui`'s motion system
  (`index.tsx:11`) and should stay. This rule is about **new** animation work, not about
  ripping that out. If a `@pathscale/ui` component turns out to animate styles per frame
  through that driver, that is worth measuring separately before deciding anything.
- **Size:** trivial.

### 4. The real fix, recorded so this list is not mistaken for one

Damage regions, [partial-paint.md](partial-paint.md), with the amendment from
[webrender-good-design-to-review.md](webrender-good-design-to-review.md) section 1: treat
opacity and transform as **dependency values** rather than damage triggers, so a
compositable animation can eventually skip repaint entirely. That is the seam any future
compositor path needs, and items 1 and 2 are stopgaps until it exists.

## Related

- [blink-what-we-can-learn.md](blink-what-we-can-learn.md) section 3, the enumerated
  compositor-eligibility model.
- [partial-paint.md](partial-paint.md), why one animated element costs a whole frame.
- [dom-optimized-updates-for-solidjs.md](dom-optimized-updates-for-solidjs.md), the
  `restyle_subtree` fault that makes JS animation expensive.
- `chuzz/docs/animation-gap.md`, the same engine finding where the animations are authored
  by someone else.
