#!/usr/bin/env bash
# Run a cargo command against renderer working checkouts instead of releases.
#
#     scripts/local-renderer.sh check -p az-gui --features blitz-runtime
#     scripts/local-renderer.sh run -p az-gui --features blitz-runtime
#
# Everything after the script name is passed through to cargo unchanged.
#
# This is opt-in on purpose. The redirect used to live in `.cargo/config.toml`
# and was therefore always on, so no ordinary build ever fetched the revisions
# in `apps/gui/Cargo.toml` and they rotted unseen until a macOS release build
# found out. Now the default exercises published ranges and this is reached for only
# while renderer work is in flight.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="$root/.cargo/local-renderer.toml"

if [[ ! -f "$config" ]]; then
    cat >&2 <<MSG
$config does not exist.

It is deliberately untracked: it names paths that exist on one machine, and
committing them fails every build everywhere else. Create it with a [patch]
table per git source, pointing at your checkouts. See the header of
.cargo/config.toml for what it replaced.
MSG
    exit 1
fi

for checkout in ps-anyrender ps-blitz tauri-runtime-blitz; do
    if [[ ! -d "$root/../$checkout" ]]; then
        echo "missing checkout: $root/../$checkout" >&2
        echo "the redirect needs all three beside this repository" >&2
        exit 1
    fi
done

# Cargo rewrites Cargo.lock when a `[patch]` redirects a git source to a path:
# the git revisions are replaced by path entries. That lockfile is committed, so
# an opt-in build left the repository claiming it depends on directories that
# exist on one machine. It reached a commit twice that way.
#
# Snapshot and restore, on every exit path including a failed build and a
# Ctrl-C, so the redirect cannot leave a trace in the tree.
lock="$root/Cargo.lock"
snapshot="$(mktemp)"
cp "$lock" "$snapshot"
restore() {
    cp "$snapshot" "$lock"
    rm -f "$snapshot"
}
trap restore EXIT INT TERM

cargo "$1" --config "$config" "${@:2}"
