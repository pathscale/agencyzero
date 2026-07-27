# agencyzero

Multi-executable agent platform. A single Cargo workspace hosts four binaries plus a
shared library, laid out so building one executable never rebuilds the others (each is
its own crate; heavy dependencies like the Tauri stack are declared only in the crate
that needs them).

## Layout

```
apps/
  gui/            az-gui        Tauri desktop harness (like Claude desktop)
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

The GUI is a Tauri v2 app with a static HTML frontend (`apps/gui/dist/`, no Node
build step). It needs `tauri-cli`:

```bash
cargo install tauri-cli --locked   # or: cargo binstall tauri-cli
```

```bash
cd apps/gui && cargo tauri dev     # run with devtools/hot window
cd apps/gui && cargo tauri build   # produce the .app bundle
```

The macOS bundle lands in `target/release/bundle/macos/AgencyZero.app`.

## Status

Step 0: the GUI is a hello-world window with a working webview -> Rust IPC round trip
(`greet` command). The agent and both proxies are stub binaries that print their
version and exit.
