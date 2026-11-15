"""Reads a STEP file with FreeCAD and writes every solid's triangles, name and color to a binary parts file.

Run with FreeCAD's command-line Python: freecadcmd -c "exec(open('bench/tools/step-to-parts.py').read())" IN.step OUT.parts
bench/tools/parts-to-glb.mjs turns the parts file into a GLB. The split exists because the WebAssembly STEP reader
returns empty meshes for a file as big as the robot's master assembly, and FreeCAD's native one doesn't.
"""
import gzip, json, os, struct, sys, tempfile

import FreeCAD
import Import

args = [a for a in sys.argv if a.lower().endswith((".step", ".stp", ".gz", ".parts"))]
src, out = args[-2], args[-1]
tol = float(os.environ.get("TOLERANCE", "0.6"))  # mm of chord error

path = src
if src.endswith(".gz"):
    tmp = tempfile.NamedTemporaryFile(suffix=".step", delete=False)
    tmp.write(gzip.open(src).read()); tmp.close(); path = tmp.name

doc = FreeCAD.newDocument("robot")
Import.insert(path, doc.Name)

def color_of(obj):
    for prop in ("ShapeAppearance", "ShapeMaterial"):
        v = getattr(obj, prop, None)
        if v:
            m = v[0] if isinstance(v, (list, tuple)) else v
            c = getattr(m, "DiffuseColor", None)
            if c:
                return list(c[:3])
    return None

n = 0
with open(out, "wb") as f:
    for obj in doc.Objects:
        shape = getattr(obj, "Shape", None)
        if shape is None or shape.isNull() or not shape.Solids or obj.TypeId not in ("Part::Feature", "Part::FeaturePython"):
            continue
        # Leaf parts only: an assembly's compound repeats its children's solids.
        if any(getattr(c, "Shape", None) is not None and c.Shape.Solids for c in obj.OutList):
            continue
        s = shape.copy(); s.Placement = obj.getGlobalPlacement() if hasattr(obj, "getGlobalPlacement") else shape.Placement
        verts, faces = s.tessellate(tol)
        if not faces:
            continue
        head = json.dumps({"name": obj.Label, "color": color_of(obj)}).encode()
        f.write(struct.pack("<III", len(head), len(verts), len(faces)))
        f.write(head)
        f.write(struct.pack(f"<{3 * len(verts)}f", *[c / 1000.0 for v in verts for c in (v.x, v.y, v.z)]))
        f.write(struct.pack(f"<{3 * len(faces)}I", *[i for t in faces for i in t]))
        n += 1
if path != src:
    os.unlink(path)
print(f"wrote {n} parts to {out}")
