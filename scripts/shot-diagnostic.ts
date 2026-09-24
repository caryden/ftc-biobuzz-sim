// Checks the shot preview against what launched elements do. For every TELEOP launch it records the robot's speed, what
// the mean shot preview predicted in the step before the launch, and whether the element then entered the CELL. It
// prints hit rates by speed and prediction. BOTS works as in scripts/eval-worker.ts. For robots that fired on the move,
// the preview agreed with the launch only 59% of the time, with no launch error: see e82 in experiments/policy-loop.md.
// Run: npx tsx scripts/shot-diagnostic.ts [seeds=8]
import RAPIER from '@dimforge/rapier3d-compat';
import { Coach } from '../src/auto/coach';
import { defaultBot, robotConfig, sanitize, type BotSetup } from '../src/setup';
import { DT, Sim } from '../src/sim/world';

await RAPIER.init();
const n = Number(process.argv[2] ?? 8), given: Partial<BotSetup>[] = JSON.parse(process.env.BOTS ?? '[]');
interface Shot { speed: number; mean: boolean; entered: boolean }
const shots: Shot[] = [];
for (let s = 0; s < n; s++) {
  const seed = 1001 + 37 * s, bots = [0, 1, 2, 3].map(i => sanitize({ ...defaultBot(i), ...(given[i] ?? {}) }, i));
  const sim = new Sim(RAPIER, undefined, 'full', seed, { opponent: true, partners: true, configFor: (a, slot) => robotConfig(bots[(a === 'red' ? 0 : 2) + slot]) }); sim.start();
  const coaches = sim.robots.map(() => new Coach());
  // Elements in flight: the shot record, the last position, and when tracking stops.
  const flying = new Map<number, { shot: Shot; hive: 'red' | 'blue'; prev: { x: number; y: number; z: number }; until: number }>();
  let t = 0;
  while (sim.phase !== 'post') {
    const inputs = coaches.map((c, k) => c.update(sim.view(k), DT));
    // Before the step: the predictions of each robot that presses a shoot button.
    const pre = sim.robots.map((r, k) => {
      const inp = inputs[k]; if (sim.phase !== 'teleop' || !(inp.shootPollen || inp.shootNectar) || !r.carried.length) return null;
      const v = sim.view(k), kind = r.carried[0] === 'pollen' ? 'pollen' : 'nectar';
      return { k, speed: v.telemetry.speed, mean: v.previewShot(kind).scores, p: r.body.translation() };
    });
    const before = new Set(sim.balls.keys());
    sim.step(inputs, coaches.map(() => true)); t += DT;
    for (const b of sim.balls.values()) {
      if (before.has(b.id)) continue;
      // A new element: the nearest robot that pressed a shoot button launched it.
      const q = b.body.translation(), from = pre.filter(x => x).sort((a, c) => Math.hypot(a!.p.x - q.x, a!.p.z - q.z) - Math.hypot(c!.p.x - q.x, c!.p.z - q.z))[0];
      if (!from || Math.hypot(from.p.x - q.x, from.p.z - q.z) > 0.6) continue;
      const shot = { speed: from.speed, mean: from.mean, entered: false }; shots.push(shot);
      flying.set(b.id, { shot, hive: sim.robots[from.k].alliance, prev: { x: q.x, y: q.y, z: q.z }, until: t + 3 });
    }
    for (const [id, f] of flying) {
      const b = sim.balls.get(id); if (!b || t > f.until) { flying.delete(id); continue; }
      const q = b.body.translation(), cur = { x: q.x, y: q.y, z: q.z };
      if (sim.hives[f.hive].entersMouth(f.prev, cur, b.radius)) { f.shot.entered = true; flying.delete(id); continue; }
      f.prev = cur;
    }
  }
}
const row = (name: string, pick: (s: Shot) => boolean) => {
  const g = shots.filter(pick), hit = g.filter(s => s.entered).length;
  console.log(`${name.padEnd(46)} ${String(g.length).padStart(5)} launches, ${g.length ? ((100 * hit) / g.length).toFixed(0).padStart(3) : '  -'}% entered`);
};
row('still (under 0.2 m/s), preview scores', s => s.speed < 0.2 && s.mean);
row('still, preview misses', s => s.speed < 0.2 && !s.mean);
row('moving (0.2 m/s or more), preview scores', s => s.speed >= 0.2 && s.mean);
row('moving, preview misses', s => s.speed >= 0.2 && !s.mean);
