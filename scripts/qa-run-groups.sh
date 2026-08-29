#!/usr/bin/env bash

set -uo pipefail

qa_log="${QA_LOG:-/tmp/qa.txt}"
timeout_scale="${QA_TIMEOUT_SCALE:-1}"
qa_connection=()
if [ -n "${QA_DESCRIPTOR:-}" ]; then
  qa_connection=(--descriptor "$QA_DESCRIPTOR")
fi
groups=()
if [ -n "${QA_GROUPS:-}" ]; then
  read -r -a groups <<< "$QA_GROUPS"
else
  :
fi

: > "$qa_log"

# One prepared application, one ordered outcome run. Restarting for every
# group turned 219 sub-second semantic checks into a half-hour process churn
# benchmark and hid state-recovery bugs behind fresh processes. Every check
# owns its semantic navigation/precondition; the deliberately destructive
# persistence checks are named last in the manifest.
if [ "${#groups[@]}" -eq 0 ]; then
  ps-qa "${qa_connection[@]}" --timeout-scale "$timeout_scale" --trace qa 2>&1 | tee -a "$qa_log"
  status="${PIPESTATUS[0]}"
  if [ "$status" -eq 0 ]; then
    # Resolved native paint, not a source-class approximation. Each read takes
    # only a few milliseconds; navigation is the expensive part and is reused.
    for surface in Settings Analytics Home "theta theta north indi"; do
      ps-qa "${qa_connection[@]}" click "$surface" >/dev/null
      ps-qa "${qa_connection[@]}" contrast 2>&1 | tee -a "$qa_log" || status=1
    done
  fi
  exit "$status"
fi

failed=0
for group in "${groups[@]}"; do
  {
    echo
    echo "===== $group ====="
  } | tee -a "$qa_log"
  ps-qa "${qa_connection[@]}" --timeout-scale "$timeout_scale" --trace qa "$group" 2>&1 | tee -a "$qa_log"
  status=${PIPESTATUS[0]}
  if [ "$status" -ne 0 ]; then
    failed=1
  fi
done

exit "$failed"
