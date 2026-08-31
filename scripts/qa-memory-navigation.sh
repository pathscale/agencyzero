#!/usr/bin/env sh

# Prove that repeated native surface remounts plateau after warmup. This catches
# detached DOM/listener graphs that are invisible to semantic outcome checks.
set -eu

readonly ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
readonly PS_QA="${PS_QA:-$ROOT/../ps-observability/target/release/ps-qa}"
readonly MAX_GROWTH_BYTES="${QA_MAX_NAVIGATION_GROWTH_BYTES:-67108864}"
readonly MAX_NODE_GROWTH="${QA_MAX_NAVIGATION_NODE_GROWTH:-8}"

qa() {
  if [ -n "${QA_DESCRIPTOR:-}" ]; then
    "$PS_QA" --descriptor "$QA_DESCRIPTOR" "$@"
  else
    "$PS_QA" "$@"
  fi
}

resident_bytes() {
  qa metrics |
    awk '/"residentBytes":/ { value=$2; gsub(/,/, "", value); print value; exit }'
}

node_count() {
  qa nodes |
    awk -F'[= ]' '/^nodes=/ { print $2; exit }'
}

cycle_surfaces() {
  cycle_limit=$1
  cycle=0
  while [ "$cycle" -lt "$cycle_limit" ]; do
    qa --pace 0 click Settings >/dev/null
    qa --pace 0 click Analytics >/dev/null
    qa --pace 0 click Home >/dev/null
    cycle=$((cycle + 1))
  done
}

# First mounts populate fonts, renderer resources and application caches. The
# assertion starts after that cold work so it measures retention, not startup.
cycle_surfaces 5
before_bytes="$(resident_bytes)"
before_nodes="$(node_count)"

cycle_surfaces 10
after_bytes="$(resident_bytes)"
after_nodes="$(node_count)"

growth_bytes=$((after_bytes - before_bytes))
node_growth=$((after_nodes - before_nodes))
printf 'navigation memory: %s -> %s bytes (%+d), nodes %s -> %s (%+d)\n' \
  "$before_bytes" "$after_bytes" "$growth_bytes" \
  "$before_nodes" "$after_nodes" "$node_growth"

if [ "$growth_bytes" -gt "$MAX_GROWTH_BYTES" ]; then
  echo "navigation retained more than $MAX_GROWTH_BYTES bytes after warmup" >&2
  exit 1
fi
if [ "$node_growth" -gt "$MAX_NODE_GROWTH" ]; then
  echo "navigation retained more than $MAX_NODE_GROWTH semantic nodes after warmup" >&2
  exit 1
fi
