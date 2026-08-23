# Architecture and repo map

## How many repos

**One new repo. One fork. Two existing repos get changes. Zero Tauri forks.**

| # | Repo | Kind | Why |
|---|---|---|---|
| 1 | `tauri-runtime-blitz` | **new** (this one) | Implements Tauri's `Runtime` trait over Blitz. Standalone crate, sibling to `tauri-runtime-wry`. |
| 2 | `blitz-rust` | **fork** of DioxusLabs/blitz | Carries `blitz-script` (the Boa integration, PR #491) which is an unmerged draft. Also where we fix DOM gaps. Cloned at `~/code/blitz-rust`, branch `js-engine`. |
| 3 | `agencyzero` | existing, modified | Gains a cargo feature to select the runtime. No frontend changes expected. |
| 4 | `@pathscale/ui` | existing, modified | Blitz-compatible variants for the CSS features Blitz lacks (see `03-gaps.md`). |

**Not needed:**

- **No Tauri fork.** `tauri-runtime` (2.11.3, 24M downloads) is published and defines the
  traits. `tauri-runtime-wry` is one implementation; we write another. This is the same
  mechanism `tauri-runtime-verso` used for Servo.
- **No Boa fork initially.** Use the git pin the `js-engine` branch already declares
  (rev `8a1e8fe0`). Fork only if we need engine-level changes.
- **No Stylo / Taffy / Parley forks.** Consumed through Blitz.

## Crate boundaries

```
tauri (2.11.5)                     upstream, unmodified
  |
  +-- tauri-runtime (2.11.3)       upstream, trait definitions
        |
        +-- tauri-runtime-blitz    WE WRITE THIS
              |
              +-- blitz-dom        fork: rendering
              +-- blitz-paint      fork
              +-- anyrender_vello_cpu   CPU raster, no GPU driver (see 04-risks)
              +-- blitz-debug-control   WE WRITE THIS; debug-only automation server
              +-- blitz-script     fork: Boa DOM bindings  <- the risky dependency
                    |
                    +-- boa_engine (git pin)
```

`blitz-debug-control` is a logical boundary, not necessarily a separately published crate.
It owns the loopback WebDriver-compatible server described in `06-debug-control.md`. It must
talk to the renderer through a serialized command channel; the server thread must never touch
Boa, the DOM, layout, or paint state directly.

## What tauri-runtime-blitz must implement

Against `tauri_runtime`'s traits (`Runtime`, `RuntimeHandle`, `WindowDispatch`,
`WebviewDispatch`, `EventLoopProxy`):

1. **IPC bridge.** Inject a `@tauri-apps/api` shim into the Boa global scope so the frontend's
   `invoke()` reaches the 85 commands and `listen()` receives the 13 Rust->JS event channels
   (`message:appended`, `item:updated`, `pr:updated`, `project:updated`, `question:updated`,
   `project:created`, `item:created`, `app:restart-failed`, `task:started`, `task:finished`,
   `run:rate_limit`, `project:deleted`, `agent:io`).
2. **Windowing.** Blitz's shell is `winit`; Tauri's is `tao`. Reconcile, or drive
   `blitz-dom` directly under tao.
3. **Overlay title bar.** `titleBarStyle: "Overlay"` + `hiddenTitle: true`, with
   `data-tauri-drag-region` hit-testing walked from the webview
   (`apps/gui/frontend/src/features/tabs/TabStrip.tsx:109`). Needs hit-test plumbing.
4. **Native menu passthrough.** The existing `MenuBuilder` menu emits `menu:<id>` events;
   these should carry over unchanged if the event path works.
5. **Debug control.** A debug-only, loopback control server must remain reachable when app
   JavaScript fails. It exposes standard WebDriver operations plus Blitz-specific DOM,
   layout, console, error, and settled-frame diagnostics. This is a development requirement,
   not an optional post-port tool.

## Semver exposure

`tauri-runtime`'s trait surface is large and changes across Tauri minor releases. Pin to an
exact Tauri version and treat upgrades as deliberate work. `tauri-runtime-verso` was never
published to crates.io and tracked Tauri by hand -- expect the same.
