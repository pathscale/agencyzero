#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mode=${1:-verify}
rust_target=$(rustc -vV | sed -n 's/^host: //p')

if [ -z "$rust_target" ]; then
  echo "could not determine the Rust host target" >&2
  exit 1
fi

if [ "${2:-}" = "--offline" ] || [ "${1:-}" = "--offline" ]; then
  export CARGO_NET_OFFLINE=true
  [ "$mode" = "--offline" ] && mode=verify
fi

usage="usage: scripts/local-delivery.sh [verify|quick|stable|experimental|experimental-inspector] [--offline]"

case "$mode" in
  verify | quick | stable | experimental | experimental-inspector) ;;
  -h | --help)
    echo "$usage"
    exit 0
    ;;
  *)
    echo "unknown mode: $mode" >&2
    echo "$usage" >&2
    exit 2
    ;;
esac

run_tauri() {
  if command -v cargo-tauri >/dev/null 2>&1; then
    cargo-tauri "$@"
  elif [ -n "${CARGO_HOME:-}" ] && [ -x "$CARGO_HOME/bin/cargo-tauri" ]; then
    "$CARGO_HOME/bin/cargo-tauri" "$@"
  elif [ -x "$HOME/.cargo/bin/cargo-tauri" ]; then
    "$HOME/.cargo/bin/cargo-tauri" "$@"
  else
    echo "cargo-tauri is not installed; run: cargo install tauri-cli --locked" >&2
    exit 1
  fi
}

pin_inspector_env() {
  # The inspector is only reachable if the app knows where to put its control
  # socket, and passing that with `open --env` does not survive the two launches
  # that actually happen: a Finder launch, and the restart angel re-executing
  # the binary after a rebuild (see docs/angel-restart.md). Both start the
  # process without the shell environment, so the socket lands in $TMPDIR under
  # an instance-specific name and every tool then attaches to whichever stale
  # descriptor sorts last.
  #
  # LSEnvironment is read by launchd from the bundle itself, so it holds for
  # every way the app can start. Applied here rather than in tauri.conf.json
  # because this belongs to a local diagnostics build and must never ship.
  #
  # BLITZ_FRAME_STATS turns on the once-per-second `[blitz-frame]` line, which
  # carries the per-scene layer counts. Those are the one renderer figure the
  # MCP surface does not expose, so the file is the only way to read them, and
  # a Finder-launched bundle has nowhere to send stderr. It appends, so delete
  # target/blitz-frame.log before a run you intend to read.
  bundle=$1
  plist="$bundle/Contents/Info.plist"
  plutil -remove LSEnvironment "$plist" >/dev/null 2>&1 || true
  plutil -insert LSEnvironment -xml \
    "<dict>
       <key>BLITZ_INCREMENTAL</key><string>1</string>
       <key>TAURI_BLITZ_CONTROL_DESCRIPTOR</key><string>$repo_root/target/blitz-control.json</string>
       <key>BLITZ_FRAME_STATS</key><string>1</string>
       <key>BLITZ_FRAME_STATS_FILE</key><string>$repo_root/target/blitz-frame.log</string>
     </dict>" "$plist"
  # Editing Info.plist after bundling invalidates the signature, and macOS then
  # refuses to launch the app at all: `open` fails with -54 and nothing starts.
  # The bundle is ad-hoc signed to begin with, so re-signing ad-hoc restores it
  # without needing an identity.
  codesign --force --sign - --options runtime "$bundle" >/dev/null 2>&1
  codesign --verify --strict "$bundle" || {
    echo "bundle signature is invalid after pinning the inspector env" >&2
    exit 1
  }
  echo "==> pinned inspector env in $(basename "$bundle")"
}

publish_bundle() {
  built_bundle=$1
  published_bundle=$2

  # The installed Tauri CLI is x86_64 while this Rust host and its sidecar are
  # ARM, so `--target` is required. Cargo stages that bundle below the target
  # triple; publish it to the canonical local-launch path only after bundling
  # succeeds, moving rather than copying so no duplicate app remains.
  if [ "$built_bundle" != "$published_bundle" ]; then
    rm -rf "$published_bundle"
    mkdir -p "$(dirname "$published_bundle")"
    mv "$built_bundle" "$published_bundle"
  fi
}

if [ "$mode" != "quick" ]; then
  echo "==> frontend"
  (
    cd "$repo_root/apps/gui/frontend"
    bun run test:run
    bun run lint
    bun run build
  )

  echo "==> rust"
  (
    cd "$repo_root"
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    # Store-backed tests open several files apiece. macOS's default descriptor
    # ceiling can make the parallel harness fail with `Too many open files`,
    # masking healthy assertions as a broken release. Serial execution adds less
    # than a second here and keeps the delivery gate deterministic.
    RUST_TEST_THREADS=${RUST_TEST_THREADS:-1} cargo test --workspace --all-features
  )
fi

case "$mode" in
  verify)
    echo "==> verified"
    ;;
  quick)
    # Swap the binary inside the bundle that is already there.
    #
    # Bundling is the slow half of `stable`, and for a Rust-only change every
    # part of it is invariant: the frontend dist is already embedded, the
    # sidecar is untouched, and Info.plist keeps the pinned LSEnvironment. Only
    # `az-gui` differs, so build that alone and drop it in.
    #
    # No test gate either. This is the inner loop of a measure-fix-measure
    # cycle, so run `verify` or `stable` before anything leaves the machine.
    bundle="$repo_root/target/release/bundle/macos/AgencyZero.app"
    if [ ! -d "$bundle" ]; then
      echo "no bundle at $bundle; run 'stable' once first" >&2
      exit 1
    fi
    # The frontend dist is embedded into the binary at compile time, so a
    # Rust-only rebuild silently ships whatever `dist` happens to hold. Build
    # it, but without the test and lint gate: this is the inner loop.
    echo "==> frontend dist"
    (
      cd "$repo_root/apps/gui/frontend"
      bun run build
    )
    echo "==> az-gui (Blitz inspector)"
    (
      cd "$repo_root"
      cargo build --release --features blitz-inspector -p az-gui
    )
    cp "$repo_root/target/release/az-gui" "$bundle/Contents/MacOS/az-gui"
    # Replacing a binary invalidates the bundle signature, and macOS then
    # refuses to launch it at all. Ad-hoc again, as the bundle already was.
    codesign --force --sign - --options runtime "$bundle" >/dev/null 2>&1
    codesign --verify --strict "$bundle" || {
      echo "bundle signature is invalid after swapping the binary" >&2
      exit 1
    }
    echo "$bundle"
    ;;
  stable)
    echo "==> AgencyZero.app (Blitz inspector)"
    (
      cd "$repo_root/apps/gui"
      run_tauri build \
        --target "$rust_target" \
        --features blitz-inspector \
        --config '{"bundle":{"createUpdaterArtifacts":false}}'
    )
    publish_bundle \
      "$repo_root/target/$rust_target/release/bundle/macos/AgencyZero.app" \
      "$repo_root/target/release/bundle/macos/AgencyZero.app"
    pin_inspector_env "$repo_root/target/release/bundle/macos/AgencyZero.app"
    echo "$repo_root/target/release/bundle/macos/AgencyZero.app"
    ;;
  experimental)
    echo "==> AgencyZero Experimental.app"
    (
      cd "$repo_root/apps/gui"
      run_tauri build \
        --target "$rust_target" \
        --features experimental,blitz-runtime \
        --config tauri.experimental.conf.json \
        --config '{"bundle":{"createUpdaterArtifacts":false}}'
    )
    publish_bundle \
      "$repo_root/target/$rust_target/release/bundle/macos/AgencyZero Experimental.app" \
      "$repo_root/target/release/bundle/macos/AgencyZero Experimental.app"
    echo "$repo_root/target/release/bundle/macos/AgencyZero Experimental.app"
    ;;
  experimental-inspector)
    # Same bundle as `experimental`, plus the Blitz diagnostics surface, which
    # is what makes the renderer controllable and debuggable from outside.
    # `blitz-inspector` already implies `blitz-runtime`, so naming both would
    # be redundant rather than additive. It publishes over the same path, so
    # the build stamp in Settings is what tells the two apart once installed.
    echo "==> AgencyZero Experimental.app (Blitz inspector)"
    (
      cd "$repo_root/apps/gui"
      run_tauri build \
        --target "$rust_target" \
        --features experimental,blitz-inspector \
        --config tauri.experimental.conf.json \
        --config '{"bundle":{"createUpdaterArtifacts":false}}'
    )
    publish_bundle \
      "$repo_root/target/$rust_target/release/bundle/macos/AgencyZero Experimental.app" \
      "$repo_root/target/release/bundle/macos/AgencyZero Experimental.app"
    echo "$repo_root/target/release/bundle/macos/AgencyZero Experimental.app"
    ;;
esac
