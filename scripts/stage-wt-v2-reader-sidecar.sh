#!/usr/bin/env sh
set -eu

repo_root=$(git rev-parse --show-toplevel)
manifest="$repo_root/crates/wt-migrate/v2-reader/Cargo.toml"
reader_root="$repo_root/crates/wt-migrate/v2-reader"
host_target=$(rustc -vV | sed -n 's/^host: //p')
if [ -z "$host_target" ]; then
  echo "could not determine the Rust host target" >&2
  exit 1
fi

build_target="${CARGO_TARGET_DIR:-$repo_root/target/wt-v2-reader-build}"
# This is an independently resolved historical reader. Cargo creates a lockfile
# beside standalone binary manifests; the repository intentionally keeps none.
trap 'rm -f "$reader_root/Cargo.lock"' EXIT
CARGO_TARGET_DIR="$build_target" cargo build \
  --release \
  --manifest-path "$manifest" \
  --bin agencyzero-wt-v2-reader

sidecar_dir="$repo_root/apps/gui/binaries"
sidecar="$sidecar_dir/agencyzero-wt-v2-reader-$host_target"
mkdir -p "$sidecar_dir"
cp "$build_target/release/agencyzero-wt-v2-reader" "$sidecar"
chmod 755 "$sidecar"
file "$sidecar"
