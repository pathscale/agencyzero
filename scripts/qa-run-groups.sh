#!/usr/bin/env sh

set -u

qa_log="${QA_LOG:-/tmp/qa.txt}"
timeout_scale="${QA_TIMEOUT_SCALE:-1}"

: > "$qa_log"

qa() {
  if [ -n "${QA_DESCRIPTOR:-}" ]; then
    ps-qa --descriptor "$QA_DESCRIPTOR" "$@"
  else
    ps-qa "$@"
  fi
}

# POSIX sh has no pipefail. Record the producer's status from its pipeline
# process so tee cannot turn a failed QA command into a successful script.
run_logged() {
  qa_status_file=$(mktemp "${TMPDIR:-/tmp}/az-qa-status.XXXXXX")
  {
    qa "$@"
    printf '%s\n' "$?" > "$qa_status_file"
  } 2>&1 | tee -a "$qa_log"
  qa_status=$(cat "$qa_status_file")
  rm -f "$qa_status_file"
  return "$qa_status"
}

# One prepared application, one ordered outcome run. Restarting for every
# group turned 219 sub-second semantic checks into a half-hour process churn
# benchmark and hid state-recovery bugs behind fresh processes. Every check
# owns its semantic navigation/precondition; the deliberately destructive
# persistence checks are named last in the manifest.
if [ -z "${QA_GROUPS:-}" ]; then
  if run_logged --timeout-scale "$timeout_scale" --trace qa; then
    qa_status=0
  else
    qa_status=$?
  fi
  if [ "$qa_status" -eq 0 ]; then
    # Resolved native paint, not a source-class approximation. Each read takes
    # only a few milliseconds; navigation is the expensive part and is reused.
    for surface in Settings Analytics Home "theta theta north indi"; do
      qa click "$surface" >/dev/null
      run_logged contrast || qa_status=1
    done
  fi
  exit "$qa_status"
fi

failed=0
set -f
for group in ${QA_GROUPS}; do
  {
    echo
    echo "===== $group ====="
  } | tee -a "$qa_log"
  if ! run_logged --timeout-scale "$timeout_scale" --trace qa "$group"; then
    failed=1
  fi
done
set +f

exit "$failed"
