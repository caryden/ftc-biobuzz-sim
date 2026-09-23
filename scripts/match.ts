// Runs one headless match with the planner on every robot, and prints a timeline for red robot 0 and the final score.
// The defaults match the app: every robot keeps tipping.
// To give robots the setups of the app's robot config, set BOTS to a JSON list of four partial setups in R0, R1, B0, B1
// order, for example BOTS='[{"shooter":"fifo","driveRpm":500,"sizeIn":15}]'. A setup's flowerStartSec wins over the arguments.
// Run: npx tsx scripts/match.ts [full|teleop] [auto routine] [seed=11] [opponent|none] [partners|solo] [blueFlowerStart=0] [partnerFlowerStart=0] [ownFlowerStart=0]
import RAPIER from '@dimforge/rapier3d-compat';
import { Coach } from '../src/auto/coach';
import { Referee } from '../src/ref/referee';
import { DT, NO_INPUT, Sim, code } from '../src/sim/world';
import { defaultBot, robotConfig, sanitize, type BotSetup } from '../src/setup';

const [mode = 'full', routine = 'solo-two-tip-sweep', seedArg = '11', oppArg = 'opponent', partnerArg = 'partners', blueStart = '0', partnerStart = '0', ownStart = '0'] = process.argv.slice(2);
await RAPIER.init();
const given: Partial<BotSetup>[] = JSON.parse(process.env.BOTS ?? '[]'), bots = [0, 1, 2, 3].map(i => sanitize({ ...defaultBot(i), ...(given[i] ?? {}) }, i));
const sim = new Sim(RAPIER, undefined, mode === 'teleop' ? 'teleop' : 'full', Number(seedArg), { opponent: oppArg !== 'none', partners: partnerArg !== 'solo', configFor: (a, slot) => robotConfig(bots[(a === 'red' ? 0 : 2) + slot]) }); sim.start();
const coaches = sim.robots.map((r, i) => { const c = new Coach(); c.autoRoutine = routine; const k = (r.alliance === 'red' ? 0 : 2) + r.slot; c.flowerStartSec = given[k]?.flowerStartSec ?? Number(i === 0 ? ownStart : r.alliance === 'red' ? partnerStart : blueStart); return c; });
const referee = new Referee(), ex = coaches[0].executor; let t = 0, nextLog = 0, lastKey = '', lastStall = -1; const stalls = coaches.map(() => 0), stallAt = coaches.map(() => -1);
const log = (note: string) => { const p = sim.robot.translation();
  console.log(`${sim.phase.padEnd(7)} ${sim.timer.toFixed(0).padStart(3)}s ${ex.tactic.padEnd(18)} ${(ex.flowerId ?? '').padEnd(8)} pos ${p.x.toFixed(1)},${p.z.toFixed(1)} carry [${sim.carried.map(code)}] cell ${sim.cellCount('red')} tips ${sim.hives.red.tips} score ${sim.score('red').total} ${note}`); };

while (sim.phase !== 'post') {
  for (let i = 0; i < 0.1 / DT && sim.phase !== 'post'; i++) { sim.step(coaches.map((c, k) => c.update(sim.view(k), DT)), coaches.map(() => true)); referee.update(sim, DT); t += DT; }
  coaches.forEach((c, k) => { const s = c.executor.stall; if (s && s.at !== stallAt[k]) { stallAt[k] = s.at; stalls[k]++; } });
  if (ex.stall && ex.stall.at !== lastStall) { lastStall = ex.stall.at; log(`STALL at ${ex.stall.target}: ${ex.stall.reason}`); }
  const key = sim.phase === 'auto' ? coaches[0].auto?.note ?? '' : ex.tactic + ex.note + ex.status;
  if (t >= nextLog || key !== lastKey) { lastKey = key; log(sim.phase === 'auto' ? key : `${ex.status} ${ex.note}`); nextLog = t + 10; }
}
for (let i = 0; i < 3 / DT; i++) sim.step(NO_INPUT);
console.log(`\nSTALLS ${sim.robots.map((r, k) => `${r.alliance === 'red' ? 'R' : 'B'}${r.slot} ${stalls[k]}`).join(', ')}`);
console.log(`FOUL POINTS red ${sim.foulPoints.red} blue ${sim.foulPoints.blue}`);
console.log('FINAL red ', JSON.stringify(sim.score('red')));
if (sim.robots.some(r => r.alliance === 'blue')) console.log('FINAL blue', JSON.stringify(sim.score('blue')));
console.log('FLOWERS', sim.flowers.map(f => `${f.id}: [${f.stack.map(code)}]`).join('  '));
