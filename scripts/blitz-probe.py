#!/usr/bin/env python3
"""Drive the Blitz inspector's MCP surface over its Unix socket.

Two levels, as built into the bundle:
  blitz.agent.control  -> Inspect / Click / SetValue / ScrollIntoView / Key ...
  blitz.diagnostics    -> Observe / Snapshot / Metrics / WaitForIdle

Frames are length-prefixed (4-byte big-endian) JSON, kind byte 0 for text.
"""
import glob
import json
import os
import socket
import struct
import sys
import time


def descriptor():
    override = os.environ.get("TAURI_BLITZ_CONTROL_DESCRIPTOR")
    if override and os.path.exists(override):
        return override
    root = os.path.join(os.environ.get("TMPDIR", "/tmp"), "tauri-blitz-agent")
    found = sorted(glob.glob(os.path.join(root, "*.json")), key=os.path.getmtime)
    return found[-1] if found else None


class Inspector:
    def __init__(self, sock_path, timeout=15):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.settimeout(timeout)
        self.s.connect(sock_path)
        self.buf = b""
        self.rid = 0

    def _send(self, obj):
        payload = json.dumps(obj).encode()
        frame = bytes([0]) + payload
        self.s.sendall(struct.pack(">I", len(frame)) + frame)

    def _recv(self):
        while True:
            while len(self.buf) >= 4:
                n = struct.unpack(">I", self.buf[:4])[0]
                if len(self.buf) < 4 + n:
                    break
                frame = self.buf[4 : 4 + n]
                self.buf = self.buf[4 + n :]
                if frame and frame[0] == 0:
                    return json.loads(frame[1:].decode())
            chunk = self.s.recv(1 << 20)
            if not chunk:
                return None
            self.buf += chunk

    def request(self, method, params=None):
        self.rid += 1
        self._send({"jsonrpc": "2.0", "id": self.rid, "method": method, "params": params or {}})
        while True:
            msg = self._recv()
            if msg is None:
                return None
            if msg.get("id") == self.rid:
                return msg

    def call(self, tool, arguments):
        return self.request("tools/call", {"name": tool, "arguments": arguments})

    def drain(self, seconds):
        """Collect pushed notifications for a while."""
        out = []
        end = time.time() + seconds
        self.s.settimeout(1.0)
        while time.time() < end:
            try:
                msg = self._recv()
            except socket.timeout:
                continue
            if msg is None:
                break
            out.append(msg)
        return out


def main():
    path = descriptor()
    if not path:
        print("no inspector descriptor found; is a diagnostics build running?", file=sys.stderr)
        return 2
    desc = json.load(open(path))
    print(f"descriptor: {path}")
    print(json.dumps(desc, indent=1))
    sock = desc.get("address", "").removeprefix("unix://") or path.replace(".json", ".sock")

    ins = Inspector(sock)
    print("\n== initialize ==")
    print(json.dumps(ins.request("initialize", {"protocolVersion": "2025-06-18"}), indent=1)[:800])
    print("\n== tools ==")
    print(json.dumps(ins.request("tools/list"), indent=1)[:1200])

    mode = sys.argv[1] if len(sys.argv) > 1 else "metrics"
    if mode == "metrics":
        print("\n== metrics ==")
        print(json.dumps(ins.call("blitz.diagnostics", {"command": "metrics"}), indent=1)[:2000])
    elif mode == "watch":
        seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        print(f"\n== observing metrics/console/runtimeErrors for {seconds}s ==")
        print(json.dumps(ins.call("blitz.diagnostics",
              {"command": "observe", "params": {"streams": ["metrics", "console", "runtimeErrors"]}}), indent=1)[:400])
        for msg in ins.drain(seconds):
            print(json.dumps(msg)[:400])
    elif mode == "frames":
        res = ins.call("blitz.diagnostics", {"command": "metrics"})
        val = (res or {}).get("result", {}).get("structuredContent", {}).get("value", {})
        win = val.get("frameWindow")
        frame = val.get("frame")
        snap = val.get("snapshot")
        if not win:
            print("no frame window yet: the app has not presented frames since launch")
        else:
            print(f"frames={win.get('framesTotal')} window={win.get('windowFrames')} "
                  f"activeFps={win.get('activeFps')} missedRefreshes={win.get('missedRefreshes')} "
                  f"refreshHz={win.get('displayRefreshHz')}")
            for series in ("resolve", "scene", "renderer", "total", "interval"):
                st = win.get(series)
                if isinstance(st, dict):
                    print(f"  {series:9} mean={st.get('meanMs'):>8.2f}  p95={st.get('p95Ms'):>8.2f}  max={st.get('maxMs'):>8.2f}")
        if frame:
            print(f"latest frame: resolve={frame.get('resolveMs')} scene={frame.get('sceneMs')} "
                  f"renderer={frame.get('rendererMs')} total={frame.get('totalMs')} age={frame.get('ageMs')}ms")
        if snap:
            print(f"observer cost (not the app): {snap}")
        print(f"residentBytes={val.get('residentBytes')}")
    elif mode == "tree":
        print("\n== semantic tree ==")
        print(json.dumps(ins.call("blitz.agent.control", {"command": "inspect", "params": {"root": None, "maxDepth": 3}}), indent=1)[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
