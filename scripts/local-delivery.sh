#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mode=${1:-verify}

if [ "${2:-}" = "--offline" ] || [ "${1:-}" = "--offline" ]; then
  export CARGO_NET_OFFLINE=true
  [ "$mode" = "--offline" ] && mode=verify
fi

case "$mode" in
  verify | dev | experimental) ;;
  -h | --help)
    echo "usage: scripts/local-delivery.sh [verify|dev|experimental] [--offline]"
    exit 0
    ;;
  *)
    echo "unknown mode: $mode" >&2
    echo "usage: scripts/local-delivery.sh [verify|dev|experimental] [--offline]" >&2
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
  cargo test --workspace --all-features
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
        --config tauri.dev.conf.json \
        --config '{"bundle":{"createUpdaterArtifacts":false}}' \
        --no-sign
    )
    echo "$repo_root/target/release/bundle/macos/AgencyZero Dev.app"
    ;;
  experimental)
    echo "==> AgencyZero Experimental.app"
    (
      cd "$repo_root/apps/gui"
      run_tauri build \
        --features experimental \
        --config tauri.experimental.conf.json \
        --config '{"bundle":{"createUpdaterArtifacts":false}}' \
        --no-sign
    )
    echo "$repo_root/target/release/bundle/macos/AgencyZero Experimental.app"
    ;;
esac
