// Runs one four-robot planner match with the PIN referee and prints the wall-clock seconds of each part of the loop:
// physics (Sim.step), planner (Coach.update for every robot), and referee (Referee.update), with the final score.
// Run: npx tsx scripts/match-timing.ts [seed=11] [repeats=1]. With repeats above 1, it prints one line per match.
import RAPIER from '@dimforge/rapier3d-compat';
import { performance } from 'node:perf_hooks';
import { Coach } from '../src/auto/coach';
import { Referee } from '../src/ref/referee';
import { defaultBot, robotConfig, sanitize } from '../src/setup';
import { DT, Sim } from '../src/sim/world';

const [seedArg = '11', repeatArg = '1'] = process.argv.slice(2), seed = Number(seedArg); await RAPIER.init();
for (let k = 0; k < Number(repeatArg); k++) {
  const bots = [0, 1, 2, 3].map(i => sanitize(defaultBot(i), i));
  const sim = new Sim(RAPIER, undefined, 'full', seed, { opponent: true, partners: true, configFor: (a, slot) => robotConfig(bots[(a === 'red' ? 0 : 2) + slot]) }); sim.start();
  const coaches = sim.robots.map((_, i) => { const c = new Coach(); c.flowerStartSec = bots[i].flowerStartSec; c.defense = bots[i].defense; return c; });
  const referee = new Referee(), sec = { physics: 0, planner: 0, referee: 0 }, t0 = performance.now(); let steps = 0;
  while (sim.phase !== 'post') {
    const a = performance.now(), inputs = coaches.map((c, i) => c.update(sim.view(i), DT)), b = performance.now();
    sim.step(inputs, coaches.map(() => true)); const c = performance.now();
    referee.update(sim, DT); const d = performance.now();
    sec.planner += b - a; sec.physics += c - b; sec.referee += d - c; steps++;
  }
  const s = (ms: number) => +(ms / 1000).toFixed(2);
  console.log(JSON.stringify({ seed, steps, totalSec: s(performance.now() - t0), physicsSec: s(sec.physics), plannerSec: s(sec.planner), refereeSec: s(sec.referee),
    red: sim.score('red').total, blue: sim.score('blue').total, redTips: sim.hives.red.tips, blueTips: sim.hives.blue.tips }));
}
