"""Reads part colors from a STEP file: each solid's STYLED_ITEM, followed down to its COLOUR_RGB, keyed by the solid's
name, which Onshape sets to the part name. Writes {name: [r, g, b]} as JSON.

Run: python3 bench/tools/step-colors.py IN.step[.gz] OUT.json
"""
import gzip, json, re, sys
from collections import Counter, defaultdict

src, out = sys.argv[1], sys.argv[2]
text = (gzip.open(src, "rt") if src.endswith(".gz") else open(src)).read()
ents = {}
for m in re.finditer(r"#(\d+)=([A-Z_0-9]+)\((.*?)\);\s*(?=#\d+=|ENDSEC)", text, re.S):
    ents[int(m.group(1))] = (m.group(2), m.group(3))
refs = lambda body: [int(x) for x in re.findall(r"#(\d+)", body)]


def color(i, depth=0):
    """The first COLOUR_RGB reachable from entity i, following references."""
    if depth > 8 or i not in ents:
        return None
    kind, body = ents[i]
    if kind == "COLOUR_RGB":
        v = [float(x) for x in re.findall(r"[-\d.Ee+]+", body.split(",", 1)[1])][:3]
        return v
    for j in refs(body):
        c = color(j, depth + 1)
        if c:
            return c
    return None


names = {i: re.match(r"\s*'([^']*)'", b).group(1) for i, (k, b) in ents.items() if k in ("MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS") and re.match(r"\s*'", b)}
votes = defaultdict(Counter)
for i, (k, b) in ents.items():
    if k != "STYLED_ITEM":
        continue
    r = refs(b)
    solid = r[-1]
    if solid in names:
        c = color(r[0])
        if c:
            votes[names[solid]][tuple(round(x, 3) for x in c)] += 1
json.dump({n: list(v.most_common(1)[0][0]) for n, v in votes.items()}, open(out, "w"), indent=1)
print(f"{len(votes)} named parts with a color, {len(set(names.values()))} names in all")
