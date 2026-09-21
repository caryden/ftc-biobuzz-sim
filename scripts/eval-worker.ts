// Runs one four-robot planner match and prints one JSON line with the score and a waste account per robot.
// Run: npx tsx scripts/eval-worker.ts <seed>. BOTS works as in scripts/match.ts. OPPONENT=none plays red alone, and
// REFEREE=1 adds the G421 PIN referee, whose MAJOR FOULS go to the other alliance's score.
import RAPIER from '@dimforge/rapier3d-compat';
import { Coach } from '../src/auto/coach';
import { EXEC } from '../src/auto/executor';
import { Referee } from '../src/ref/referee';
import { defaultBot, robotConfig, sanitize, type BotSetup } from '../src/setup';
import { DT, Sim } from '../src/sim/world';

const seed = Number(process.argv[2] ?? 1); await RAPIER.init();
if (process.env.OLD_TIP) EXEC.tipByMotion = false; // For comparisons with the old TIP test.
const given: Partial<BotSetup>[] = JSON.parse(process.env.BOTS ?? '[]'), bots = [0, 1, 2, 3].map(i => sanitize({ ...defaultBot(i), ...(given[i] ?? {}) }, i));
const sim = new Sim(RAPIER, undefined, 'full', seed, { opponent: process.env.OPPONENT !== 'none', partners: true, configFor: (a, slot) => robotConfig(bots[(a === 'red' ? 0 : 2) + slot]) }); sim.start();
const coaches = sim.robots.map((_, i) => { const c = new Coach(); c.flowerStartSec = bots[i].flowerStartSec; c.defense = bots[i].defense; c.autoOverride = bots[i].auto === 'default' || bots[i].auto === 'none' ? null : bots[i].auto; return c; });
// TELEOP seconds per robot by what the robot is doing. `toLaunch` is travel to the launch spot, `settle` is the last 0.3 m
// until the robot is on the spot and still, `waitCell` is on the spot while the target CELL isn't raised and at rest, `aim` is
// on the spot with the CELL ready and no shot, and `recover` is a stall back-off.
const KEYS = ['collect', 'toLaunch', 'settle', 'waitCell', 'aim', 'shoot', 'recover', 'yield', 'idle', 'flower', 'park'] as const; type Key = (typeof KEYS)[number];
const waste = sim.robots.map(() => Object.fromEntries(KEYS.map(k => [k, 0])) as Record<Key, number>), stalls = sim.robots.map(() => 0), stallAt = sim.robots.map(() => -1), launched = sim.robots.map(() => 0), had = sim.robots.map(r => r.carried.length);
let auto: { red: number; blue: number } | null = null; const referee = process.env.REFEREE ? new Referee() : null;
while (sim.phase !== 'post') {
  sim.step(coaches.map((c, k) => c.update(sim.view(k), DT)), coaches.map(() => true)); referee?.update(sim, DT);
  if (!auto && sim.phase === 'transition') { const r = sim.score('red'), b = sim.score('blue'); auto = { red: r.leave + r.autoPark + r.autoTips, blue: b.leave + b.autoPark + b.autoTips }; }
  if (sim.phase !== 'teleop') continue;
  coaches.forEach((c, k) => {
    const ex = c.executor as unknown as { tactic: string; note: string; stall: { at: number } | null; recoverUntil: number; t: number }, r = sim.robots[k], p = r.body.translation(), v = r.body.linvel(), g = r.plan.goal, n = r.carried.length;
    if (ex.stall && ex.stall.at !== stallAt[k]) { stallAt[k] = ex.stall.at; stalls[k]++; }
    const fired = n < had[k]; if (fired) launched[k] += had[k] - n; had[k] = n;
    const dist = g ? Math.hypot(g.x - p.x, g.z - p.z) : 9, at = dist < 0.16, slow = Math.hypot(v.x, v.z) < 0.12, h = sim.hives[r.alliance], ready = h.upCell === r.plan.side && Math.abs(Math.abs(h.phi) - 0.5236) < 0.03;
    const key: Key = ex.t < ex.recoverUntil ? 'recover' : ex.note.startsWith('yield') ? 'yield' : ex.note === 'park guard' || ex.tactic === 'park' ? 'park' : ex.tactic === 'work_flower' || ex.tactic.startsWith('collect_') ? 'flower'
      : !g ? 'idle' : r.plan.phase === 'launch' ? (fired ? 'shoot' : at && slow ? (ready ? 'aim' : 'waitCell') : dist < 0.3 ? 'settle' : 'toLaunch') : 'collect';
    waste[k][key] += DT;
  });
}
const r = sim.score('red'), b = sim.score('blue'), round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));
console.log(JSON.stringify({ seed, red: r.total, blue: b.total, fouls: { red: r.fouls, blue: b.fouls }, redTips: sim.hives.red.tips, blueTips: sim.hives.blue.tips, auto, park: r.park + b.park, stalls, launched, waste: waste.map(round) }));
