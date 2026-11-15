"""Runs a Limelight SnapScript as a bench detector.

    python3 bench/plugins/snapscript.py path/to/pipeline.py

The script must define runPipeline(image, llrobot) -> (contour, image, llpython), as on the Limelight. Each frame
arrives as one JSON line, {"w": 640, "h": 480, "llrobot": [x, y, heading, valid]}, then w*h*3 bytes of BGR.
Each reply is one JSON line, {"llpython": [...]}, with NaN written as null.
"""
import importlib.util
import json
import math
import os
import sys
import time

import numpy as np


def load(path):
    path = os.path.abspath(path)
    sys.path.insert(0, os.path.dirname(path))
    spec = importlib.util.spec_from_file_location("snapscript", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.runPipeline


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    run = load(sys.argv[1])
    inp, out = sys.stdin.buffer, sys.stdout
    while True:
        header = inp.readline()
        if not header:
            return
        h = json.loads(header)
        n = h["w"] * h["h"] * 3
        buf = inp.read(n)
        if len(buf) != n:
            return
        img = np.frombuffer(buf, np.uint8).reshape(h["h"], h["w"], 3).copy()
        t0 = time.perf_counter()
        try:
            _, _, ll = run(img, list(h.get("llrobot") or [0, 0, 0, 0]))
            ll = [float(v) if math.isfinite(float(v)) else None for v in ll]
            out.write(json.dumps({"llpython": ll, "ms": (time.perf_counter() - t0) * 1e3}) + "\n")
        except Exception as e:  # The bench shows the error and keeps the match running.
            out.write(json.dumps({"error": f"{type(e).__name__}: {e}"}) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
