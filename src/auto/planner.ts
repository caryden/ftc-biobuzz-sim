import { FIELD, HIVE } from '../sim/config';

export interface Pt { x: number; z: number }
/** A capsule obstacle: a segment from a to b with radius r. A circle is a capsule whose ends coincide. */
export interface Capsule { a: Pt; b: Pt; r: number; /** A robot, not a FIELD element: a start inside its buffer just leaves, with no escape move first. */ soft?: boolean }

/** Planner tuning. `margin` is the clearance added to the robot's circumscribed radius, in meters. */
export const PLAN = { margin: 0.08 };

/** Gets the fixed obstacles at chassis height: the HIVE frame foot bars, the lower part of each leg, and the FLOWERS. */
export function fieldObstacles(): Capsule[] {
  const out: Capsule[] = [], fb = HIVE.footBar, f0 = HIVE.legFoot, f1 = HIVE.legTop, t = (0.34 - f0.y) / (f1.y - f0.y);
  for (const sx of [-1, 1]) {
    out.push({ a: { x: sx * fb.x, z: -fb.halfZ }, b: { x: sx * fb.x, z: fb.halfZ }, r: fb.halfX });
    // Only the part of a leg below the chassis top can touch the robot.
    for (const sz of [-1, 1]) out.push({ a: { x: sx * f0.x, z: sz * f0.z }, b: { x: sx * (f0.x + t * (f1.x - f0.x)), z: sz * (f0.z + t * (f1.z - f0.z)) }, r: 0.02 });
  }
  for (const f of FIELD.flowers) out.push({ a: f, b: f, r: 0.1 });
  return out;
}

const distPtSeg = (p: Pt, a: Pt, b: Pt) => {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz, t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z);
};
const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
/** Gets the shortest distance between two segments. */
export function distSegSeg(p1: Pt, p2: Pt, q1: Pt, q2: Pt): number {
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(distPtSeg(p1, q1, q2), distPtSeg(p2, q1, q2), distPtSeg(q1, p1, p2), distPtSeg(q2, p1, p2));
}

/**
 * Plans a path with a visibility graph and Dijkstra's algorithm.
 * @param robotRadius The robot's circumscribed radius. Obstacles grow by this radius plus a margin.
 * @returns Waypoints from start to goal, both included. A straight line if no route exists.
 */
export function planPath(start: Pt, goal: Pt, robotRadius: number, obstacles = fieldObstacles(), depth = 0): Pt[] {
  const grow = robotRadius + PLAN.margin, lim = FIELD.half - robotRadius * 0.72;
  // A start deep inside an obstacle's buffer, for example against a HIVE foot bar, first moves straight out of it.
  const deep = robotRadius * 0.72;
  const inside = obstacles.filter(o => !o.soft && distPtSeg(goal, o.a, o.b) > o.r + grow).map(o => ({ o, d: distPtSeg(start, o.a, o.b) })).filter(q => q.d < q.o.r + deep).sort((a, b) => a.d - b.d)[0];
  if (inside && depth < 2) {
    const { o } = inside, dx = o.b.x - o.a.x, dz = o.b.z - o.a.z, l2 = dx * dx + dz * dz, t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((start.x - o.a.x) * dx + (start.z - o.a.z) * dz) / l2));
    const cx = o.a.x + t * dx, cz = o.a.z + t * dz, nx = start.x - cx, nz = start.z - cz, n = Math.hypot(nx, nz) || 1e-6, out = o.r + grow * 0.9;
    const e = { x: Math.max(-lim, Math.min(lim, cx + (nx / n) * out)), z: Math.max(-lim, Math.min(lim, cz + (nz / n) * out)) };
    return [start, ...planPath(e, goal, robotRadius, obstacles, depth + 1)];
  }
  // A start only partly inside a buffer keeps that obstacle, with the buffer shrunk to the current distance. The path
  // then can't go deeper, and it doesn't bounce between "escape" and "continue" on every replan.
  const active = obstacles.filter(o => distPtSeg(goal, o.a, o.b) > o.r + grow)
    .map(o => ({ ...o, reach: Math.min(o.r + grow, Math.max(o.soft ? 0 : o.r + deep, distPtSeg(start, o.a, o.b) - 0.01)) }));
  const clear = (p: Pt, q: Pt) => active.every(o => distSegSeg(p, q, o.a, o.b) >= o.reach);
  if (clear(start, goal)) return [start, goal];
  const nodes: Pt[] = [start, goal];
  for (const o of active) for (const end of o.a === o.b ? [o.a] : [o.a, o.b]) for (let i = 0; i < 10; i++) {
    const ang = (i * Math.PI) / 5, R = (o.r + grow) * 1.15, p = { x: end.x + R * Math.cos(ang), z: end.z + R * Math.sin(ang) };
    if (Math.abs(p.x) < lim && Math.abs(p.z) < lim && active.every(q => distPtSeg(p, q.a, q.b) > q.reach)) nodes.push(p);
  }
  const n = nodes.length, dist = Array(n).fill(Infinity), prev = Array(n).fill(-1), done = Array(n).fill(false); dist[0] = 0;
  for (;;) {
    let u = -1; for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity || u === 1) break; done[u] = true;
    for (let v = 0; v < n; v++) {
      if (done[v]) continue; const d = dist[u] + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].z - nodes[v].z);
      if (d < dist[v] && clear(nodes[u], nodes[v])) { dist[v] = d; prev[v] = u; }
    }
  }
  if (dist[1] === Infinity) return [start, goal];
  const path: Pt[] = []; for (let i = 1; i >= 0; i = prev[i]) path.unshift(nodes[i]);
  return path;
}

/** Gets the total length of a path in meters. */
export const pathLength = (p: Pt[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.z - p[i].z), 0);

/** Gets the point that lies `ahead` meters along a path from its start. Used for pure-pursuit path following. */
export function pointAlong(path: Pt[], ahead: number): Pt {
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    if (ahead <= d) { const u = d === 0 ? 0 : ahead / d; return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * u, z: path[i - 1].z + (path[i].z - path[i - 1].z) * u }; }
    ahead -= d;
  }
  return path[path.length - 1];
}

/** Checks whether the straight segment between two points keeps the buffer from every fixed obstacle. */
export function segmentClear(p: Pt, q: Pt, robotRadius: number): boolean {
  return fieldObstacles().every(o => distSegSeg(p, q, o.a, o.b) >= o.r + robotRadius + PLAN.margin);
}

/**
 * Gets how to pick up a floor ball that lies inside the buffer of a HIVE foot bar or leg, for example a ball that
 * rests against the inside of a foot bar. The robot first lines up at `stage`, outside the buffer and square to the
 * obstacle, and then drives straight in to `touch`. Returns `open` for a ball in the open, and null if no pose works.
 */
export function ballApproach(ball: Pt, robotRadius: number, halfLength: number): 'open' | { stage: Pt; touch: Pt; heading: number } | null {
  const frame = fieldObstacles().filter(o => o.r <= 0.05), lim = FIELD.half - robotRadius * 0.72; let best: { o: Capsule; d: number; cx: number; cz: number } | null = null;
  for (const o of frame) { const dx = o.b.x - o.a.x, dz = o.b.z - o.a.z, l2 = dx * dx + dz * dz, t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((ball.x - o.a.x) * dx + (ball.z - o.a.z) * dz) / l2)), cx = o.a.x + t * dx, cz = o.a.z + t * dz, d = Math.hypot(ball.x - cx, ball.z - cz); if (!best || d < best.d) best = { o, d, cx, cz }; }
  if (!best || best.d > best.o.r + robotRadius + PLAN.margin) return 'open';
  const nx = (ball.x - best.cx) / (best.d || 1e-6), nz = (ball.z - best.cz) / (best.d || 1e-6), out = best.o.r + robotRadius + PLAN.margin + 0.03;
  const stage = { x: best.cx + nx * out, z: best.cz + nz * out }, touch = { x: ball.x + nx * (halfLength - 0.01), z: ball.z + nz * (halfLength - 0.01) };
  // The staging pose must itself be clear of every other frame part, and the robot must fit between ball and obstacle.
  if (Math.abs(stage.x) > lim || Math.abs(stage.z) > lim || frame.some(o => o !== best!.o && distPtSeg(stage, o.a, o.b) < o.r + robotRadius + 0.02)) return null;
  return { stage, touch, heading: Math.atan2(nz, -nx) };
}

/** Checks whether a robot can get its intake to a floor point: the point must not hug a HIVE foot bar or leg. */
export function reachable(p: Pt, robotHalfLength: number): boolean {
  return fieldObstacles().every(o => o.r > 0.05 || distPtSeg(p, o.a, o.b) > o.r + robotHalfLength + 0.06);
}
