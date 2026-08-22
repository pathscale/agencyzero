#!/bin/bash
#
# Measure an az-gui build's idle CPU as CPU time consumed, not as a percentage.
#
#   scripts/perf/idle-cpu.sh once      <binary> [label]
#   scripts/perf/idle-cpu.sh clients   <binary> [cycles]
#   scripts/perf/idle-cpu.sh after-use <binary>
#   scripts/perf/idle-cpu.sh soak      <binary> [rounds]
#
# `ps %cpu` is an average over the whole life of the process, so a build that
# spun for five seconds at startup and slept ever after reads the same as one
# that never stops. It was quoted at the owner repeatedly and it is what made
# "az-gui is at 70%" impossible to act on. Two `ps -o time=` reads a known
# interval apart give the CPU time actually spent inside that interval, and
# that is what every number in docs/performance.md and docs/TODO.md now means.
#
# The modes exist because the binary turned out not to be the variable. `once`
# measures an app that has only ever sat still, which is the easy case and the
# one that proves nothing; `clients` adds control clients that attach and hang
# up, which is what the fixed server spin needed; `after-use` drives the app
# into the states the high CPU was reported from; `soak` looks for growth with
# uptime. See docs/TODO.md, "First".
#
# Every mode refuses to run when the store is already locked, and refuses to
# report a number for a process that failed to take it: two readings were once
# taken from an app that had never started.
set -u

repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
mode=${1:-}
bin=${2:-}
window=${WINDOW:-10}

usage="usage: $0 [once|clients|after-use|soak] <binary> [arg]"
case "$mode" in
    once | clients | after-use | soak) ;;
    *)
        echo "$usage" >&2
        exit 2
        ;;
esac
if [ -z "$bin" ] || [ ! -x "$bin" ]; then
    echo "$usage" >&2
    echo "no executable at '${bin:-<none>}'" >&2
    exit 2
fi

lock="$HOME/Library/Application Support/com.pathscale.agencyzero/db.lock"
if lsof "$lock" >/dev/null 2>&1; then
    echo "the store is locked by another process; close the app before measuring" >&2
    exit 1
fi

# ps prints [dd-]hh:mm:ss.ss
to_seconds() { awk -F: '{ s = 0; for (i = 1; i <= NF; i++) s = s * 60 + $i; print s }'; }

sample() {
    local name=$1 a b rss
    a=$(ps -o time= -p "$pid" | tr -d ' ' | to_seconds)
    sleep "$window"
    b=$(ps -o time= -p "$pid" | tr -d ' ' | to_seconds)
    rss=$(ps -o rss= -p "$pid" | tr -d ' ')
    awk -v l="$name" -v a="$a" -v b="$b" -v w="$window" -v r="$rss" \
        'BEGIN { printf "%-40s %6.2fs CPU over %ss wall  (%5.1f%% of a core, rss %dMB)\n", l, b - a, w, (b - a) * 100 / w, r / 1024 }'
}

bench() { (cd "$repo" && "${PS_QA:-$(dirname "$0")/../../ps-qa/target/release/ps-qa}" "$@" >/dev/null 2>&1); }

log=$(mktemp -t azidle)
# The environment local-delivery.sh pins into the bundle's LSEnvironment, so a
# bare binary is measured under the same settings the owner's app runs with.
BLITZ_INCREMENTAL=1 \
    TAURI_BLITZ_CONTROL_DESCRIPTOR="$repo/target/blitz-control.json" \
    BLITZ_FRAME_STATS=1 \
    BLITZ_FRAME_STATS_FILE="$repo/target/blitz-frame.log" \
    "$bin" >"$log" 2>&1 &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' EXIT
sleep 25

if ! kill -0 "$pid" 2>/dev/null; then
    echo "the app exited during startup. Log:" >&2
    tail -20 "$log" >&2
    exit 1
fi
if grep -qi "another process holds the store" "$log"; then
    echo "the app never took the store, so any number here would be fiction" >&2
    exit 1
fi

case "$mode" in
    once)
        sample "${3:-$(basename "$bin")}"
        ;;
    clients)
        cycles=${3:-6}
        sample "idle, never driven"
        echo "  attaching $cycles control clients, each hanging up..."
        for _ in $(seq "$cycles"); do bench nodes; done
        sample "idle, after $cycles connections"
        ;;
    after-use)
        sample "untouched"
        bench key pagedown 6 "600,400"
        sample "after 6 page downs"
        bench drag "Conversation" -1500 6
        sample "after scrolling the transcript"
        bench click "Settings"
        bench key pagedown 6 "600,400"
        sample "after paging through Settings"
        ;;
    soak)
        for round in $(seq "${3:-10}"); do
            sample "round $round"
            bench key pagedown 4 "600,400"
            bench drag "Conversation" -900 3
            bench nodes
        done
        ;;
esac

kill -TERM "$pid" 2>/dev/null
wait "$pid" 2>/dev/null
echo "  app log: $log"
