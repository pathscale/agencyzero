# Driving the app from outside

> An untracked `docs/HANDOVER.md` may sit beside this file with the operating
> context: repository wiring, what is in flight, and which surface answers which
> question. Not committed, because it is about a session rather than the repo.

How to inspect, operate and measure a running AgencyZero without touching the
keyboard. Written for an agent: everything here is reproducible from a shell,
and none of it needs a human to scroll or click.

The point is that a measurement nobody can reproduce is an anecdote. Drive a
fixed interaction, read the numbers, change one thing, drive it again.

## Verify here, not in a browser. Read this before reaching for :3010

The frontend also runs standalone against a mock on port 3010
([ui-verification.md](ui-verification.md)), and that surface answers exactly one
question: **does the markup come out right.** It cannot answer anything else,
and reaching for it out of habit has cost real time.

- **It proves nothing about performance, ever.** The browser runs V8 and a real
  DOM. The app runs Boa and `blitz-dom`. V8 has cons strings and Boa does not,
  which is the entire subject of
  [js-engine-big-problem.md](js-engine-big-problem.md); a string benchmark in a
  browser measures a rope that does not exist in the shipping engine.
- **The mock does not stream, by design.** `src/api/mock.ts` emits no `run:text`
  and no `run:accepted`; [client.ts:419](../apps/gui/frontend/src/api/client.ts)
  says so and says why — "which is correct — it fakes no run." So nothing in the
  streaming path can be exercised there, and two attempts to drive a streaming
  reply through it failed for that reason while looking like a driving problem.
- **Its projects are fixtures, not your data.** `api.support.cafe`, `WorkTable`
  and the rest in `src/api/fixtures.ts` exist to exercise UI shapes. Carrying one
  of those names into a statement about the running app is how a mock fixture
  gets reported as a real project.
- **jsdom is the same trap one level down.** A vitest benchmark measures the
  function, which is worth having, but it is not the application.

So: correctness of rendered markup, the mock or jsdom. **Anything with a number
attached, the real app through `blitz-bench`.** Launch it, attach, drive a fixed
interaction, read the metrics:

```bash
scripts/local-delivery.sh quick
open target/release/bundle/macos/AgencyZero.app
cargo run -q -p blitz-bench -- frames
```

Four rules that each cost a session to learn:

1. **`BENCH_PACE=0` or the number is about the harness.** `scroll` and `type`
   sleep 1/60s between events by default, so the reported fps and
   `missedRefreshes` describe the bench. Unpaced this app does 120fps with zero
   missed refreshes; paced it reads 53 and looks broken.
2. **Take three runs and discard the first.** The first interaction after a
   launch is cold and reads several milliseconds high.
3. **Check the instrument exists before building one.** Twice the timer being
   written already existed two crates away. `cargo tree -e features -i <crate>`
   when a feature looks like it is not compiled in, because `ps-anyrender-vello`
   reaches the app through `tauri-runtime-blitz` rather than `ps-blitz-shell`.
4. **Layer counts ride the frame log, not the MCP surface.** `target/blitz-frame.log`,
   `layers_by_site=...`. Delete it before a run worth reading.

## Two surfaces, and which one you want

| | Agent level | Debug level |
|---|---|---|
| Transport | Unix socket, MCP over framed JSON | TCP, WebDriver-shaped HTTP |
| Enabled by | `blitz-inspector` feature (in `stable` builds) | `TAURI_BLITZ_DRIVER` env |
| Tools | `blitz.agent.control`, `blitz.diagnostics` | `/session/{id}/{command}` |
| Use it for | **Metrics, inspection, input** | Elements, `execute/sync`, screenshots |

**Performance work uses the agent level.** The debug driver has no perf routes.

Known broken: the debug driver's `screenshot` route returns an identical image
regardless of build. Three different builds produced the same SHA256. Do not use
it to judge visual correctness.

## Local development mode

**Default to this while iterating. Build a bundle only when asked for one.**

```sh
scripts/local-delivery.sh quick
```

Under a minute against several, and the difference is the test gate and
bundling, neither of which can change what the binary does. It builds the
frontend dist and `az-gui`, drops the binary into the bundle already at
`target/release/bundle/macos/AgencyZero.app`, and re-signs.

The dist is built rather than assumed, and that is not optional: Tauri embeds
it into the binary at compile time, so a Rust-only rebuild would silently ship
whatever `dist` last happened to hold, and a frontend change would appear to
have no effect.

Everything else in the bundle is invariant. The `agency-proxy` sidecar is
untouched and `Info.plist` keeps the `LSEnvironment` block that `stable`
pinned, so the control descriptor and the frame log survive a swap.

Two conditions on it. It needs a bundle to exist, so run `stable` once after a
clean checkout, and it runs no tests, so `verify` or `stable` before anything
leaves the machine. Replacing a binary invalidates the bundle signature and
macOS then refuses to launch it at all, which is why the re-sign is part of the
mode rather than something to remember.

A measure-fix-measure cycle is: `quick`, quit the app, `open` it, take the
reading. Rebuilding both bundles for each turn of that loop is the slow way to
answer a question that a binary swap answers identically.

**Launch it by path. Nothing here ever installs to `/Applications`.**

```bash
open /Users/revenge/code/agencyzero/target/release/bundle/macos/AgencyZero.app
```

There are separate copies in `/Applications` that this script never writes to
and must not. Opening "AgencyZero" from Spotlight, the Dock or Finder starts
one of those instead, and no build made here will ever reach it — which reads
as a build that silently did nothing.

Settings shows the version, the commit and the build time, and that is how to
tell which one is running. Quit with `kill -TERM`, never a forced kill and not
the AppleScript quit: `apps/gui/src/main.rs:2307` routes SIGTERM, SIGINT and
SIGHUP to a graceful shutdown, and the WorkTable store is single-writer.

## Launching

```sh
scripts/local-delivery.sh stable        # full gate, builds with blitz-inspector
```

```sh
open -n /Users/revenge/code/agencyzero/target/release/bundle/macos/AgencyZero.app
```

**No `--env` is needed any more.** `local-delivery.sh stable` writes
`BLITZ_INCREMENTAL` and `TAURI_BLITZ_CONTROL_DESCRIPTOR` into the bundle's
`Info.plist` under `LSEnvironment`, which launchd applies to every way the app
can start, then re-signs the bundle.

That replaces `open --env`, which reached neither launch that matters: a Finder
launch, and the restart angel re-executing the binary after a rebuild (see
[angel-restart.md](angel-restart.md)). Both start the process without the shell
environment, the descriptor then lands in
`$TMPDIR/tauri-blitz-agent/<instance>.json`, and tooling attaches to whichever
stale file sorts last, which is how a probe ends up reading a dead pid.

If you launch some other way, set the two variables yourself and check the `pid`
in the descriptor against `pgrep` before trusting any number. Running the binary
directly is also useful, because it is the only way to see `log-phase-times`
output, which goes to stdout and is discarded by a Finder launch:

```sh
BLITZ_INCREMENTAL=1 \
TAURI_BLITZ_CONTROL_DESCRIPTOR=/Users/revenge/code/agencyzero/target/blitz-control.json \
  target/release/bundle/macos/AgencyZero.app/Contents/MacOS/az-gui > phases.log 2>&1 &
```

Those lines are what attributed the typing cost to taffy:
`Resolve(1): 18ms (style: 167us, damage: 84us, ..., layout: 18ms, ...)`.

**Never edit a built bundle's `Info.plist` without re-signing it.** It
invalidates the ad-hoc signature and macOS then refuses to launch the app: `open`
fails with `-54` and nothing starts. `codesign --force --sign - --options runtime
<bundle>` repairs it.

Add the debug driver only if you need `execute/sync` or element queries:

```sh
  --env TAURI_BLITZ_DRIVER=127.0.0.1:0 \
  --env TAURI_BLITZ_DRIVER_DESCRIPTOR=/Users/revenge/code/agencyzero/target/blitz-driver.json \
```

**Do not `pkill -f "AgencyZero.*az-gui"`.** That pattern also kills
`AgencyZero Experimental.app`, which is somebody's working instance. Match the
exact bundle path instead:

```sh
pkill -f "macos/AgencyZero.app/Contents/MacOS/az-gui"
```

## The ready-made tools

```sh
cargo run -q -p blitz-bench -- frames    # one-shot metrics read
cargo run -q -p blitz-bench -- tree      # semantic tree
BENCH_PACE=0 cargo run -q -p blitz-bench -- scroll 200 -100   # driven scroll, then metrics
cargo run -q -p blitz-bench -- type 20   # driven typing, cost per keystroke
cargo run -q -p blitz-bench -- nodes     # tree size and role histogram
```

`blitz-bench` speaks the protocol through
[`blitz-control-protocol`](../../tauri-runtime-blitz/crates/blitz-control-protocol),
which is the **server's own** definition of the wire rather than a second copy
of it. That is not tidiness: the Python hand-wrote this JSON and got the
adjacent tagging of `AgentAction` wrong, which presented as a hung app, and its
`tree` mode sent `maxDepth` where the server wants `max_depth` and had been
answering `invalid debug frame` rather than a tree. Both are now compile errors.
The tool stays out of the Tauri dependency tree on purpose: 48 crates against
the gui's 650, so measuring never means building a renderer.

`type` focuses the first visible text field, drives real key events, and reports
the **delta** in script attribution across the run rather than the totals. Use it
for anything that measures geometry after mutating: scrolling never touches the
composer's autosize path, which is where the per-keystroke cost lives. Pass a
substring as the second argument to pick a specific field, for example
`type 20 "Ask, or type"`.

Attribution is cumulative since launch, so only the delta describes the
interaction. `poll_hook` in a delta is the observer's own cost, because reading
metrics polls the script loop; it is labelled as such in the output.

`BENCH_PACE` is the delay between driven events. **Leave it at 0 when measuring a
ceiling**: the default paces at 1/60s, and the reported frame interval then
describes the harness rather than the application. That mistake produced
"49fps" on a build that actually did 308fps.

## The wire, if you are writing your own client

Frames are length-prefixed: 4-byte big-endian length, then a kind byte (0 for
text), then JSON. Not newline-delimited, which is why a naive socket read hangs.

Requests are JSON-RPC. Tool calls look like:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"blitz.diagnostics","arguments":{"command":"metrics"}}}
```

**Field naming is inconsistent and will cost you half an hour.** The frame
wrapper is camelCase (`requestId`), but fields *inside* protocol variants are
snake_case (`max_depth`, `delta_y`, `node_id`), because `rename_all` on those
enums renames the variants, not their fields.

A wrong name used to produce a silent timeout. The server did answer, with
`id: null`, and a JSON-RPC client matches responses by id, so a correct error
was delivered and then discarded while the caller blocked forever. Getting one
field wrong therefore presented as a hung application. The id is now recovered
from the frame before the typed decode consumes it, so **a malformed request
comes back as an error naming the field.** If you are talking to an older build,
that is not a hang.

The other half of this trap is nesting. `AgentAction` is adjacently tagged
(`tag = "action", content = "params"`), so a variant's own fields sit under
`params`, and `Input` nests a second `params` inside that. The examples below
are correct; copy them rather than reconstructing them.

### The calls worth knowing

Inspect the tree. Returns `id`, `parent`, `role`, `name`, `bounds` per node:

```json
{"name":"blitz.agent.control",
 "arguments":{"command":"inspect","params":{"root":null,"max_depth":40}}}
```

Click a node by id from that tree:

```json
{"name":"blitz.agent.control",
 "arguments":{"command":"act","params":{"action":"click","params":{"node_id":349}}}}
```

Scroll. Note the doubly nested `params`, which is the adjacent tagging of
`AgentAction` wrapping `InputCommand`:

```json
{"name":"blitz.agent.control","arguments":{"command":"act","params":{
  "action":"input","params":{"input":"wheel","delta_x":0.0,"delta_y":-100.0,
  "phase":"moved","modifiers":{"shift":false,"control":false,"alt":false,"meta":false}}}}}
```

Read metrics:

```json
{"name":"blitz.diagnostics","arguments":{"command":"metrics"}}
```

Also available: `observe` with `{"streams":["metrics","console","runtimeErrors"]}`
for a pushed stream, `waitForIdle`, and `snapshot`.

## Reading the metrics honestly

- `frameWindow` carries `resolve`, `scene`, `renderer`, `total` and `interval`,
  each with mean, p95 and max. **Read the tail, not the mean.** One 200ms frame
  in sixty disappears into an average and is exactly what a user notices.
- `script` is JavaScript cost per `ScriptDocument::poll`, with `breakdown`
  attributing it by event name, timer, startup or DOM call.
- `snapshot` is the cost of the observer, reported separately on purpose.
- `queueDepth`, `styleMs`, `layoutMs`, `submitMs`, `presentMs` are `null`
  because blitz does not measure them. Absent means unmeasured, never zero.
- `residentBytes` is whole-process RSS from `ps`, including the JS heap. It is
  not attributable to anything in particular.

**Reading metrics perturbs the app.** The collection path spins the script loop
up to 100 times and forces a resolve (`tauri-runtime-blitz/src/runtime.rs:498`
and `:632`). Do not sample in a tight loop and then reason about the result.

**All published numbers come from an inspector build.** Absolute figures carry
that overhead. Ratios measured within one binary do not, which is why every
conclusion worth keeping was framed as a before and after rather than a figure.

## Native profiling

Release builds are stripped, so `sample` reports a single `???` frame and names
nothing. Symbols are an environment override rather than a manifest edit, so a
profiling build cannot be committed by accident:

```sh
CARGO_PROFILE_RELEASE_STRIP=false CARGO_PROFILE_RELEASE_DEBUG=1 \
  scripts/local-delivery.sh stable
```

If a profile stops naming functions, it was built without that override.

## Building without breaking the build

The engine is consumed through local path checkouts patched in the root
`Cargo.toml`: `ps-blitz-render`, `tauri-runtime-blitz`, `ps-anyrender`.

- `cargo fmt --check` gates the bundle build. Unformatted code in **any** of
  those checkouts fails the app build with a diff that looks unrelated to what
  you changed. Run `cargo fmt` in each before building.
- Piping the build through `tail` discards its exit status. Check the binary's
  mtime, which is the only honest signal that a build produced anything.
- Two copies of a crate in the graph produce trait errors that read like the
  code is wrong. If `X does not implement Y` appears for a type that obviously
  does, look for the same crate resolved twice, once by path and once from git
  or crates.io, and add a `[patch]`.
