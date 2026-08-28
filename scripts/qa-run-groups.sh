#!/usr/bin/env bash

set -uo pipefail

qa_log="${QA_LOG:-/tmp/qa.txt}"
timeout_scale="${QA_TIMEOUT_SCALE:-1}"
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
  ps-qa --timeout-scale "$timeout_scale" --trace qa 2>&1 | tee -a "$qa_log"
  exit "${PIPESTATUS[0]}"
fi

failed=0
for group in "${groups[@]}"; do
  {
    echo
    echo "===== $group ====="
  } | tee -a "$qa_log"
  ps-qa --timeout-scale "$timeout_scale" --trace qa "$group" 2>&1 | tee -a "$qa_log"
  status=${PIPESTATUS[0]}
  if [ "$status" -ne 0 ]; then
    failed=1
  fi
done

exit "$failed"
