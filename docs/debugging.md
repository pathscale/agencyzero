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

Blitz does not have WebKit, Chromium, CDP, or Web Inspector. Its **agent**
control plane is MCP over a mode-`0600` Unix socket using endpoint-libs framing.

There is also a **debug driver**, which this file used to deny the existence of:
it is an HTTP server, it is WebDriver-shaped, and it does have a token. It is
off unless `TAURI_BLITZ_DRIVER` is set, which is why it was easy to forget. See
"The debug driver" below, because it is the only surface that answers questions
about the real DOM.

There are three layers:

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

## The debug driver: real DOM, real geometry

Enabled by environment, never by default:

```sh
TAURI_BLITZ_DRIVER=127.0.0.1:0 \
TAURI_BLITZ_DRIVER_DESCRIPTOR=$PWD/target/blitz-driver.json \
  ./target/release/az-gui >/tmp/az.log 2>&1
```

The handshake is the part nobody remembers. **The token goes in a capability,
not a header**, and only one session may exist at a time: a session left open
by an earlier probe makes every later attempt answer `only one session is
supported`, which reads like a broken driver rather than a stale session.

```sh
A=$(sed -n 's/.*"address": "\([^"]*\)".*/\1/p' target/blitz-driver.json)
T=$(sed -n 's/.*"token": "\([^"]*\)".*/\1/p' target/blitz-driver.json)
S=$(curl -s -X POST -H 'content-type: application/json' \
     -d "{\"capabilities\":{\"alwaysMatch\":{\"blitz:token\":\"$T\"}}}" \
     http://$A/session | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
curl -s -X POST -H 'content-type: application/json' \
  --data-binary @script.json http://$A/session/$S/execute/sync
```

Three properties that have each cost time:

- `getBoundingClientRect` works. `getComputedStyle` does not.
- **Rects are physical pixels.** They are the CSS value times the window scale,
  so a `width: 270px` element measures 313.2 at 1.16x. Reading that as a layout
  bug cost a detour; check the scale before believing a discrepancy.
- Layout resolves on the frame loop, not synchronously. Set a style in one call
  and measure in a *later* one, or the rect is the previous frame's.

This is how the transcript spill was finally pinned: walking every element and
reporting any whose rect is wider than its parent's found 40 offenders and named
the element, after two hand-written fixtures had failed to reproduce it.

## When the app crashes or burns CPU

macOS has already written the answer down.

- **Crashes**: `~/Library/Logs/DiagnosticReports/az-gui-*.ips`, for every
  `SIGSEGV`, `SIGBUS` and abort. Match the report to the binary with
  `dwarfdump --uuid`; a mismatch means you are reading a different build.
- **A spin**: `sample <pid> 10 -file out.txt`. **An empty-looking profile is
  itself a finding**: a main thread in `__CFRunLoopDoTimers` and `mk_timer_arm`
  with no frame of ours means the event loop is failing to sleep rather than the
  app being busy. That was 76% of a core, misfiled for weeks as a frontend bug.
- **True CPU**: two `ps -o time= -p <pid>` reads a known interval apart.
  `ps %cpu` is a lifetime average and has raised a false alarm here before.

All three need symbols, so build unstripped. `CARGO_NET_GIT_FETCH_WITH_CLI` is
not optional on this machine: cargo's own git transport fails the TLS handshake
with `unexpected return value from ssl handshake -9847`.

```sh
CARGO_NET_GIT_FETCH_WITH_CLI=true \
CARGO_PROFILE_RELEASE_STRIP=false CARGO_PROFILE_RELEASE_DEBUG=1 \
  cargo build --release -p az-gui --features experimental,blitz-runtime,blitz-inspector
```

Release bundles ship unstripped with the inspector as of 0.6.3, so a report from
a user's machine names our functions too.

## Measuring the engine without the app

Prefer this to driving the app: it runs in about three seconds and needs no
window. The fixtures are the application's own transcript markup and its shipped
stylesheet, so the flex chains and percentage caps are the real ones.

```sh
cd ~/code/ps-blitz
cargo test -p blitz-tests --test transcript_frame_cost     --features counters -- --nocapture
cargo test -p blitz-tests --test transcript_scroll_cost    --features counters -- --nocapture
cargo test -p blitz-tests --test transcript_streaming_cost --features counters -- --nocapture
cargo test -p blitz-tests --test tab_switch_cost           --features counters -- --nocapture
```

`blitz-dom` exposes `layout_counters::last()` behind `log-phase-times`, which
`blitz-tests` surfaces as the `counters` feature. Use `last()` and not `take()`:
the per-frame printer takes the counters at the end of every resolve, so
anything else calling `take()` reads zero and looks broken.

**Do not measure with invented markup.** The fixture these replaced had no
`z-index` and no `position: fixed` anywhere, so it could not have caught a paint
regression in the very change it was being used to justify.

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
