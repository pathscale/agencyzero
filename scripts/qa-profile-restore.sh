#!/usr/bin/env bash
#
# Expand the committed QA profile to a throwaway directory.
#
# The store is single-writer and every check mutates it, so a run works on a
# copy and never on the archive. Restoring before each run is what makes a
# `PaintsMore` or `Grows` delta mean anything: an editor left open by an earlier
# press is already counted in the baseline otherwise.
set -euo pipefail

readonly ARCHIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests/data/qa-profile.tar.zst"
readonly DESTINATION="${1:-/tmp/qa-profile-db}"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "no archive at $ARCHIVE" >&2
  exit 1
fi

if ! command -v zstd >/dev/null 2>&1; then
  echo "zstd is required to expand the profile" >&2
  exit 1
fi

# A stale lock file outlives a crashed instance and refuses the next launch with
# "profile already open", which reads as a corrupt store rather than leftover
# state.
rm -rf "$DESTINATION" "$DESTINATION.lock"
# The fixture stores this exact temp path as its workspace root. Two different
# UI surfaces create it, so profile isolation includes their external effect;
# otherwise the first group makes the second surface disappear despite a fresh
# database. Never derive this deletion from HOME or from fixture content.
rm -rf /tmp/agencyzero-qa-workspace
mkdir -p "$(dirname "$DESTINATION")"

readonly STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
zstd -dc "$ARCHIVE" | tar -xf - -C "$STAGING"
mv "$STAGING/qa-profile-fixture" "$DESTINATION"

echo "restored $(du -sh "$DESTINATION" | cut -f1) to $DESTINATION"
