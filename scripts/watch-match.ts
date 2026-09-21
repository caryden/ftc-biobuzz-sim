// "Watches" scripted four-robot matches and reports driving-quality metrics per robot, because a score hides
// hesitation. The third argument sets the convention for all four robots.
// Run: npx tsx scripts/watch-match.ts [seeds=4] [verbose|quiet] [sides|routes|none]
import RAPIER from '@dimforge/rapier3d-compat';
import { Coach } from '../src/auto/coach';
import { DT, Sim } from '../src/sim/world';

const seeds = Number(process.argv[2] ?? 4), verbose = process.argv[3] === 'verbose', convention = (process.argv[4] ?? 'routes') as 'sides' | 'routes' | 'none';
await RAPIER.init();
const total = { teleopTips: 0, parked: 0, crossings: 0, switches: 0, reversals: 0, farPicks: 0, picks: 0, bumpsWhileLaunching: 0, partnerContactSec: 0, idleSec: 0, meters: 0, elements: 0, pushedBalls: 0, underHivePicks: 0, red: 0, blue: 0, tips: 0, autoPts: 0 };
for (let k = 0; k < seeds; k++) {
  const sim = new Sim(RAPIER, undefined, 'full', 101 + 13 * k, { opponent: true, partners: true }); sim.start();
  const coaches = sim.robots.map(r => { const c = new Coach(); c.executor.convention = convention; return c; }); // Every robot follows the convention.
  const st = sim.robots.map(r => ({ goal: '', goalCarried: r.carried.length, lastCmd: { x: 0, z: 0 }, lastFlip: -9, carried: r.carried.length, pos: r.body.translation() })); let t = 0, autoPts = 0;
  while (sim.phase !== 'post') {
    sim.step(coaches.map((c, i) => c.update(sim.view(i), DT)), coaches.map(() => true)); t += DT;
    if (sim.phase === 'transition' && !autoPts) { const r = sim.score('red'); autoPts = r.leave + r.autoPark + r.autoTips; }
    if (sim.phase !== 'teleop') continue;
    sim.robots.forEach((r, i) => {
      if (r.alliance !== 'red') return; const s = st[i], ex = coaches[i].executor, p = r.body.translation(), v = sim.view(i), th = v.heading;
      if (Math.sign(p.z) !== Math.sign(s.pos.z) && Math.abs(p.x) > 0.7) total.crossings++; // An end-to-end run past the HIVE.
      total.meters += Math.hypot(p.x - s.pos.x, p.z - s.pos.z); s.pos = { ...p };
      // An abandoned goal: the goal changed although the hopper is the same as when the goal was set, so the robot
      // neither picked up what it went for nor launched what it lined up for.
      const goal = (ex as unknown as { goalKey: string }).goalKey;
      if (goal && goal !== s.goal) { const abandoned = s.goal && r.carried.length === s.goalCarried; s.goalCarried = r.carried.length; if (abandoned) { total.switches++; if (verbose) console.log(`${sim.timer.toFixed(1)} robot ${i} switched ${s.goal} -> ${goal}`); } s.goal = goal; }
      // A course reversal: the robot's velocity turns by more than 120 degrees within one second. Braking with reverse
      // power doesn't count, because it doesn't turn the velocity around.
      const vel = r.body.linvel(), m = Math.hypot(vel.x, vel.z), lm = Math.hypot(s.lastCmd.x, s.lastCmd.z);
      if (m > 0.35 && lm > 0.35 && (vel.x * s.lastCmd.x + vel.z * s.lastCmd.z) / (m * lm) < -0.5 && t - s.lastFlip > 1) { total.reversals++; s.lastFlip = t; }
      if (m > 0.35) s.lastCmd = { x: vel.x, z: vel.z };
      void th;
      if (r.carried.length > s.carried) {
        total.picks++; total.elements += r.carried.length - s.carried; if (Math.abs(p.x) < 0.58 && Math.abs(p.z) < 0.6) total.underHivePicks++;
      }
      s.carried = r.carried.length;
      if (Math.hypot(r.body.linvel().x, r.body.linvel().z) < 0.05) total.idleSec += DT;
      const mate = sim.robots.find((q, j) => j !== i && q.alliance === r.alliance);
      if (mate) { const q = mate.body.translation(), d = Math.hypot(p.x - q.x, p.z - q.z); if (d < 0.5) { total.partnerContactSec += DT; if (mate.intent.includes('launch') || (mate.lastCmd.forward === 0 && mate.lastCmd.strafeRight === 0 && mate.carried.length > 0)) total.bumpsWhileLaunching += DT; } }
    });
  }
  const r = sim.score('red'); total.red += r.total; total.parked += r.park / 5; total.teleopTips += r.teleopTips / 20; total.blue += sim.score('blue').total; total.tips += sim.hives.red.tips; total.autoPts += autoPts;
  // Balls that rest under the HIVE at the end: nobody went for them.
  total.pushedBalls += [...sim.balls.values()].filter(b => { const q = b.body.translation(); return q.y < 0.13 && Math.abs(q.x) < 0.58 && Math.abs(q.z) < 0.6; }).length;
}
const n = seeds, f = (v: number, d = 1) => (v / n).toFixed(d);
console.log(`Per match, red alliance (two robots), ${n} seeds, convention ${convention}:`);
console.log(`  seconds per TIP in TELEOP: ${(120 * n / Math.max(1, total.teleopTips)).toFixed(1)}`);
console.log(`  score ${f(total.red, 0)} (blue ${f(total.blue, 0)}), TIPS ${f(total.tips)}, AUTO points ${f(total.autoPts, 0)}`);
console.log(`  goals abandoned before they were achieved: ${f(total.switches)}    course reversals: ${f(total.reversals)}`);
console.log(`  seconds within 0.5 m of the partner: ${f(total.partnerContactSec)}    of those while the partner holds still with a load: ${f(total.bumpsWhileLaunching)}`);
console.log(`  seconds nearly still in TELEOP: ${f(total.idleSec)} of 240 robot-seconds`);
console.log(`  meters driven per element collected: ${(total.meters / Math.max(1, total.elements)).toFixed(2)}    elements collected: ${f(total.elements)}`);
console.log(`  robots parked at the end: ${f(total.parked, 2)} of 2    runs from one end of the FIELD to the other: ${f(total.crossings)}`);
console.log(`  pickups under the HIVE: ${f(total.underHivePicks)}    balls left under the HIVE at the end: ${f(total.pushedBalls)}`);
