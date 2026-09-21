// Compares scripted strategies. Red varies when it starts FLOWER work;
// blue always starts at 66 seconds. Each cell is the mean over the seeds.
// Each alliance has two robots unless the fourth argument is solo. Both red robots use the red FLOWER start.
// Run: npx tsx scripts/sweep.ts [seeds=4] [redStarts=0,30,45,66,90] [blueStart=66] [partners|solo]
import RAPIER from '@dimforge/rapier3d-compat';
import { flowerLocked } from '../src/auto/executor';
import { Coach } from '../src/auto/coach';
import { DT, Sim } from '../src/sim/world';

const seeds = Number(process.argv[2] ?? 4), starts = (process.argv[3] ?? '0,30,45,66,90').split(',').map(Number), blueStart = Number(process.argv[4] ?? 66);
await RAPIER.init();
console.log('red FLOWER start | red   blue  margin | red TIPS  blue TIPS | red locked FLOWERS | red wins');
for (const start of starts) {
  let red = 0, blue = 0, rt = 0, bt = 0, locked = 0, wins = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const sim = new Sim(RAPIER, undefined, 'full', seed * 7, { opponent: true, partners: process.argv[5] !== 'solo' }); sim.start();
    const coaches = sim.robots.map(r => { const c = new Coach(); c.flowerStartSec = r.alliance === 'red' ? start : blueStart; return c; });
    while (sim.phase !== 'post') sim.step(coaches.map((c, i) => c.update(sim.view(i), DT)), coaches.map(() => true));
    const r = sim.score('red').total, b = sim.score('blue').total; red += r; blue += b; rt += sim.hives.red.tips; bt += sim.hives.blue.tips; wins += r > b ? 1 : 0;
    locked += sim.flowers.filter(f => flowerLocked(sim.view(0), f)).length;
  }
  const m = (v: number) => (v / seeds).toFixed(1).padStart(6);
  console.log(`${String(start === 0 ? 'never' : start + ' s').padStart(16)} |${m(red)}${m(blue)}${m(red - blue)}  |${m(rt)}${m(bt)}      |${m(locked)}              | ${wins}/${seeds}`);
}
