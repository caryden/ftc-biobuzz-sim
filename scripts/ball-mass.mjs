// Estimates the mass of POLLEN and NECTAR from the official field CAD: the solid volume of one ball model times the
// density of polyethylene. The Competition Manual, section 9.8, says that both are Gopher ResisDent polyethylene balls.
// The volume of a closed triangle mesh is the sum of the signed tetrahedra from the origin (the divergence theorem).
// A finer mesh than the converter's is used, because the holes and the thin wall set the volume.
// Run: node scripts/ball-mass.mjs
import fs from 'node:fs';
import occtFactory from 'occt-import-js';

const occt = await occtFactory();
const r = occt.ReadStepFile(new Uint8Array(fs.readFileSync('cad/field-cad-step.step')), { linearUnit: 'meter', linearDeflectionType: 'absolute_value', linearDeflection: 0.0004, angularDeflection: 0.2 });
const allMeshes = n => [...n.meshes, ...n.children.flatMap(allMeshes)];
const find = (n, test, out = []) => { if (test(n.name ?? '')) out.push(n); else n.children.forEach(c => find(c, test, out)); return out; };
function measure(node) {
  let vol = 0, area = 0, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], tris = 0;
  for (const i of allMeshes(node)) { const m = r.meshes[i], p = m.attributes.position.array, idx = m.index.array;
    for (let k = 0; k < p.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[k + a]); hi[a] = Math.max(hi[a], p[k + a]); }
    for (let k = 0; k < idx.length; k += 3) { const A = idx[k] * 3, B = idx[k + 1] * 3, C = idx[k + 2] * 3, ax = p[A], ay = p[A + 1], az = p[A + 2], bx = p[B], by = p[B + 1], bz = p[B + 2], cx = p[C], cy = p[C + 1], cz = p[C + 2];
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az; area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2; tris++; } }
  return { vol: Math.abs(vol), area, size: hi.map((h, a) => h - lo[a]), tris };
}
// Polyethylene: low-density 0.91 to 0.93 g/cm³, high-density 0.94 to 0.97 g/cm³.
const DENSITY = { 'LDPE 0.92': 920, 'HDPE 0.95': 950 }, LISTED = { Pollen: 0.055 * 453.59237, Nectar: 0.091 * 453.59237 };
for (const kind of ['Pollen', 'Nectar']) {
  const nodes = find(r.root, n => n.includes(kind)); if (!nodes.length) { console.log(`${kind}: no part with that name in the CAD`); continue; }
  const m = measure(nodes[0]), d = Math.max(...m.size), cm3 = m.vol * 1e6, solid = (4 / 3) * Math.PI * (d / 2) ** 3 * 1e6;
  // If the ball were a closed shell of uniform wall, the wall is the volume over the mean surface area of its two faces.
  console.log(`${kind}: ${nodes.length} instances, "${nodes[0].name}", ${m.tris} triangles`);
  console.log(`  bounding size ${m.size.map(v => (v * 1000).toFixed(1)).join(' x ')} mm, diameter ${(d / 0.0254).toFixed(2)} in.`);
  console.log(`  plastic volume ${cm3.toFixed(2)} cm³, which is ${(100 * cm3 / solid).toFixed(1)}% of a solid sphere; surface ${(m.area * 1e4).toFixed(0)} cm², so the mean wall is about ${(2 * m.vol / m.area * 1000).toFixed(2)} mm`);
  for (const [name, rho] of Object.entries(DENSITY)) console.log(`  ${name} g/cm³: ${(m.vol * rho * 1000).toFixed(1)} g`);
  console.log(`  AndyMark lists ${LISTED[kind].toFixed(1)} g, which needs a density of ${(LISTED[kind] / cm3).toFixed(2)} g/cm³ for this volume`);
}
