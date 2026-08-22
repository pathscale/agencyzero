#!/usr/bin/env bash
#
# Reproduce: clicking the rename pencil never shows an editor.
#
# The editing branch of `EditableTitle`'s `<Show>` is created but never attached
# to the document. The textbox node exists and carries the right value, and it
# has exactly one parent and no further ancestors, so it can never be laid out
# or painted. The pencil stays visible, and every click leaks another orphan.
#
# The discriminator is ancestor depth, not visibility. An input that is merely
# hidden (a collapsed pane) still walks all the way to the window root; this one
# stops at 1. Comparing against a known-visible box proves the tool reports real
# geometry rather than zeroes for everything.
#
# Usage:
#   ./scripts/local-delivery.sh stable
#   # TERM any running instance FIRST: rebuilding under a live one gets it
#   # SIGKILLed for an invalid code signature, which looks like an app crash.
#   rm -f target/blitz-control.json
#   TAURI_BLITZ_CONTROL_DESCRIPTOR="$PWD/target/blitz-control.json" \
#     target/release/bundle/macos/AgencyZero.app/Contents/MacOS/az-gui --blitz-control &
#   cargo build -p ps-qa
#   scripts/repro/rename-editor-detached.sh
#
# Open a project tab before running, so a "Rename project" pencil is visible.
set -euo pipefail

cd "$(dirname "$0")/../.."
bench=./target/debug/ps-qa
: "${TAURI_BLITZ_CONTROL_DESCRIPTOR:=$PWD/target/blitz-control.json}"
export TAURI_BLITZ_CONTROL_DESCRIPTOR

[[ -x $bench ]] || { echo "build it first: cargo build -p ps-qa" >&2; exit 1; }
[[ -e $TAURI_BLITZ_CONTROL_DESCRIPTOR ]] || {
    echo "no control descriptor at $TAURI_BLITZ_CONTROL_DESCRIPTOR" >&2
    exit 1
}

depth_of() {
    # Ancestor rows are the ones marked with `^`, within this node's block.
    "$bench" dom "$1" 8 2>/dev/null |
        sed -n "/$2/,/^\$/p" |
        grep -c '\^' || true
}

echo "== control: a box known to be on screen =="
"$bench" layout "" 2>/dev/null | grep -i "Ask, or type" ||
    echo "  (no composer visible; open a project tab)"
echo "  A real width here proves 0x0 elsewhere is a finding, not a tool artifact."
echo

echo "== control: an input that is hidden but properly attached =="
echo "  ancestor depth: $(depth_of 'Search projects' 'textbox')  (expect 8)"
echo

before=$("$bench" dom "Rename project" 1 2>/dev/null | grep -c 'textbox' || true)
echo "== clicking the rename pencil =="
"$bench" click "Rename project" 2>/dev/null | grep -E 'clicking|acked' || true
sleep 2

after=$("$bench" dom "Rename project" 1 2>/dev/null | grep -c 'textbox' || true)
echo
echo "  rename textboxes before: $before   after: $after"

node=$("$bench" dom "Rename project" 1 2>/dev/null |
    grep 'textbox' | tail -1 | awk '{print $1}')
echo "  newest textbox node: ${node:-none}"
if [[ -n ${node:-} ]]; then
    echo "  ancestor depth: $(depth_of 'Rename project' "$node")  (expect 1 == orphaned)"
fi

echo
echo "== the pencil, which should have been replaced by the editor =="
"$bench" dom "Rename project" 1 2>/dev/null | grep 'button' | grep -v HIDDEN ||
    echo "  (none visible)"

echo
echo "PASS means the bug is present: the textbox exists, its depth is 1, and the"
echo "pencil is still on screen. A fix shows the editor attached and laid out."
