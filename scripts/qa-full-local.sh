#!/usr/bin/env sh

# Run the complete native outcome suite in one disposable app process.
# Provider history, workspace creation and database writes all stay beneath
# the chosen profile path; the owner's live profile is never opened.
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "qa-full-local.sh currently supports macOS only (it launches the macOS app bundle)" >&2
  exit 1
fi

readonly ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
readonly PROFILE="${1:-$ROOT/target/qa-profile-full}"
readonly APP="$ROOT/target/release/bundle/macos/AgencyZero Experimental.app/Contents/MacOS/az-gui"
readonly QA_HOME="${PROFILE}-home"
readonly QA_WORKSPACE="${PROFILE}-workspace"
readonly DESCRIPTOR_DIR="${TMPDIR:-/tmp}/tauri-blitz-agent"

"$ROOT/scripts/qa-profile-restore.sh" "$PROFILE"

HOME="$QA_HOME" AZ_DATA_DIR="$PROFILE" AZ_QA_WORKSPACE_ROOT="$QA_WORKSPACE" \
  "$APP" --blitz-control > "$ROOT/target/qa-full-app.log" 2>&1 &
app_pid=$!
cleanup() {
  kill -TERM "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
}
trap cleanup EXIT

attempt=0
descriptor_path=""
while [ "$attempt" -lt 200 ]; do
  for candidate in "$DESCRIPTOR_DIR"/*.json; do
    [ -f "$candidate" ] || continue
    if grep -Eq "\"pid\"[[:space:]]*:[[:space:]]*$app_pid([,}])" "$candidate"; then
      descriptor_path="$candidate"
      break
    fi
  done
  if [ -n "$descriptor_path" ] && \
    ps-qa --descriptor "$descriptor_path" find Home --role button --limit 1 2>/dev/null | \
    grep -Eq '^matched:[[:space:]]*[1-9]'; then
    break
  fi
  sleep 0.05
  attempt=$((attempt + 1))
done

if [ -z "$descriptor_path" ]; then
  echo "the QA app did not publish a control descriptor within 10 seconds" >&2
  exit 1
fi

if ! ps-qa --descriptor "$descriptor_path" find Home --role button --limit 1 | \
  grep -Eq '^matched:[[:space:]]*[1-9]'; then
  echo "the QA app did not expose Home within 10 seconds" >&2
  exit 1
fi

QA_DESCRIPTOR="$descriptor_path" QA_LOG="$ROOT/target/qa-full.txt" \
  "$ROOT/scripts/qa-run-groups.sh"
