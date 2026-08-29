#!/usr/bin/env zsh
#
# Expand the committed QA profile to a throwaway directory.
#
# The store is single-writer and every check mutates it, so a run works on a
# copy and never on the archive. Restoring before each run is what makes a
# `PaintsMore` or `Grows` delta mean anything: an editor left open by an earlier
# press is already counted in the baseline otherwise.
set -euo pipefail

readonly REPO_ROOT="${0:A:h:h}"
readonly ARCHIVE="$REPO_ROOT/tests/data/qa-profile.tar.zst"
readonly DESTINATION="${1:-/tmp/qa-profile-db}"
readonly QA_HOME="${DESTINATION}-home"

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
# The app uses this exact sibling only when AZ_QA_WORKSPACE_ROOT is supplied to
# its QA launch. Two different UI surfaces create it, so profile isolation must
# include the external effect as well as the database. Never derive this
# deletion from HOME or from fixture content.
rm -rf "${DESTINATION}-workspace" "$QA_HOME"
mkdir -p "$(dirname "$DESTINATION")"
mkdir -p "$QA_HOME/.codex/sessions"

# The shared Select outcome must never depend on, or inspect, the developer's
# real provider history. These two tiny rollouts are the deterministic local
# source used by the same native discovery path as production.
printf '%s\n' \
  '{"type":"session_meta","timestamp":"2026-08-26T00:00:00Z","payload":{"id":"ps-qa-select-new","cwd":"/tmp"}}' \
  '{"type":"event_msg","timestamp":"2026-08-26T00:00:01Z","payload":{"type":"user_message","message":"ps-qa newer select fixture"}}' \
  > "$QA_HOME/.codex/sessions/rollout-ps-qa-select-new.jsonl"
printf '%s\n' \
  '{"type":"session_meta","timestamp":"2026-08-25T00:00:00Z","payload":{"id":"ps-qa-select-old","cwd":"/tmp"}}' \
  '{"type":"event_msg","timestamp":"2026-08-25T00:00:01Z","payload":{"type":"user_message","message":"ps-qa older select fixture"}}' \
  > "$QA_HOME/.codex/sessions/rollout-ps-qa-select-old.jsonl"

readonly STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
zstd -dc "$ARCHIVE" | tar -xf - -C "$STAGING"
mv "$STAGING/qa-profile-fixture" "$DESTINATION"

echo "restored $(du -sh "$DESTINATION" | cut -f1) to $DESTINATION"
echo "QA HOME: $QA_HOME"
