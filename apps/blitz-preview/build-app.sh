#!/bin/sh
set -eu

profile="${1:-debug}"
case "$profile" in
  debug)
    cargo_args=""
    ;;
  release)
    cargo_args="--release"
    ;;
  *)
    echo "usage: $0 [debug|release]" >&2
    exit 2
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
bundle_dir="$repo_dir/target/$profile/bundle/macos/AgencyZero Blitz Preview.app"
contents_dir="$bundle_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"

cd "$repo_dir"
# shellcheck disable=SC2086
CARGO_TARGET_DIR="$repo_dir/target" cargo build --manifest-path "$script_dir/Cargo.toml" $cargo_args

mkdir -p "$macos_dir" "$resources_dir"
cp "$repo_dir/target/$profile/agencyzero-blitz-preview" "$macos_dir/agencyzero-blitz-preview"
cp "$script_dir/Info.plist" "$contents_dir/Info.plist"
cp "$repo_dir/apps/gui/icons/icon.icns" "$resources_dir/icon.icns"
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$bundle_dir"
fi

# Finder displays the outer bundle timestamp, but copying files only updates
# Contents. Refresh the wrapper after signing so a rebuilt preview cannot look
# older than the executable it contains.
touch "$bundle_dir"

echo "$bundle_dir"
