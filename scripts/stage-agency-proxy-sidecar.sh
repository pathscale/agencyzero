#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
manifest="$repo_root/apps/gui/Cargo.toml"
proxy_version=$(python3 - "$manifest" <<'PY'
import sys, tomllib

with open(sys.argv[1], "rb") as manifest:
    dependencies = tomllib.load(manifest)["dependencies"]

client = dependencies["agency-proxy-client"]
protocol = dependencies["agency-proxy-protocol"]
client_version = client if isinstance(client, str) else client.get("version")
protocol_version = protocol if isinstance(protocol, str) else protocol.get("version")
if client_version != protocol_version:
    raise SystemExit("AgencyProxy client and protocol versions must match")
print(client_version)
PY
)
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
