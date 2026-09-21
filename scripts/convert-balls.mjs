// Extracts the POLLEN and NECTAR models from the official field CAD into public/balls.gltf, so that the simulator draws
// the real balls with their holes. Each model is centered on its own center. Run: node scripts/convert-balls.mjs
import fs from 'node:fs';
import occtFactory from 'occt-import-js';

const occt = await occtFactory();
const r = occt.ReadStepFile(new Uint8Array(fs.readFileSync('cad/field-cad-step.step')), { linearUnit: 'meter', linearDeflectionType: 'absolute_value', linearDeflection: 0.0012, angularDeflection: 0.5 });
const allMeshes = n => [...n.meshes, ...n.children.flatMap(allMeshes)];
const find = (n, test) => (test(n.name ?? '') ? n : n.children.map(c => find(c, test)).find(Boolean));
const chunks = [], views = [], accessors = [], meshes = [], nodes = []; let offset = 0;
const push = (typed, target) => { const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength), pad = (4 - (buf.length % 4)) % 4; chunks.push(buf, Buffer.alloc(pad)); views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target }); offset += buf.length + pad; return views.length - 1; };
for (const [name, part] of [['pollen', 'Pollen'], ['nectar', 'Nectar']]) {
  const node = find(r.root, n => n.includes(part)), pos = [], nrm = [], idx = [];
  for (const i of allMeshes(node)) { const m = r.meshes[i], base = pos.length / 3; pos.push(...m.attributes.position.array); nrm.push(...(m.attributes.normal?.array ?? [])); for (const v of m.index.array) idx.push(v + base); }
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pos[k + a]); hi[a] = Math.max(hi[a], pos[k + a]); }
  const c = lo.map((v, a) => (v + hi[a]) / 2), p = new Float32Array(pos.length); for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) p[k + a] = pos[k + a] - c[a];
  const half = hi.map((v, a) => (v - lo[a]) / 2);
  accessors.push({ bufferView: push(p, 34962), componentType: 5126, count: p.length / 3, type: 'VEC3', min: half.map(v => -v), max: half });
  const prim = { attributes: { POSITION: accessors.length - 1 }, indices: 0 };
  if (nrm.length === pos.length) { accessors.push({ bufferView: push(new Float32Array(nrm), 34962), componentType: 5126, count: nrm.length / 3, type: 'VEC3' }); prim.attributes.NORMAL = accessors.length - 1; }
  accessors.push({ bufferView: push(new Uint32Array(idx), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' }); prim.indices = accessors.length - 1;
  meshes.push({ name, primitives: [prim] }); nodes.push({ name, mesh: meshes.length - 1 });
  console.log(`${name}: ${idx.length / 3} triangles, ${p.length / 3} vertices, diameter ${(2 * Math.max(...half) * 1000).toFixed(1)} mm`);
}
const bin = Buffer.concat(chunks);
const gltf = { asset: { version: '2.0', generator: 'ftc-biobuzz-sim convert-balls' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors, bufferViews: views, buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString('base64')}` }] };
fs.writeFileSync('public/balls.gltf', JSON.stringify(gltf)); console.log(`public/balls.gltf: ${(fs.statSync('public/balls.gltf').size / 1024).toFixed(0)} KB`);
