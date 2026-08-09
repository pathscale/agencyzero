# agencyzero

Multi-executable agent platform. A single Cargo workspace hosts five binaries plus a
shared library, laid out so building one executable never rebuilds the others (each is
its own crate; heavy dependencies like the Tauri stack are declared only in the crate
that needs them).

## Layout

```
apps/
  gui/            az-gui        Tauri desktop harness (like Claude desktop)
    frontend/                   the workspace UI (SolidJS + @pathscale/ui)
    dist/                       frontend build output, served by Tauri (generated)
crates/
  core/           az-core       shared types/protocol definitions (lib)
  agent/          az-agent      agent runtime (placeholder)
  mcp-proxy/      az-mcp-proxy  MCP proxy (placeholder)
  agent-proxy/    az-agent-proxy agent proxy (placeholder)
  wt-tools/       wt-tools      read-only CLI over the GUI's WorkTable store
```

## Build

Everything except the GUI bundle is plain cargo:

```bash
cargo build                 # all crates
cargo build -p az-agent     # just one, without touching the rest
```

The GUI has a real frontend under [`apps/gui/frontend/`](apps/gui/frontend) — SolidJS
and `@pathscale/ui`, built by rsbuild into `apps/gui/dist/`. It needs `tauri-cli` and
Bun:

```bash
cargo install tauri-cli --locked   # or: cargo binstall tauri-cli
```

```bash
cd apps/gui/frontend && bun install
```

Tauri drives the frontend build itself (`beforeDevCommand` / `beforeBuildCommand`), so
the usual two commands are still all you need:

```bash
cd apps/gui && cargo tauri dev     # rsbuild dev server + the app window
cd apps/gui && cargo tauri build   # produce the .app bundle
```

The `cd apps/gui` is load-bearing, not decoration. Tauri picks the working directory
for `beforeBuildCommand` relative to where the CLI was invoked: from `apps/gui` it
lands in `apps/gui/frontend` and `bun run build` finds its `package.json`, but from
the repository root it lands in `apps/` and the build dies with `Script not found
"build"`. Run it from anywhere else and that error is the one you get.

The macOS bundle lands in `target/release/bundle/macos/AgencyZero.app`. To work on the
UI alone, `cd apps/gui/frontend && bun run dev` serves it in a browser at
<http://localhost:3010> against the design fixtures.

### A Dev instance beside the System one

Identity is what keeps two instances apart on macOS: the bundle identifier keys the
data directory, the logs, the webview's localStorage and the Dock entry, so a second
identifier is a second app. [`apps/gui/tauri.dev.conf.json`](apps/gui/tauri.dev.conf.json)
is a config overlay that changes only that — `com.pathscale.agencyzero.dev`, named
"AgencyZero Dev":

```bash
cd apps/gui && cargo tauri build --config tauri.dev.conf.json
```

The bundle lands beside the system one as `AgencyZero Dev.app`, stores its data in
`~/Library/Application Support/com.pathscale.agencyzero.dev/`, and launches in
parallel with the system copy — nothing is shared, so nothing conflicts. Settings →
Application shows the build stamp, which is how you confirm which commit either
instance is running.

`AZ_DATA_DIR` still overrides the store location for either instance (tests, CI, a
scratch database). `open` does not pass environment variables, so run the binary
inside the bundle directly when you need it:

```bash
AZ_DATA_DIR=/tmp/az-scratch "./target/release/bundle/macos/AgencyZero Dev.app/Contents/MacOS/az-gui" &
```

### One local delivery check

The repository's local delivery script runs the same frontend and Rust gates in
one order, then optionally produces an isolated unsigned bundle:

```bash
scripts/local-delivery.sh verify
scripts/local-delivery.sh dev
scripts/local-delivery.sh experimental
```

Add `--offline` when every dependency is already cached and GitHub or a package
registry is unavailable. The bundle modes disable updater artifacts and signing;
they are for local testing, never distribution. Each publishes and prints the
completed `.app` under `target/release/bundle/macos`, so no CI run or deployment
is required to exercise a change. On ARM Macs the script compiles through
Cargo's target-triple staging directory to select the matching sidecar, then
moves the completed bundle into that canonical local-launch path.

## Distribution

Other Macs install through Homebrew, and the app upgrades itself from there:

```bash
brew tap pathscale/tap && brew trust pathscale/tap && brew install --cask agencyzero
```

A build also emits `AgencyZero.app.tar.gz` and a `.sig` beside the bundle, which
are what [`release.yml`](.github/workflows/release.yml) publishes. Handing someone
the tarball URL directly does **not** work: the bundle is ad-hoc signed rather
than notarized, so a browser download is quarantined and refuses to launch.
[`docs/distribution.md`](docs/distribution.md) explains why, and what a Developer
ID certificate would change.

## Design

[`design/`](design) is the static export of the design source of truth: the workspace
mockup, the data-model spec, and per-screen renders. Edit them in the design tool and
re-export — don't hand-edit the files.

## Logs

```
~/Library/Application Support/com.pathscale.agencyzero/logs/az-gui.log
```

**Read this first when something goes wrong.** A bundled `.app` launched from Finder
discards stderr, so before this file existed a panic, a failed agent launch or a boot
that stalled left no trace anywhere — the window just sat there.

Rust and the webview both write to it, interleaved, which is what makes it possible to
tell "Rust was never asked" from "Rust answered and the webview did nothing with it".
Every IPC command is logged in and out with a sequence number, so a request with no
matching reply names the call that hung. It rotates at 5 MB, keeping one generation as
`az-gui.log.1`.

## Status

Phases 0–2 of [`docs/gui-wiring-plan.md`](docs/gui-wiring-plan.md) are done and Phase 3
is partly in: the app boots on real data, and a prompt starts a real `agent-abstraction`
run whose reply, tool calls and task log are persisted.

The GUI window is the full workspace UI — tab strip, Home, new-project draft, the
project screen (transcript, composer, and the Settings · Items · Running · Task log
accordion), and global Settings.

The backend is **hybrid**, and deliberately visible as such: Rust reports which commands
it implements (`list_capabilities`), each method routes to Rust or to the in-memory
fixture backend accordingly, and the UI greys out anything still on fixtures. The agent
and both proxies are stub binaries that print their version and exit. See
[`apps/gui/frontend/README.md`](apps/gui/frontend/README.md) for exactly where the
boundary sits, and the wiring plan for what is left.
