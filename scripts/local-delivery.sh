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

case "$mode" in
  verify | dev | stable | blitz-debug | experimental-debug | experimental) ;;
  -h | --help)
    echo "usage: scripts/local-delivery.sh [verify|dev|stable|blitz-debug|experimental-debug|experimental] [--offline]"
    exit 0
    ;;
  *)
    echo "unknown mode: $mode" >&2
    echo "usage: scripts/local-delivery.sh [verify|dev|stable|blitz-debug|experimental-debug|experimental] [--offline]" >&2
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

# The inspector build is the tight fix/build/test loop, not a delivery gate.
# Keep it incremental: callers run the focused test for the code they changed,
# then rebuild only the frontend and Blitz bundle. The full suite remains in
# verify/dev/stable/experimental before anything is delivered.
if [ "$mode" = "blitz-debug" ]; then
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
  echo "$repo_root/target/release/bundle/macos/AgencyZero.app"
  exit 0
fi

if [ "$mode" = "experimental-debug" ]; then
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
  exit 0
fi

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

case "$mode" in
  verify)
    echo "==> verified"
    ;;
  dev)
    echo "==> AgencyZero Dev.app"
    (
      cd "$repo_root/apps/gui"
      run_tauri build \
        --target "$rust_target" \
        --config tauri.dev.conf.json \
        --config '{"bundle":{"createUpdaterArtifacts":false}}'
    )
    publish_bundle \
      "$repo_root/target/$rust_target/release/bundle/macos/AgencyZero Dev.app" \
      "$repo_root/target/release/bundle/macos/AgencyZero Dev.app"
    echo "$repo_root/target/release/bundle/macos/AgencyZero Dev.app"
    ;;
  stable)
    echo "==> AgencyZero.app"
    (
      cd "$repo_root/apps/gui"
      run_tauri build \
        --target "$rust_target" \
        --features blitz-runtime \
        --config '{"bundle":{"createUpdaterArtifacts":false}}'
    )
    publish_bundle \
      "$repo_root/target/$rust_target/release/bundle/macos/AgencyZero.app" \
      "$repo_root/target/release/bundle/macos/AgencyZero.app"
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
esac
