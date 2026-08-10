# Debugging AgencyZero desktop runtimes

AgencyZero has two Tauri runtimes. They use the same Solid frontend and Rust
commands, but they do not use the same renderer or debugging tools:

| Runtime | Build | Bundle identifier | Data profile | Primary debugger |
| --- | --- | --- | --- | --- |
| Tauri/Wry (WebKit) | `cargo tauri dev --config tauri.dev.conf.json` | `com.pathscale.agencyzero.dev` | Dev | Web Inspector and `az-gui.log` |
| Tauri/Blitz | `scripts/local-delivery.sh blitz-debug` | `com.pathscale.agencyzero` | Standard | Blitz loopback control and `az-gui.log` |
| Tauri/Blitz Experimental | `scripts/local-delivery.sh experimental` | `com.pathscale.agencyzero.experimental` | Experimental | `az-gui.log`; rebuild with inspector only when that profile is safe |

Do not infer the runtime from the app name or an old `/Applications` copy. The
Settings build stamp says `wry` or `blitz`, and the first `boot` lines in the
profile log record the version, Git SHA, build time, and profile.

Never run two processes against the same profile. The normal profile is a safe
Blitz debugging target only while the owner is using Experimental; reverse the
choice when the owner is using normal AgencyZero.

## Shared first checks

Frontend-only work is fastest in fixture mode:

```sh
cd apps/gui/frontend
bun run dev
```

For a desktop failure, inspect only the active profile log:

```sh
tail -n 200 "$HOME/Library/Application Support/com.pathscale.agencyzero.dev/logs/az-gui.log"
tail -n 200 "$HOME/Library/Application Support/com.pathscale.agencyzero/logs/az-gui.log"
tail -n 200 "$HOME/Library/Application Support/com.pathscale.agencyzero.experimental/logs/az-gui.log"
```

Idle logs should be mostly quiet. A repeating IPC command is usually an app
effect or timer loop, not renderer cost. For example, a `set_settings` call
every 250–300 ms identifies preference autosave churn and continuously performs
serialization and persistence.

Use a tight loop while repairing a bug:

1. Run the smallest test that exercises the changed module.
2. Rebuild only the affected runtime.
3. Reproduce once and inspect the new log/control evidence.
4. Repeat. Run the full delivery gate once, before delivery—not after every edit.

## Old Tauri: Wry/WebKit

Run the isolated Dev identity directly from source:

```sh
cd apps/gui
cargo tauri dev --config tauri.dev.conf.json
```

No Blitz feature should be present. This path uses Wry/WebKit, the Dev profile,
and the frontend development server. Use WebKit's Web Inspector for DOM, CSS,
console, network, and JavaScript profiling. Use the Dev `az-gui.log` for Rust
boot failures, command latency, sidecar activity, and persistence work.

For a delivery-shaped Wry bundle, use:

```sh
scripts/local-delivery.sh dev
```

That command is a full delivery gate and writes
`target/release/bundle/macos/AgencyZero Dev.app`; it is not the edit/rebuild
loop. A bundled app may not expose Web Inspector, so prefer `cargo tauri dev`
until the bug requires release-mode behavior.

## New Tauri: Blitz

Blitz does not have WebKit, Chromium, CDP, or Web Inspector. Its local control
plane is MCP over a mode-`0600` Unix socket using endpoint-libs framing. It has
no HTTP server, WebDriver session, bearer token, or authentication handshake.

There are two layers:

- **Agent control** is compiled into normal Blitz builds but starts disabled.
  Settings → Local Blitz control is the owner authority. Off means no socket
  and no discovery descriptor. It exposes semantic inspection, click,
  set-value, scroll, physical input, quit, and relaunch. AgencyZero delegates
  relaunch to its existing Angel restart supervisor.
- **Diagnostics** is additionally compiled by `blitz-inspector`. It exposes
  settled DOM semantic snapshots, layout bounds, revision/idle responses,
  on-demand stage timings, and resident memory. It remains unavailable in an
  ordinary `blitz-runtime` build even when agent control is enabled.

Build a stable-profile inspector incrementally with:

```sh
scripts/local-delivery.sh blitz-debug
```

`blitz-debug` intentionally skips the workspace-wide test and lint gate. It
runs the frontend production build and incrementally rebuilds the stable Blitz
bundle with `blitz-inspector`, publishing the signed result at:

```text
target/release/bundle/macos/AgencyZero.app
```

For the isolated Experimental profile use the equally incremental command:

```sh
scripts/local-delivery.sh experimental-debug
```

It publishes the signed bundle at:

```text
target/release/bundle/macos/AgencyZero Experimental.app
```

Quit the existing process for that profile first. Both old and new local builds
may report the same app version, so always restart the canonical bundle path,
not an `/Applications` copy or the target-triple intermediate. To make the
descriptor location deterministic, launch through LaunchServices with:

```sh
open -n \
  --env TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json" \
  "$PWD/target/release/bundle/macos/AgencyZero.app" \
  --args --blitz-control
```

Do not execute `Contents/MacOS/az-gui` directly. On current macOS that process
can abort inside AppKit application registration; LaunchServices may then open
a replacement process without the environment, which looks healthy but never
publishes the descriptor.

Enable Settings → Local Blitz control after launch. The descriptor is mode
`0600` and contains the PID, `unix://` socket address, protocol version,
instance id, and renderer revision. The server accepts multiple local clients.

Clients speak MCP JSON-RPC (`2025-06-18`) over endpoint-libs framed text:

1. `initialize`
2. optional `notifications/initialized`
3. `tools/list`
4. `tools/call`

`blitz.agent.control` accepts `inspect`, `act`, `relaunch`, and `quit` commands.
An inspector build also advertises `blitz.diagnostics`, whose implemented
commands are `snapshot`, `metrics`, and `waitForIdle`. Diagnostic stream
subscriptions and computed-style snapshots currently return explicit
unsupported errors rather than fabricated data.

Correlate metrics with IPC durations in `az-gui.log`. Use Instruments for
native stack and CPU attribution when needed; macOS may reject `sample <pid>`
for a signed GUI process without additional debugging privileges. Do not
escalate with `sudo` silently.

## Build and signing traps

The target-triple bundle is an intermediate Tauri output. The local delivery
script moves it to the canonical `target/release/bundle/macos` path only after a
successful build.

Do not pass `--no-sign` for a macOS app bundle. The project config uses the `-`
ad-hoc identity; allowing Tauri to sign writes `_CodeSignature/CodeResources`
and signs both executables plus the bundle. A partially signed bundle can contain
an executable and still fail to open with `kLSNoExecutableErr`; `codesign`
reports `code has no resources but signature indicates they must be present`.

Validate a local bundle before debugging its runtime:

```sh
codesign --verify --deep --strict --verbose=2 \
  target/release/bundle/macos/AgencyZero.app
```

Use `scripts/local-delivery.sh stable` or `experimental` only for the final
delivery-shaped gate. Both run the complete frontend and Rust checks before
building; neither includes diagnostics. Use `blitz-debug` or
`experimental-debug` for the fast inspector loop.
