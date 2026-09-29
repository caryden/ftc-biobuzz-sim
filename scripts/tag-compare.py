#!/usr/bin/env python3
"""Compares two tagged runs of the design specs: each row's paired change against the baseline under each tag, and the
shift between them. The baseline is `shoot-dual`, which is the same robots as every other group's baseline row. For
the `follow` and `path` groups the change is in the combined score, as in scripts/exp-report.ts.
Run: python3 scripts/tag-compare.py BASE_TAG NEW_TAG [FILE ...]. Default files: experiments/results.jsonl."""
import json, math, sys

base_tag, new_tag, files = sys.argv[1], sys.argv[2], sys.argv[3:] or ['experiments/results.jsonl']
rows = [json.loads(l) for f in files for l in open(f)]
mean = lambda v: sum(v) / len(v)
se = lambda v: math.sqrt(sum((x - mean(v)) ** 2 for x in v) / (len(v) - 1) / len(v))
def by_tag(tag):
    out = {}
    for r in rows:
        if r.get('tag') == tag: out.setdefault(r['id'], {})[r['seed']] = r
    return out
a, b = by_tag(base_tag), by_tag(new_tag)
seeds = sorted(set(a['shoot-dual']) & set(b['shoot-dual']))
print(f'Baseline robots on {len(seeds)} seeds, {new_tag} minus {base_tag}:')
for k in ['red', 'blue', 'redTips', 'redAuto', 'stalls']:
    d = [b['shoot-dual'][s][k] - a['shoot-dual'][s][k] for s in seeds]
    print(f'  {k:8s} {mean([a["shoot-dual"][s][k] for s in seeds]):6.1f} -> {mean([b["shoot-dual"][s][k] for s in seeds]):6.1f}   {mean(d):+.1f} ± {se(d):.1f}')
print(f'\n| Row | Seeds | Change, {base_tag} | Change, {new_tag} | Shift | Shift / SE |\n| --- | --- | --- | --- | --- | --- |')
for rid in [i for i in b if i != 'shoot-dual' and i in a]:
    combined = next(iter(b[rid].values()))['group'] in ('follow', 'path')
    score = (lambda r: r['red'] + r['blue']) if combined else (lambda r: r['red'])
    ss = sorted(set(a[rid]) & set(b[rid]) & set(a['shoot-dual']) & set(b['shoot-dual']))
    da = [score(a[rid][s]) - score(a['shoot-dual'][s]) for s in ss]
    db = [score(b[rid][s]) - score(b['shoot-dual'][s]) for s in ss]
    # The two tags' matches diverge after the first step that differs, so their changes are treated as independent.
    shift, sd = mean(db) - mean(da), math.hypot(se(da), se(db))
    print(f'| {rid}{", combined" if combined else ""} | {len(ss)} | {mean(da):+.1f} ± {se(da):.1f} | {mean(db):+.1f} ± {se(db):.1f} | {shift:+.1f} ± {sd:.1f} | {shift / sd:+.1f} |')
