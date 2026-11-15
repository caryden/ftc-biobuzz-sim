// Turns a parts file from step-to-parts.py into a GLB for the simulator: tiny hardware dropped, each part simplified
// and colored from step-colors.py, merged by color, Y up, centered on its drivetrain footprint on the floor, and turned
// so the robot's front faces +X. The front is where the intake wheels sit (parts named intake, Gecko or omni), unless
// FRONT=+x, -x, +z or -z says which way it faces in the CAD. Also writes OUT.json with the footprint and the height.
// Run: node bench/tools/parts-to-glb.mjs IN.parts COLORS.json OUT.glb [maxTriangles=80000]
import fs from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';

const [src, colorsPath, out, maxArg] = process.argv.slice(2);
const MAX_TRIS = Number(maxArg ?? 80000);
const MIN_DIAGONAL = 0.015; // m. Screws, nuts and washers below this don't show at field scale.
await MeshoptSimplifier.ready;

const norm = s => s.replace(/\\X2\\[0-9A-F]+\\X0\\|\\X\\[0-9A-F]{2}/g, '').replace(/\s+/g, '').replace(/\d{3}$/, '').toLowerCase();
const colors = new Map(Object.entries(JSON.parse(fs.readFileSync(colorsPath, 'utf8'))).map(([k, v]) => [norm(k), v]));

// Read the parts.
const buf = fs.readFileSync(src);
const parts = [];
for (let o = 0; o < buf.length;) {
  const hl = buf.readUInt32LE(o), nv = buf.readUInt32LE(o + 4), nf = buf.readUInt32LE(o + 8); o += 12;
  const head = JSON.parse(buf.toString('utf8', o, o + hl)); o += hl;
  const pos = new Float32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + nv * 12)); o += nv * 12;
  const idx = new Uint32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + nf * 12)); o += nf * 12;
  // Onshape is Z up; glTF and the simulator are Y up.
  for (let k = 0; k < pos.length; k += 3) { const y = pos[k + 1]; pos[k + 1] = pos[k + 2]; pos[k + 2] = -y; }
  parts.push({ ...head, pos, idx });
}
const bbox = p => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let k = 0; k < p.length; k += 3) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], p[k + a]); b[a + 3] = Math.max(b[a + 3], p[k + a]); } return b; };
for (const p of parts) p.box = bbox(p.pos);
const sized = parts.filter(p => Math.hypot(p.box[3] - p.box[0], p.box[4] - p.box[1], p.box[5] - p.box[2]) >= MIN_DIAGONAL);
// The floor is where the wheels touch: a low percentile of the parts' bottoms, so one part left unmated below the robot
// doesn't move it. Parts entirely below the floor are dropped and listed in OUT.json.
const bottoms = sized.map(p => p.box[1]).sort((a, b) => a - b), floor = bottoms[Math.floor(bottoms.length * 0.05)];
const below = sized.filter(p => p.box[4] < floor - 0.005);
const kept = sized.filter(p => !below.includes(p));
// Simplify each part on its own, so the error stays relative to that part, and drop the vertices no triangle uses.
const total = kept.reduce((s, p) => s + p.idx.length / 3, 0), ratio = Math.min(1, MAX_TRIS / total);
for (const p of kept) {
  const want = Math.max(12, Math.floor((p.idx.length / 3) * ratio)) * 3;
  let idx = p.idx;
  if (want < idx.length) idx = MeshoptSimplifier.simplify(idx, p.pos, 3, want, 0.02)[0];
  const remap = new Int32Array(p.pos.length / 3).fill(-1), pos = [];
  p.idx = idx.map(i => { if (remap[i] < 0) { remap[i] = pos.length / 3; pos.push(p.pos[3 * i], p.pos[3 * i + 1], p.pos[3 * i + 2]); } return remap[i]; });
  p.pos = new Float32Array(pos);
}

// Center on the drivetrain: the footprint of everything within 8 cm of the floor, so arms and the turret don't pull it.
const base = [Infinity, Infinity, -Infinity, -Infinity];
for (const p of kept) for (let k = 0; k < p.pos.length; k += 3) if (p.pos[k + 1] < floor + 0.08) {
  base[0] = Math.min(base[0], p.pos[k]); base[1] = Math.min(base[1], p.pos[k + 2]); base[2] = Math.max(base[2], p.pos[k]); base[3] = Math.max(base[3], p.pos[k + 2]);
}
const center = [(base[0] + base[2]) / 2, floor, (base[1] + base[3]) / 2];

// The front: where the parts named for the intake end sit, relative to the center, snapped to the nearest axis.
const front = kept.filter(p => /front|intake|funnel|gecko|omni/i.test(p.name));
const given = { '+x': 0, '-x': Math.PI, '+z': -Math.PI / 2, '-z': Math.PI / 2 }[process.env.FRONT ?? ''];
let yaw = given ?? 0;
if (given === undefined && front.length) {
  const fx = front.reduce((s, p) => s + (p.box[0] + p.box[3]) / 2, 0) / front.length - center[0];
  const fz = front.reduce((s, p) => s + (p.box[2] + p.box[5]) / 2, 0) / front.length - center[2];
  // Turn about Y so that (fx, fz) points along +X.
  yaw = Math.round(Math.atan2(fz, fx) / (Math.PI / 2)) * (Math.PI / 2);
}
const cy = Math.cos(yaw), sy = Math.sin(yaw);
for (const p of kept) for (let k = 0; k < p.pos.length; k += 3) {
  const x = p.pos[k] - center[0], z = p.pos[k + 2] - center[2];
  p.pos[k] = x * cy + z * sy; p.pos[k + 1] -= center[1]; p.pos[k + 2] = -x * sy + z * cy;
}

// Merge by color, then simplify each group in proportion to its size.
const groups = new Map();
let unmatched = 0;
for (const p of kept) {
  const c = colors.get(norm(p.name)) ?? (unmatched++, [0.55, 0.57, 0.6]);
  const key = c.map(v => v.toFixed(3)).join(','); const g = groups.get(key) ?? { color: c, pos: [], idx: [] }; groups.set(key, g);
  const base = g.pos.length / 3; for (const v of p.pos) g.pos.push(v); for (const i of p.idx) g.idx.push(i + base);
}
const meshes = [...groups.values()].map(g => ({ color: g.color, pos: new Float32Array(g.pos), idx: new Uint32Array(g.idx) }));

// A minimal GLB: one node per color.
const gltf = { asset: { version: '2.0', generator: 'cad parts-to-glb' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
const chunks = []; let len = 0;
const view = (arr, target) => { const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); chunks.push(b); const pad = (4 - (b.length % 4)) % 4; if (pad) chunks.push(Buffer.alloc(pad)); gltf.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.length, target }); len += b.length + pad; return gltf.bufferViews.length - 1; };
let tris = 0;
for (const m of meshes) {
  const b = bbox(m.pos);
  gltf.materials.push({ pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: 0.1, roughnessFactor: 0.7 } });
  gltf.accessors.push({ bufferView: view(m.pos, 34962), componentType: 5126, count: m.pos.length / 3, type: 'VEC3', min: b.slice(0, 3), max: b.slice(3) });
  gltf.accessors.push({ bufferView: view(m.idx, 34963), componentType: 5125, count: m.idx.length, type: 'SCALAR' });
  gltf.meshes.push({ primitives: [{ attributes: { POSITION: gltf.accessors.length - 2 }, indices: gltf.accessors.length - 1, material: gltf.materials.length - 1 }] });
  gltf.nodes.push({ mesh: gltf.meshes.length - 1 }); gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  tris += m.idx.length / 3;
}
const bin = Buffer.concat(chunks); gltf.buffers.push({ byteLength: bin.length });
let json = Buffer.from(JSON.stringify(gltf)); const jpad = (4 - (json.length % 4)) % 4; json = Buffer.concat([json, Buffer.alloc(jpad, 0x20)]);
const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const ch = (n, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(n, 0); h.writeUInt32LE(type, 4); return h; };
fs.writeFileSync(out, Buffer.concat([header, ch(json.length, 0x4e4f534a), json, ch(bin.length, 0x004e4942), bin]));

const box = meshes.reduce((b, m) => { const x = bbox(m.pos); return [0, 1, 2].map(i => Math.min(b[i], x[i])).concat([3, 4, 5].map(i => Math.max(b[i], x[i]))); }, [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
// The footprint is the drivetrain's, turned with the robot; the height is the whole robot's.
const turned = Math.abs(Math.sin(yaw)) > 0.5;
const [bx, bz] = [base[2] - base[0], base[3] - base[1]];
const size = { length: +(turned ? bz : bx).toFixed(4), width: +(turned ? bx : bz).toFixed(4), height: +(box[4] - box[1]).toFixed(4) };
fs.writeFileSync(out.replace(/\.glb$/, '.json'), JSON.stringify({ ...size, droppedBelowFloor: below.map(p => p.name), frontFoundBy: front.map(p => p.name).slice(0, 8), turnedDeg: Math.round((yaw * 180) / Math.PI) }, null, 1) + '\n');
console.log(`${kept.length} of ${parts.length} parts, ${groups.size} colors (${unmatched} parts without one), ${tris} triangles, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`, size);
