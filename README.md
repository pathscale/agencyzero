# agencyzero

Multi-executable agent platform. A single Cargo workspace hosts four binaries plus a
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

The macOS bundle lands in `target/release/bundle/macos/AgencyZero.app`. To work on the
UI alone, `cd apps/gui/frontend && bun run dev` serves it in a browser at
<http://localhost:3010> against the design fixtures.

## Design

[`design/`](design) is the static export of the design source of truth: the workspace
mockup, the data-model spec, and per-screen renders. Edit them in the design tool and
re-export — don't hand-edit the files.

## Status

Step 0 on the Rust side, step 1 on the frontend.

The GUI window is the full workspace UI — tab strip, Home, new-project draft, the
project screen (transcript, composer, and the Settings · Items · Running · Task log
accordion), and global Settings. It talks to a typed IPC layer covering the whole
command and event surface in the design spec.

**None of those commands exist in Rust yet**, so the frontend falls back to an
in-memory backend serving the design fixtures, and says so in a footer. The only real
command is `greet`. The agent and both proxies are stub binaries that print their
version and exit. See [`apps/gui/frontend/README.md`](apps/gui/frontend/README.md) for
exactly where the boundary sits.
