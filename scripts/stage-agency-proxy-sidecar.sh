#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)

# The client and the protocol inherit one workspace dependency version, so
# there is no pair to cross-check here: ask cargo which version it resolved.
# `cargo pkgid` prints `<source>#<name>@<version>`, so the version is whatever
# follows the last `@` -- no JSON, and no second parser to install.
proxy_version=$(cargo pkgid -p agency-proxy-client 2>/dev/null)
proxy_version=${proxy_version##*@}
# Shape-check, not just non-empty: a pkgid form without an `@` would survive
# the expansion whole and get passed to `cargo install --version`.
if [[ ! $proxy_version =~ ^[0-9]+\.[0-9]+ ]]; then
  echo "could not read the agency-proxy version (got '$proxy_version')" >&2
  exit 1
fi
host_target=$(rustc -vV | sed -n 's/^host: //p')
if [[ -z "$host_target" ]]; then
  echo "could not determine the Rust host target" >&2
  exit 1
fi

install_root="$repo_root/target/agency-proxy-sidecar"
build_target="${CARGO_TARGET_DIR:-$repo_root/target/agency-proxy-sidecar-build}"
CARGO_TARGET_DIR="$build_target" cargo install \
  --version "$proxy_version" \
  --locked \
  --root "$install_root" \
  agency-proxy

sidecar_dir="$repo_root/apps/gui/binaries"
sidecar="$sidecar_dir/agency-proxy-$host_target"
mkdir -p "$sidecar_dir"
cp "$install_root/bin/agency-proxy" "$sidecar"
chmod 755 "$sidecar"
file "$sidecar"
