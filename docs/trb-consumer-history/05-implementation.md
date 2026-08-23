# Implementation guide

Concrete steps for Stages 1, 1.5, and 2. Stage 1 was run on 2026-08-09; later-stage API names
are still from reading source and must be verified against the actual crates.

## Prerequisites

```sh
rustc --version    # must be >= 1.91.0 (blitz-rust workspace rust-version)
```

Repos, already in place:

- `~/code/blitz-rust` -- fork of DioxusLabs/blitz, on branch `js-engine` (PR #491 head)
- `~/code/agencyzero` -- the app
- `~/code/tauri-runtime-blitz` -- this repo

## Stage 1 -- Solid on Boa

### 1.1 Build the workspace

```sh
cd ~/code/blitz-rust
cargo build -p blitz-script 2>&1 | tail -40
```

Expect a long first compile: Stylo, Taffy, Parley, ICU4X, Boa. If Boa's `icu_normalizer`
conflicts with parley's, the branch's `Cargo.toml` already git-pins Boa to rev `8a1e8fe0` to
resolve it -- do not "fix" that pin.

### 1.2 Run the existing examples first

Do not write new code until the shipped examples work.

```sh
cd ~/code/blitz-rust
cargo test -p blitz-script --test dom
cargo test -p blitz-script --test preact
```

There is no `packages/blitz-script/examples/` directory at the checked-out PR head. The
executable Preact baseline is `packages/blitz-script/tests/preact.rs`; it loads the standalone
assets under `examples/preact/`.

Read `examples/preact/preact_dom_apis.md`, `react_dom_apis.md`, and `wpt_dom_apis.md` before
writing probes. They are the maintainer's own inventory of what is and is not covered.

Also read `packages/blitz-script/tests/` for the intended usage shape.

### 1.3 The Solid probe

Build a minimal Solid app the same way AgencyZero builds its frontend (rsbuild + Solid babel
plugin), so the output uses the same compiled-template form:

```tsx
import { render } from "solid-js/web";
import { createSignal, createEffect, For, Show } from "solid-js";

function App() {
  const [n, setN] = createSignal(0);
  const [items, setItems] = createSignal(["a", "b"]);
  createEffect(() => console.log("effect:", n()));
  return (
    <div class="root">
      <button onClick={() => setN(n() + 1)}>inc</button>
      <span>{n()}</span>
      <Show when={n() > 2}><p>over</p></Show>
      <For each={items()}>{(i) => <li>{i}</li>}</For>
      <button onClick={() => setItems([...items(), "c"])}>add</button>
    </div>
  );
}
render(() => <App />, document.getElementById("app")!);
```

Wrap the bundle in an HTML shell with `<div id="app">` and a `<script>` tag, then load it
through `blitz-script`'s document API (from the crate docs: `ScriptDocument::from_html(html,
config)` then `execute_scripts()` -- verify the real signature).

### 1.4 What to assert

Each of these is a separate signal, and they can fail independently:

| Check | Exercises |
|---|---|
| Initial render shows `0`, `a`, `b` | `template()` + `cloneNode` + `insert` |
| Clicking `inc` updates the span | signal -> DOM write path |
| `console.log` fires from the effect | `createEffect` scheduling / microtasks |
| `<Show>` appears past 2 | conditional insert/remove |
| Clicking `add` appends `c` | `<For>` reconciliation, `insertBefore` |
| Click handler fires at all | **event delegation** -- Solid attaches at the document root and relies on bubbling |

Event delegation is the one most likely to break and the most important. If direct listeners
work but delegated ones do not, check `bubbles` / `target` / `currentTarget` propagation in
`packages/blitz-script/src/dom/event.rs`.

Render to PNG with `anyrender_vello_cpu` to inspect output without a window.

### 1.5 Gate

Pass -> Stage 1.5. Fail on reactivity or delegation -> stop and report; that is
architectural, not a gap to fill.

### 1.6 Measured result (2026-08-09)

**PASS.** The initial source-level risks were real but bounded:

- `blitz-script` built successfully.
- Existing DOM tests passed (17 initially, 19 after the new regressions) and both Preact tests
  passed.
- Document delegation initially failed because `BaseDocument::node_chain` omitted the
  document node. Appending it made Solid's root `click` listener reachable without changing
  element bubbling behavior.
- Solid's compiled template path initially failed because `HTMLTemplateElement.content` was
  absent. Blitz already stored parsed template children on the template node; exposing that
  container unblocked clone-based templates.
- The AgencyZero-shaped Rsbuild/Babel/Solid probe passed initial render, signals,
  `createEffect`, `<Show>`, `<For>`, and delegated clicks.
- CPU rendering produced a 640x480 PNG with the final state (`3`, `effect:3`, `over`, and
  `a/b/c`). System fonts must be enabled; without `blitz-dom/system-fonts`, only the built-in
  bullet font renders.
- The full `blitz-script` suite passed with Python deliberately unavailable: 19 DOM tests, 2
  Preact tests, 1 Solid test, and 1 doctest.

Blitz commits: `8402481a` (Python-free Stylo pin), `c8363173` (Solid DOM support and probe),
and `80881334` (debug-control transport and the first separate-process gate).
Commit `17b2350f` adds synchronous and asynchronous remote JavaScript plus bounded console and
uncaught-error capture.
Commit `a79b9ba7` adds pointer-path event traces, focused text entry through Blitz's IME/input
path, and fixes empty inputs being initialized with a literal space.
This is a headless renderer result, not a `tauri-runtime-blitz` result.

## Stage 1.5 -- Reliable debug control

Implement and pass the minimum control-plane gate in `06-debug-control.md` before Stage 2.
Do not substitute shell logs, one-off JavaScript hooks, or screenshots without correlated DOM
and render revisions. The endpoint must remain usable when application JavaScript throws.

The first slice passed on 2026-08-09. A separate process discovered and authenticated the
Solid harness, found and measured the increment button, clicked it through pointer hit-testing,
waited for an idle CPU-painted frame, compared DOM state with a PNG, deleted and recreated its
session, then shut down cleanly without fixed sleeps. The transport also rejects non-loopback
binds, publishes a 0600 atomic descriptor, bounds command replies, and does not block when its
single renderer queue is full. Python was deliberately unavailable for the complete test run.

### Stage 1.5 measured result (2026-08-09)

**PASS.** Commit `30ffb7b9` completes the inspection/action surface and expands the external
test across every acceptance step in `06-debug-control.md`. It verifies the full Solid fixture,
computed style, layout and renderer metrics, pointer and keyboard actions, stale references,
changed screenshot pixels, runtime diagnostics, reconnect, and clean descriptor removal. The
complete suite passes with Python deliberately unavailable.

## Stage 2 -- CSS conformance

Stage 2 passed as a viability gate on 2026-08-09. See `07-css-conformance.md` for the two
1344×900 Chromium/Blitz comparisons, numerical thresholds, feature-by-feature results, and
bounded renderer gaps. The current compiled CSS counts are newer than the initial estimates
below.

### 2.1 Produce the corpus

```sh
cd ~/code/agencyzero/apps/gui/frontend
bun install && bun run build
ls ../dist/static/css/     # index.<hash>.css, ~144 KB
```

Two corpora:

1. `~/code/agencyzero/design/workspace.html` (214 KB) -- standalone design mockup, no build
   needed, easiest first target.
2. The real compiled CSS plus a DOM snapshot (dump `document.documentElement.outerHTML` from
   the running app in a browser).

### 2.2 Render and diff

Render each with `blitz-dom` + `anyrender_vello_cpu` to PNG. Screenshot the same input in
Chrome at identical viewport size. Diff.

**Do not eyeball this.** 150 rules are wrapped in
`@supports (color: color-mix(in lab, red, red))`, so an engine lacking `color-mix` silently
takes the fallback branch -- the page renders, in the wrong colours.

### 2.3 Report, per feature

Produce a table: feature, occurrences, renders correctly yes/no, owner. Priorities are
`color-mix()` (335), `oklch()` (43), `rgb(from ...)` relative colour (14), `@property` (71),
`mask-image` icons (228). See `03-gaps.md`.

The output is a work estimate for `@pathscale/ui` and `theme.css`, not a pass/fail. Both are
ours to change.

## Stage 3 notes

Run the real production bundle against `apps/gui/frontend/src/api/mock.ts`. No Tauri, no IPC --
the UI already runs headless against these.

Profile `features/project/MessageBody.tsx` specifically. It parses markdown with regex on
every message render, and regex is Boa's single weakest operation (47 vs 3941 against jitless
V8 on the V8 benchmark suite).

### Stage 3 measured result (2026-08-09)

**PASS.** The 581.7 KB JavaScript bundle built from AgencyZero commit `53d77c6` boots under
Blitz + Boa, selects the mock backend, hydrates all three fixture projects, reaches
`[az] boot: ready`, and reports no uncaught runtime errors. A debug-control pointer action on
the Settings button then advances document and paint revisions, renders the full Settings
screen, and still reports no runtime errors.

Blitz commit `ebb3caf0` adds the three browser APIs exposed by the real-bundle gate:
`Element.dataset`, `Element.classList`, and a cycle-aware `structuredClone` implementation for
ordinary structured data. It also lets the separate-process harness load an arbitrary document
through `BLITZ_DEBUG_DOCUMENT`. The complete `blitz-script` test suite passes with both
`PYTHON` and `PYTHON3` pointing to nonexistent executables. Clippy reaches an unrelated,
pre-existing `needless_return` warning in `blitz-dom/src/mutator.rs`; the Stage 3 changes add no
test failure.

## Stage 4 notes

Stage 3 passed on 2026-08-09. Order within Stage 4:

1. IPC bridge (unblocks everything else)
2. Windowing (winit vs tao)
3. Overlay title bar hit-testing
4. Menu passthrough

### Stage 4 checkpoint (2026-08-09)

- A signed, arm64, 32 MB CPU-rendered preview app launches the production bundle from
  `~/code/agencyzero-blitz`. It is intentionally mock-backed and visually exposes the Stage 2
  renderer gaps; launch passed, appearance did not.
- The preview can opt into the authenticated debug controller through the same environment and
  private descriptor contract as the headless harness. Normal Finder launches expose no port.
- The initial `tauri-runtime-blitz` crate preserves the real AgencyZero window configuration and
  connects Boa's `window.ipc.postMessage` host hook to Tauri's `WebviewIpcHandler`.
- `BlitzWebviewDispatcher` implements Tauri's `eval_script` and
  `eval_script_with_callback` surfaces through a thread-safe queue drained by the owning Boa
  document. A headless integration test dispatches a real `#[tauri::command]` `greet` through
  Tauri, serializes its response, evaluates the callback in Boa, and observes `Hello, Boa!` in the
  DOM.
- `prepare_pending_webview` consumes Tauri's pending initialization scripts and IPC handler,
  constructs the detached dispatcher, and attaches its queue to `ScriptDocument::poll`. Enqueuing
  work from another thread wakes the native event loop; the next document poll drains it before
  requesting a redraw.
- `BlitzRuntime`, `BlitzRuntimeHandle`, `BlitzEventLoopProxy`, and `BlitzWindowDispatcher` now form
  a concrete Tauri runtime. The main `PendingWindow` path creates its attached webview through
  `prepare_pending_webview`, maps the preserved AgencyZero window configuration to winit, and adds
  the document to `BlitzApplication` before the native loop starts.
- `agencyzero-blitz` 0.3.40 builds and signs through `tauri::Builder<BlitzRuntime>`. Its production
  frontend stays mock-backed through an empty `list_capabilities` response while a fixed status
  banner invokes the real Rust `greet` command. The final 39 MB binary has no WebKit, `libc++`, or
  Python load command.
- A minimal binary proved that published `tauri-runtime` adds an otherwise-unused WebKit load
  command on macOS. `-Wl,-dead_strip_dylibs` removes it without a Tauri fork; the committed link
  check fails on WebKit, `libc++`, or Python.

Next gate: owner-test the signed 0.3.40 preview and confirm its banner reports the real `greet`
response. Then restore debug control on the concrete runtime and implement standalone child
webviews before exposing the rest of AgencyZero's command table.

Reference implementation for the trait surface: `versotile-org/tauri-runtime-verso` (archived,
but it is the only prior art for a non-wry Tauri runtime). Pin an exact Tauri version;
`tauri-runtime`'s traits move between minor releases.
