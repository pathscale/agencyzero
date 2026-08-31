#!/usr/bin/env sh
set -eu

repo_root=$(git rev-parse --show-toplevel)

# `cargo pkgid` only reads an existing resolution. CI intentionally does not
# commit Cargo.lock, so establish that resolution before asking for a package
# id. A developer's existing ignored lockfile remains untouched.
if [ ! -f "$repo_root/Cargo.lock" ]; then
  cargo generate-lockfile
fi

# The client and the protocol inherit one workspace dependency version, so
# there is no pair to cross-check here: ask cargo which version it resolved.
# `cargo pkgid` prints `<source>#<name>@<version>`, so the version is whatever
# follows the last `@` -- no JSON, and no second parser to install.
proxy_version=$(cargo pkgid -p agency-proxy-client)
proxy_version=${proxy_version##*@}
# Shape-check, not just non-empty: a pkgid form without an `@` would survive
# the expansion whole and get passed to `cargo install --version`.
case "$proxy_version" in
  [0-9]*.[0-9]*) ;;
  *)
    echo "could not read the agency-proxy version (got '$proxy_version')" >&2
    exit 1
    ;;
esac
host_target=$(rustc -vV | sed -n 's/^host: //p')
if [ -z "$host_target" ]; then
  echo "could not determine the Rust host target" >&2
  exit 1
fi

install_root="$repo_root/target/agency-proxy-sidecar"
build_target="${CARGO_TARGET_DIR:-$repo_root/target/agency-proxy-sidecar-build}"
CARGO_TARGET_DIR="$build_target" cargo install \
  --version "$proxy_version" \
  --root "$install_root" \
  agency-proxy

sidecar_dir="$repo_root/apps/gui/binaries"
sidecar="$sidecar_dir/agency-proxy-$host_target"
mkdir -p "$sidecar_dir"
cp "$install_root/bin/agency-proxy" "$sidecar"
chmod 755 "$sidecar"
file "$sidecar"
