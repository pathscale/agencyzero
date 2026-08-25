#!/usr/bin/env bash

set -u

qa_log="${QA_LOG:-/tmp/qa.txt}"
groups=()
if [ -n "${QA_GROUPS:-}" ]; then
  read -r -a groups <<< "$QA_GROUPS"
else
  # One harness process, one application process, one pass. Reconnecting and
  # relaunching per group made the suite take tens of minutes and erased the
  # cross-component state the audit is supposed to catch.
  set -o pipefail
  ps-qa --trace qa 2>&1 | tee "$qa_log"
  exit "${PIPESTATUS[0]}"
fi

: > "$qa_log"
failed=0
for group in "${groups[@]}"; do
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
