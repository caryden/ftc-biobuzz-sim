#!/usr/bin/env python3
"""Compares two labels in experiments/policy-loop.jsonl seed by seed. Run: python3 scripts/eval-compare.py BASE NEW"""
import json, sys, statistics as st
rows = {}
for line in open('experiments/policy-loop.jsonl'):
    d = json.loads(line); rows[d['label']] = d  # The last run of a label wins.
a, b = rows[sys.argv[1]], rows[sys.argv[2]]; n = min(len(a['perSeed']), len(b['perSeed']))
diff = [b['perSeed'][i] - a['perSeed'][i] for i in range(n)]
print(f"{sys.argv[2]} minus {sys.argv[1]}: {st.mean(diff):+.1f} combined points, paired SE {st.stdev(diff) / n ** 0.5:.1f}, n={n}")
for k in a['wasteSecPerRobot']: print(f"  {k:9s} {a['wasteSecPerRobot'][k]:6.1f} -> {b['wasteSecPerRobot'].get(k, 0):6.1f}")
print(f"  stalls    {a['stallsPerRobot']:6.1f} -> {b['stallsPerRobot']:6.1f}   tips {a['tips']} -> {b['tips']}   auto {a['auto']} -> {b['auto']}")
