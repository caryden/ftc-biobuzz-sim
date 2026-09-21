// Measures AUTO alone: points, TIPS, and how full the hoppers are when AUTO ends.
// Run: npx tsx scripts/auto-check.ts [seeds=8] [solo|partners]
import RAPIER from '@dimforge/rapier3d-compat';
import { Coach } from '../src/auto/coach';
import { DT, Sim } from '../src/sim/world';
await RAPIER.init(); const seeds = Number(process.argv[2] ?? 8), partners = process.argv[3] !== 'solo';
let pts = 0, tips = 0, hop = 0, robots = 0, tipDone: number[] = [];
for (let k = 0; k < seeds; k++) {
  const sim = new Sim(RAPIER, undefined, 'full', 2000 + 11 * k, { opponent: true, partners }); sim.start();
  const cs = sim.robots.map(() => new Coach()); let last = 0;
  while (sim.phase === 'auto') { sim.step(cs.map((c, i) => c.update(sim.view(i), DT)), cs.map(() => true)); if (sim.hives.red.tips > last) { last = sim.hives.red.tips; tipDone.push(30 - sim.timer); } }
  for (const a of ['red', 'blue'] as const) { const s = sim.score(a); pts += s.leave + s.autoPark + s.autoTips; tips += s.autoTips / 20; }
  sim.robots.forEach(r => { hop += r.carried.length; robots++; });
}
console.log(`${partners ? 'partners' : 'solo'}: AUTO points per alliance ${(pts / seeds / 2).toFixed(1)}, TIPS ${(tips / seeds / 2).toFixed(2)}, hopper at the end ${(hop / robots).toFixed(2)} of 4; red TIP times into AUTO: ${tipDone.slice(0, 9).map(t => t.toFixed(1)).join(', ')}`);
