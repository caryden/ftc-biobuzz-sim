// Prints the AUTO timeline of the two red robots: every script step change, every red TIP, and the AUTO score.
// Run: npx tsx scripts/auto-timeline.ts [seed=1001] [rightScript,leftScript]. An empty name keeps the default script.
import RAPIER from '@dimforge/rapier3d-compat';
import { Coach } from '../src/auto/coach';
import { defaultBot, robotConfig } from '../src/setup';
import { DT, Sim, code } from '../src/sim/world';

await RAPIER.init(); const sim = new Sim(RAPIER, undefined, 'auto', Number(process.argv[2] ?? 1001), { opponent: true, partners: true, configFor: (a, slot) => robotConfig(defaultBot((a === 'red' ? 0 : 2) + slot)) }); sim.start();
const names = (process.argv[3] ?? '').split(','), coaches = sim.robots.map(r => { const c = new Coach(); if (names[r.slot]) c.autoOverride = names[r.slot]; return c; }), last = ['', '']; let tips = 0, t = 0;
while (sim.phase !== 'post') {
  sim.step(coaches.map((c, k) => c.update(sim.view(k), DT)), coaches.map(() => true)); t += DT;
  for (const k of [0, 1]) { const n = coaches[k].script?.note ?? ''; if (n === last[k]) continue; last[k] = n; const p = sim.robots[k].body.translation(); console.log(`${t.toFixed(1).padStart(5)} s R${k} field (${p.x.toFixed(2)}, ${(-p.z).toFixed(2)}) [${sim.robots[k].carried.map(code)}] ${n}`); }
  if (sim.hives.red.tips !== tips) { tips = sim.hives.red.tips; console.log(`${t.toFixed(1).padStart(5)} s    red TIP ${tips}: the ${sim.hives.red.upCell} CELL is up`); }
}
const r = sim.score('red'); console.log(`AUTO red ${r.total}: ${r.autoTips / 20} TIPS, LEAVE ${r.leave}, PARK ${r.autoPark}, hoppers ${sim.robots.slice(0, 2).map(q => `[${q.carried.map(code)}]`).join(' ')}, ${sim.cellCount('red')} in the raised CELL`);
