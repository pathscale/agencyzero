#!/usr/bin/env python3
"""Drive a repeatable interaction and measure what it cost.

The point is to remove the human from the measurement. Hand-scrolling produces
numbers nobody can reproduce or compare; this sends a fixed number of identical
wheel events at a fixed cadence, then reports the frame window that resulted.

Usage:
  scripts/blitz-bench.py scroll [ticks] [delta]
  scripts/blitz-bench.py type [keys] [selector-substring]
  scripts/blitz-bench.py click [name-substring]
  scripts/blitz-bench.py nodes
  scripts/blitz-bench.py idle

Every run prints one line per timing series so two runs can be diffed directly.

Script attribution is cumulative since launch, so the totals include startup and
every interaction before this one. `type` reports the delta across the run
instead: what this interaction cost, per source, and what it cost per keystroke.
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


def breakdown_of(val):
    """Script attribution as {label: (calls, total_ms, worst_ms)}."""
    script = val.get("script") or {}
    return {
        row["label"]: (row["calls"], row["totalMs"], row["worstMs"])
        for row in (script.get("breakdown") or [])
    }


def show_delta(before, after, events):
    """What this run cost, per source. Cumulative totals hide the interaction.

    Reading metrics itself polls the script loop, so `poll_hook` carries the
    observer's own cost and is reported but not attributed to the interaction.
    """
    start, end = breakdown_of(before), breakdown_of(after)
    rows = []
    for label, (calls, total, worst) in end.items():
        prev_calls, prev_total, _ = start.get(label, (0, 0.0, 0.0))
        d_calls, d_total = calls - prev_calls, total - prev_total
        if d_calls or d_total > 0.01:
            rows.append((d_total, label, d_calls, worst))
    rows.sort(reverse=True)
    print(f"\ncost of this run ({events} events):")
    if not rows:
        print("    nothing attributed: did the interaction reach the app?")
        return
    for total, label, calls, worst in rows:
        per = f"{total / events:8.2f}" if events else "       -"
        note = "   <- observer" if label == "poll_hook" else ""
        print(
            f"    {label[:34]:34} calls={calls:6} total={total:9.2f}ms "
            f"per_event={per}ms worst={worst:7.2f}ms{note}"
        )


def find_text_field(ins, want):
    """The first enabled, visible textbox whose name mentions `want`."""
    res = ins.call(
        "blitz.agent.control",
        {"command": "inspect", "params": {"root": None, "max_depth": 40}},
    )
    found = (res or {}).get("result", {}).get("structuredContent", {}).get("value", {}).get("nodes", [])
    fields = [
        node
        for node in found
        if node.get("role") in ("textbox", "textarea", "input")
        and node.get("enabled")
        and node.get("visible")
    ]
    if want:
        named = [n for n in fields if want.lower() in (n.get("name") or "").lower()]
        if named:
            return named[0]
    return fields[0] if fields else None


def type_keys(ins, count, want):
    """Drive real key events into a focused text field and price them.

    Typing is the interaction the composer autosizes on: it writes
    style.height, reads scrollHeight, and writes it again, so every keystroke
    forces a synchronous layout resolve. Scrolling never exercises that path.
    """
    field = find_text_field(ins, want)
    if not field:
        print("no enabled, visible text field found; open a tab with a composer", file=sys.stderr)
        return 2
    print(f"typing into node {field['id']} role={field.get('role')} name={(field.get('name') or '')[:40]!r}")
    # AgentAction is adjacently tagged (tag = "action", content = "params"), so
    # the variant's fields nest under `params`. Putting node_id at the top level
    # deserialises to nothing and the server answers with silence, not an error.
    ins.call(
        "blitz.agent.control",
        {"command": "act", "params": {"action": "click", "params": {"node_id": field["id"]}}},
    )
    time.sleep(0.2)

    before = metrics(ins)
    latencies = []
    for index in range(count):
        letter = "abcdefghijklmnopqrstuvwxyz"[index % 26]
        started = time.time()
        for phase in ("down", "up"):
            ins.call(
                "blitz.agent.control",
                {
                    "command": "act",
                    "params": {
                        "action": "input",
                        "params": {
                            "input": "key",
                            "phase": phase,
                            "key": letter,
                            "code": f"Key{letter.upper()}",
                            "modifiers": NO_MODS,
                        },
                    },
                },
            )
        latencies.append((time.time() - started) * 1000)
        if PACE > 0:
            time.sleep(PACE)
    after = metrics(ins)

    latencies.sort()
    print(
        f"drove {count} keystrokes: ack mean={statistics.mean(latencies):.2f}ms "
        f"p95={latencies[int(len(latencies) * 0.95) - 1]:.2f}ms max={latencies[-1]:.2f}ms"
    )
    show("before", before)
    show("after", after)
    show_delta(before, after, count)
    return 0


def click_named(ins, want):
    """Price a single click, such as switching to a tab.

    A tab switch flips `display: none` to `flex` over that tab's whole subtree,
    so taffy lays out in one pass everything the tab retained while hidden. That
    is a different cost from typing and needs its own measurement.
    """
    res = ins.call(
        "blitz.agent.control",
        {"command": "inspect", "params": {"root": None, "max_depth": 40}},
    )
    found = (res or {}).get("result", {}).get("structuredContent", {}).get("value", {}).get("nodes", [])
    targets = [
        node
        for node in found
        if want.lower() in (node.get("name") or "").lower()
        and node.get("visible")
        and node.get("enabled")
    ]
    if not targets:
        print(f"no visible, enabled node whose name contains {want!r}", file=sys.stderr)
        return 2
    target = targets[0]
    print(f"clicking node {target['id']} role={target.get('role')} name={(target.get('name') or '')[:50]!r}")

    before = metrics(ins)
    started = time.time()
    ins.call(
        "blitz.agent.control",
        {"command": "act", "params": {"action": "click", "params": {"node_id": target["id"]}}},
    )
    ack = (time.time() - started) * 1000
    time.sleep(0.5)
    after = metrics(ins)
    print(f"click acked in {ack:.1f}ms")
    show("before", before)
    show("after", after)
    show_delta(before, after, 1)
    return 0


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "idle"
    ins = connect()
    if mode == "nodes":
        nodes(ins)
        return 0
    if mode == "idle":
        show("idle", metrics(ins))
        return 0
    if mode == "click":
        want = sys.argv[2] if len(sys.argv) > 2 else "Settings"
        nodes(ins)
        return click_named(ins, want)
    if mode == "type":
        count = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        want = sys.argv[3] if len(sys.argv) > 3 else ""
        nodes(ins)
        return type_keys(ins, count, want)
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
