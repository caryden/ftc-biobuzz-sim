// Plans the blind AUTO sweeps from data. For each role it runs many simulated AUTO periods, records where the
// collectable balls rest at the instant the sweep begins, prints a heatmap, and searches for the waypoints that
// collect the most balls with the intake leading. It writes the lanes into every `auto.sweep` leaf of the AUTO trees in
// src/auto/trees/auto/, by the leaf's `role`.
// Run: npx tsx scripts/plan-sweeps.ts [seeds=30]
import RAPIER from '@dimforge/rapier3d-compat';
import fs from 'node:fs';
import { segmentClear } from '../src/auto/planner';
import { Coach } from '../src/auto/coach';
import { AUTO_TUNING } from '../src/auto/onboard';
import { FIELD, HIVE } from '../src/sim/config';
import { DT, Sim } from '../src/sim/world';

type Pt = { x: number; z: number };
interface Snap { balls: Pt[]; free: number; start: Pt; clock: number }
const seeds = Number(process.argv[2] ?? 30), R = Math.hypot(0.43, 0.43) / 2, SWATH = 0.14;
// A ball that rests against a wall is out of reach for a robot that drives along the wall: the intake is narrower
// than the chassis. The robot gets it by facing the wall and strafing along it, 0.25 m out, which leaves 3.5 cm between
// the front of a 0.43 m robot and the wall. At 0.34 m the intake stopped 1 to 2 cm short of POLLEN that rests against the wall.
const WALL_LINE = FIELD.half - 0.25;
/** Gets the wall that a segment strafes along, if it runs on a wall line. */
const wallOf = (a: Pt, b: Pt): 'rear' | 'audience' | 'red' | null => { const on = (u: number, v: number, w: number) => Math.abs(u - w) < 0.01 && Math.abs(v - w) < 0.01; return on(a.z, b.z, -WALL_LINE) ? 'rear' : on(a.z, b.z, WALL_LINE) ? 'audience' : on(a.x, b.x, -WALL_LINE) ? 'red' : null; };
await RAPIER.init();

/** Runs AUTO and returns, per role, the floor balls at the moment that role's script reaches its first sweep lane. */
function snapshots(partners: boolean): Record<string, Snap[]> {
  const out: Record<string, Snap[]> = {};
  for (let k = 0; k < seeds; k++) {
    const sim = new Sim(RAPIER, undefined, 'full', 1000 + 7 * k, { opponent: true, partners }); sim.start();
    // The robot waits 2.5 s where its sweep would start, so the snapshot shows where the latest spill comes to rest.
    AUTO_TUNING.sweepSnapshotDelay = 2.5;
    const coaches = sim.robots.map(() => new Coach()), taken = new Set<number>();
    while (sim.phase === 'auto') {
      sim.step(coaches.map((c, i) => c.update(sim.view(i), DT)), coaches.map(() => true));
      coaches.forEach((c, i) => {
        const step = c.auto?.step; if (taken.has(i) || !step || step.do !== 'wait' || step.tag !== 'sweep') return; taken.add(i);
        const r = sim.robots[i], m = r.alliance === 'blue' ? -1 : 1, own = r.alliance === 'red' ? 'nectar_red' : 'nectar_blue', g = FIELD.garden.red, p = r.body.translation();
        // Blue robots are rotated 180° into the red frame, which doubles the data.
        const balls = [...sim.balls.values()].filter(b => (b.kind === 'pollen' || b.kind === own) && b.body.translation().y < 0.13).map(b => ({ x: m * b.body.translation().x, z: m * b.body.translation().z }))
          .filter(q => q.x < -0.05 && !(q.x > g[0] - 0.05 && q.x < g[1] + 0.05 && q.z > g[2] - 0.05));
        const role = !partners ? 'solo' : r.slot === 0 ? 'right' : 'left';
        (out[role] ??= []).push({ balls, free: r.cfg.capacity - r.carried.length, start: { x: m * p.x, z: m * p.z }, clock: sim.timer });
      });
    }
  }
  return out;
}

/** Counts the balls that a path collects in one snapshot: within the intake swath of a segment, up to the free slots. */
function collected(path: Pt[], snap: Snap): number {
  const got = new Set<number>();
  for (let i = 1; i < path.length && got.size < snap.free; i++) {
    const a = path[i - 1], b = path[i], dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1e-6, wall = wallOf(a, b);
    if (wall) { // Facing the wall: the intake takes the balls between the robot's front and the wall, across the strafed span.
      const along = (q: Pt) => (wall === 'red' ? q.z : q.x), lo = Math.min(along(a), along(b)) - 0.15, hi = Math.max(along(a), along(b)) + 0.15, depth = (q: Pt) => FIELD.half - (wall === 'red' ? -q.x : wall === 'rear' ? -q.z : q.z);
      snap.balls.map((q, k) => ({ k, q })).filter(h => !got.has(h.k) && depth(h.q) < 0.2 && depth(h.q) > 0 && along(h.q) > lo && along(h.q) < hi).sort((u, v) => Math.abs(along(u.q) - along(a)) - Math.abs(along(v.q) - along(a))).forEach(h => { if (got.size < snap.free) got.add(h.k); });
      continue;
    }
    // Balls are taken in the order that the robot reaches them along the segment.
    snap.balls.map((q, k) => ({ k, t: ((q.x - a.x) * dx + (q.z - a.z) * dz) / len, d: Math.abs((q.x - a.x) * dz - (q.z - a.z) * dx) / len }))
      .filter(h => !got.has(h.k) && h.d < SWATH && h.t > 0.1 && h.t < len + 0.2).sort((u, v) => u.t - v.t).forEach(h => { if (got.size < snap.free) got.add(h.k); });
  }
  return got.size;
}

function heatmap(snaps: Snap[]) {
  const cell = 0.2, rows: string[] = [];
  for (let z = -1.7; z <= 1.71; z += cell) { let line = ''; for (let x = -1.7; x < 0; x += cell) { const n = snaps.reduce((s, sn) => s + sn.balls.filter(q => Math.abs(q.x - x) < cell / 2 && Math.abs(q.z - z) < cell / 2).length, 0) / snaps.length; line += n < 0.03 ? ' . ' : (n * 10).toFixed(0).padStart(2) + ' '; } rows.push(`z ${z.toFixed(1).padStart(5)} |${line}|`); }
  console.log('        x: -1.7 (red wall) ... -0.1 (center line). Each number is 10 x the mean balls per 0.2 m cell.'); console.log(rows.join('\n'));
}

function plan(snaps: Snap[], parkAt: Pt | null, keep: (q: Pt) => boolean): { lanes: (number | string)[][]; mean: number } {
  const start = { x: snaps.reduce((s, q) => s + q.start.x, 0) / snaps.length, z: snaps.reduce((s, q) => s + q.start.z, 0) / snaps.length };
  const clock = snaps.reduce((s, q) => s + q.clock, 0) / snaps.length, budget = Math.max(1.5, (clock - 5.5) * 0.9); // Meters that fit before the PARK, with turns and stops.
  const lim = FIELD.half - R * 0.75, cands: Pt[] = [];
  // The grid includes the lines that hug each wall, because that is where spilled balls come to rest.
  const xs: number[] = [], zs: number[] = []; for (let x = -lim; x <= -0.3; x += 0.15) xs.push(x); for (let z = -lim; z < lim; z += 0.15) zs.push(z); zs.push(lim, -WALL_LINE, WALL_LINE); xs.push(-WALL_LINE);
  for (const x of xs) for (const z of zs) if (keep({ x, z })) cands.push({ x, z });
  const score = (path: Pt[]) => { const len = path.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - path[i].x, q.z - path[i].z), 0); if (len > budget) return -1;
    const mean = snaps.reduce((s, sn) => s + collected(path, sn), 0) / snaps.length, end = path[path.length - 1]; return mean - 0.22 * len - (parkAt ? 0.12 * Math.hypot(end.x - parkAt.x, end.z - parkAt.z) : 0); };
  let beam: { path: Pt[]; s: number }[] = [{ path: [start], s: 0 }], best = beam[0];
  for (let depth = 0; depth < 4; depth++) {
    const next: { path: Pt[]; s: number }[] = [];
    for (const b of beam) for (const c of cands) { const at = b.path[b.path.length - 1], d = Math.hypot(c.x - at.x, c.z - at.z); if (d < 0.35 || d > 1.8 || !segmentClear(at, c, R)) continue; const path = [...b.path, c], s = score(path); if (s >= 0) next.push({ path, s }); }
    next.sort((u, v) => v.s - u.s); beam = next.slice(0, 40); if (beam[0] && beam[0].s > best.s + 0.12) best = beam[0];
  }
  return { lanes: best.path.slice(1).map((q, i) => { const w = wallOf(best.path[i], q); return w ? [+q.x.toFixed(3), +q.z.toFixed(3), w] : [+q.x.toFixed(3), +q.z.toFixed(3)]; }), mean: snaps.reduce((s, sn) => s + collected(best.path, sn), 0) / snaps.length };
}

const park = { x: -(FIELD.half - 0.43 / 2 - 0.06), z: -0.9 }, all = { ...snapshots(false), ...snapshots(true) }, out: Record<string, (number | string)[][]> = {};
void HIVE;
for (const role of ['solo', 'right', 'left']) {
  const snaps = all[role] ?? []; if (!snaps.length) { console.log(`\n${role}: no script reached its sweep`); continue; }
  console.log(`\n=== ${role}: ${snaps.length} snapshots, sweep starts at clock ${(snaps.reduce((s, q) => s + q.clock, 0) / snaps.length).toFixed(1)} s with ${(snaps.reduce((s, q) => s + q.free, 0) / snaps.length).toFixed(1)} free slots, ${(snaps.reduce((s, q) => s + q.balls.length, 0) / snaps.length).toFixed(1)} collectable balls on the own side`);
  // Partners keep to their own half of the alliance's side, so their sweeps never cross: the lead robot works the
  // audience half and its partner the rear half. A solo robot may go anywhere on its side.
  heatmap(snaps); const p = plan(snaps, park, q => (role === 'right' ? q.z > 0.3 : role === 'left' ? q.z < -0.3 : true)); out[role] = p.lanes as (number | string)[][];
  console.log(`planned lanes ${JSON.stringify(p.lanes)} collect ${p.mean.toFixed(2)} balls per sweep in the snapshots`);
}
// Write each role's lanes into the sweeps of that role, in every tree. A role with no snapshots keeps its lanes. The
// planning above works in the simulator's x and z, and a tree file is in FIELD x and y, where y is the negative of z.
for (const file of fs.readdirSync('src/auto/trees/auto').filter(f => f.endsWith('.json'))) {
  const path = `src/auto/trees/auto/${file}`, tree = JSON.parse(fs.readFileSync(path, 'utf8')); let changed = 0;
  const visit = (n: unknown) => {
    if (typeof n !== 'object' || n === null) return;
    const node = n as { ref?: string; params?: { role?: string; lanes?: unknown } };
    if (node.ref === 'auto.sweep' && node.params?.role && out[node.params.role]) { node.params.lanes = out[node.params.role].map(([x, z, wall]) => ({ x, y: -z, wall: wall ?? null })); changed++; }
    Object.values(n).forEach(visit);
  };
  visit(tree.root);
  if (changed) { fs.writeFileSync(path, JSON.stringify(tree, null, 1) + '\n'); console.log(`wrote ${changed} sweeps in ${path}`); }
}
