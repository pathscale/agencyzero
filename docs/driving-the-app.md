# Driving the app from outside

How to inspect, operate and measure a running AgencyZero without touching the
keyboard. Written for an agent: everything here is reproducible from a shell,
and none of it needs a human to scroll or click.

The point is that a measurement nobody can reproduce is an anecdote. Drive a
fixed interaction, read the numbers, change one thing, drive it again.

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

## Launching

```sh
scripts/local-delivery.sh stable        # builds with blitz-inspector
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

`strip = false` is set in the root `Cargo.toml` for this work, so the binary is
symbolized and `sample` names functions:

```sh
sample $(pgrep -f "macos/AgencyZero.app/Contents/MacOS/az-gui" | head -1) 20 1 -f out.txt
```

Stripped, the whole app collapses into one `???` frame. If profiles stop naming
functions, that flag was reverted.

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
