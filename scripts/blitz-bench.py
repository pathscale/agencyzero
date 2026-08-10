#!/usr/bin/env python3
"""Drive a repeatable interaction and measure what it cost.

The point is to remove the human from the measurement. Hand-scrolling produces
numbers nobody can reproduce or compare; this sends a fixed number of identical
wheel events at a fixed cadence, then reports the frame window that resulted.

Usage:
  scripts/blitz-bench.py scroll [ticks] [delta]
  scripts/blitz-bench.py nodes
  scripts/blitz-bench.py idle

Every run prints one line per timing series so two runs can be diffed directly.
"""
import importlib.util
import json
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bp", os.path.join(HERE, "blitz-probe.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)

SOCK = os.path.join(os.path.dirname(HERE), "target", "blitz-control.sock")
NO_MODS = {"shift": False, "control": False, "alt": False, "meta": False}
PACE = float(os.environ.get("BENCH_PACE", 1 / 60))


def connect(timeout=60):
    ins = bp.Inspector(SOCK, timeout=timeout)
    ins.request("initialize", {"protocolVersion": "2025-06-18"})
    return ins


def metrics(ins):
    res = ins.call("blitz.diagnostics", {"command": "metrics"})
    return (res or {}).get("result", {}).get("structuredContent", {}).get("value", {})


def show(label, val):
    win = val.get("frameWindow")
    if not win:
        print(f"{label}: no frames in window")
        return
    print(
        f"{label}: fps={win.get('activeFps'):.1f} missed={win.get('missedRefreshes')}"
        f"/{win.get('windowFrames')} frames={win.get('framesTotal')}"
    )
    script = val.get("script") if isinstance(val, dict) else None
    if script:
        print(
            f"    {'script':9} mean={script.get('meanMs'):7.2f} "
            f"p95={script.get('p95Ms'):7.2f} max={script.get('maxMs'):8.2f}"
            f"  (ran {script.get('productivePolls')}/{script.get('totalPolls')} polls,"
            f" {script.get('spentMs'):.0f}ms total)"
        )
        for source in (script.get("breakdown") or [])[:8]:
            print(
                f"        {source.get('label')[:34]:34} calls={source.get('calls'):5} "
                f"total={source.get('totalMs'):8.1f}ms  worst={source.get('worstMs'):7.1f}ms"
            )
    for series in ("resolve", "scene", "renderer", "total", "interval"):
        st = win.get(series)
        if isinstance(st, dict):
            print(
                f"    {series:9} mean={st.get('meanMs'):7.2f} "
                f"p95={st.get('p95Ms'):7.2f} max={st.get('maxMs'):8.2f}"
            )


def nodes(ins):
    """Tree size, which is the input to every layout cost."""
    t = time.time()
    res = ins.call("blitz.agent.control", {"command": "inspect", "params": {"root": None, "max_depth": 40}})
    took = (time.time() - t) * 1000
    val = (res or {}).get("result", {}).get("structuredContent", {}).get("value", {})
    found = val.get("nodes", [])
    roles = {}
    for node in found:
        roles[node.get("role")] = roles.get(node.get("role"), 0) + 1
    top = sorted(roles.items(), key=lambda kv: -kv[1])[:8]
    print(f"nodes={len(found)} inspect_ms={took:.1f}")
    print("  " + "  ".join(f"{role}={count}" for role, count in top))
    return len(found)


def scroll(ins, ticks, delta):
    """A fixed scroll burst, paced like a trackpad rather than a firehose."""
    latencies = []
    for _ in range(ticks):
        started = time.time()
        ins.call(
            "blitz.agent.control",
            {
                "command": "act",
                "params": {
                    "action": "input",
                    "params": {
                        "input": "wheel",
                        "delta_x": 0.0,
                        "delta_y": delta,
                        "phase": "moved",
                        "modifiers": NO_MODS,
                    },
                },
            },
        )
        latencies.append((time.time() - started) * 1000)
        # Pacing is a parameter, not a constant. At 1/60 the harness sets the
        # cadence and the measured frame interval reports the harness rather
        # than the application: fifo and immediate both read 20ms because that
        # is how fast events were being sent, not how fast frames could be
        # produced. Zero means saturate and measure the ceiling.
        if PACE > 0:
            time.sleep(PACE)
    latencies.sort()
    print(
        f"drove {ticks} wheel events: ack mean={statistics.mean(latencies):.2f}ms "
        f"p95={latencies[int(len(latencies) * 0.95) - 1]:.2f}ms max={latencies[-1]:.2f}ms"
    )


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "idle"
    ins = connect()
    if mode == "nodes":
        nodes(ins)
        return 0
    if mode == "idle":
        show("idle", metrics(ins))
        return 0
    if mode == "scroll":
        ticks = int(sys.argv[2]) if len(sys.argv) > 2 else 120
        delta = float(sys.argv[3]) if len(sys.argv) > 3 else -80.0
        count = nodes(ins)
        show("before", metrics(ins))
        scroll(ins, ticks, delta)
        show("after", metrics(ins))
        print(f"tree size during run: {count} nodes")
        return 0
    print(f"unknown mode {mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
