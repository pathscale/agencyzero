#!/usr/bin/env sh

# Keep repository scripts executable by the system's POSIX shell. macOS uses
# Bash 3.2 in POSIX mode for /bin/sh; Linux CI uses dash, which catches a
# different set of accidental bash/zsh dependencies.
set -eu

# The same file is copied into a temporary PATH as ps-qa below. This exercises
# the QA runner's status propagation without launching the application.
if [ "${AZ_FAKE_PS_QA:-0}" -eq 1 ]; then
  printf '<%s>' "$@" >> "$AZ_FAKE_PS_QA_LOG"
  printf '\n' >> "$AZ_FAKE_PS_QA_LOG"
  for argument in "$@"; do
    [ "$argument" != fail ] || exit 7
  done
  exit 0
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
shell_under_test=${SHELL_UNDER_TEST:-/bin/sh}

find "$repo_root/scripts" -type f -name '*.sh' -print | sort |
while IFS= read -r script; do
  first_line=$(sed -n '1p' "$script")
  if [ "$first_line" != '#!/usr/bin/env sh' ]; then
    echo "$script: expected #!/usr/bin/env sh, found: $first_line" >&2
    exit 1
  fi

  /bin/sh -n "$script"

  if grep -n -E '\[\[[[:space:]]|set -[^[:space:]]*o[[:space:]]+pipefail|BASH_SOURCE|pipestatus|\$\{[^}]*\[@\]|^[[:space:]]*(local|typeset|source)[[:space:]]' "$script"; then
    echo "$script: contains shell-specific syntax" >&2
    exit 1
  fi
done

# POSIX sh has no pipefail, so qa-run-groups records the producer status
# explicitly. Prove a failing ps-qa remains a failure after tee, and that the
# descriptor is still passed as one argument pair.
test_root=$(mktemp -d "${TMPDIR:-/tmp}/az-shell-tests.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
cp "$0" "$test_root/ps-qa"
chmod 755 "$test_root/ps-qa"
: > "$test_root/ps-qa.log"

if AZ_FAKE_PS_QA=1 \
  AZ_FAKE_PS_QA_LOG="$test_root/ps-qa.log" \
  PATH="$test_root:$PATH" \
  QA_DESCRIPTOR="descriptor with spaces.json" \
  QA_GROUPS="pass fail pass-again" \
  QA_LOG="$test_root/qa.log" \
  "$shell_under_test" "$repo_root/scripts/qa-run-groups.sh" >/dev/null 2>&1; then
  echo "qa-run-groups.sh masked a failing ps-qa command" >&2
  exit 1
fi

grep -F '<--descriptor><descriptor with spaces.json>' "$test_root/ps-qa.log" >/dev/null
