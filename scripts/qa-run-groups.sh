#!/usr/bin/env bash

set -u

qa_log="${QA_LOG:-/tmp/qa.txt}"
app_log="${QA_APP_LOG:-/tmp/az-qa.log}"
pid_file="${QA_PID_FILE:-/tmp/az-qa.pid}"
profile="${QA_PROFILE:-/tmp/qa-profile-db}"

stop_app() {
  if [ ! -f "$pid_file" ]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file")"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  kill -KILL "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  echo "audit instance $pid did not exit after KILL" >&2
  return 1
}

start_app() {
  scripts/qa-profile-restore.sh "$profile"
  AZ_DATA_DIR="$profile" ./target/debug/az-gui --blitz-control >> "$app_log" 2>&1 &
  echo $! > "$pid_file"
  for _ in $(seq 1 60); do
    if ps-qa nodes >/tmp/group-attach.txt 2>&1; then
      sleep 2
      return 0
    fi
    sleep 1
  done
  echo "ps-qa could not attach to the clean group instance" >&2
  cat /tmp/group-attach.txt >&2
  tail -40 "$app_log" >&2
  return 1
}

groups=()
while IFS= read -r group; do
  groups[${#groups[@]}]="$group"
done < <(ps-qa list | awk 'NF == 1 && $1 !~ /^[0-9]+$/ { print $1 }')

if [ "${#groups[@]}" -eq 0 ]; then
  echo "ps-qa listed no outcome groups" >&2
  exit 1
fi

: > "$qa_log"
failed=0
for group in "${groups[@]}"; do
  stop_app || exit 1
  start_app || exit 1
  {
    echo
    echo "===== $group ====="
  } | tee -a "$qa_log"
  set +e
  ps-qa --trace qa "$group" 2>&1 | tee -a "$qa_log"
  status=${PIPESTATUS[0]}
  set -e
  if [ "$status" -ne 0 ]; then
    failed=1
  fi
done

exit "$failed"
