# Plan

Cheapest-information-first. Each stage has a gate; do not start the next until the previous
passes. Stages 1 and 2 contain ~1 week of renderer viability work. Stage 1.5 is additional
control-plane work and is not included in that estimate.

## Stage 1 -- Does Solid run on Boa at all? (GATE, do first)

The architectural risk. Everything else is bounded work; this is not.

1. `cargo build` the `blitz-rust` workspace on branch `js-engine`.
2. Write a ~50-line Solid app: a signal, a `<For>`, a `<Show>`, a click handler, a
   `createEffect`. Build it with rsbuild the way AgencyZero does.
3. Run it under `blitz-script` headless. Render to PNG via `anyrender_vello_cpu`.

**Pass:** reactivity updates the rendered output; delegated events fire and bubble.

**Fail -> stop.** Solid's fine-grained reactivity not driving `blitz-dom` means the gap is
architectural, and we would be rewriting `blitz-script`, not extending it.

Why this should work: Solid has no VDOM and compiles to direct DOM calls. `blitz-script`
already implements the needed surface -- `template`/`cloneNode`, `createElement`,
`createTextNode`, `createComment`, `insertBefore`, `appendChild`, `removeChild`,
`replaceChild`, `setAttribute`, `className`, `textContent`, `style.setProperty`,
`addEventListener` with `bubbles`/`target`/`currentTarget`/`stopPropagation`.

## Stage 1.5 -- Can we control and diagnose it reliably? (GATE)

Add the debug-only control plane before the renderer becomes more complicated. It is a small
W3C WebDriver-compatible HTTP server owned by the Blitz runtime, plus `blitz:*` diagnostic
commands for DOM/layout snapshots, console and runtime errors, event tracing, renderer
metrics, and a deterministic settled-frame barrier.

**Pass:** an external process can discover and authenticate to the server, create a session,
find and interact with the Solid probe, wait for a committed frame, correlate DOM state and a
screenshot by render revision, retrieve a deliberate JavaScript exception, disconnect, and
reconnect.

**Fail -> stop and fix the control plane.** Do not continue into CSS and full-app work with
only screenshots and ad hoc log statements. See `06-debug-control.md` for the contract and
acceptance test.

## Stage 2 -- Does our CSS render? (GATE)

1. Build the AgencyZero frontend; take `apps/gui/dist/static/css/index.*.css` (144 KB).
2. Render it against a DOM snapshot, plus `design/workspace.html` (214 KB), which exists as a
   ready-made conformance corpus.
3. Screenshot-diff against Chrome/WebKit.

**Output:** a count of failing declarations. That number is the project size for
`@pathscale/ui`, not a pass/fail. See `03-gaps.md` for what we expect to break.

**Fail -> reconsider.** If the theme system does not resolve at all, the design-system work
dominates the engine work and the tradeoff changes.

## Stage 3 -- Full bundle headless

Run the real 542 KB bundle against `src/api/mock.ts` (1,037 lines of fixtures -- the UI
already runs headless). No Tauri, no IPC. Fix DOM gaps found in `03-gaps.md`.

**Pass:** the app renders and is interactive against mock data.

## Stage 4 -- tauri-runtime-blitz

Only now write the runtime. IPC bridge first (unblocks everything), then windowing, then
overlay title bar hit-testing, then menu passthrough.

**Pass:** AgencyZero launches on the Blitz runtime against the real Rust backend.

## Stage 5 -- Ship behind a flag

Cargo feature selects `tauri-runtime-wry` (default) or `tauri-runtime-blitz`. Both ship. Flip
per-platform when Blitz is good enough. No big bang, no rollback risk.

## Non-goals

- Mobile and web still use the platform engine. "Memory-safe rendering everywhere" is not
  reachable; "on desktop" is.
- Not porting the UI to Rust. Blitz-native (Dioxus RSX) was evaluated and rejected -- it is
  not Solid, and it would fork the UI against the multi-platform requirement.
