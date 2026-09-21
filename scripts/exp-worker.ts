// Runs one four-robot scripted match for an experiment spec and prints one JSON line. 
// Run: npx tsx scripts/exp-worker.ts <specId> <seed>
import RAPIER from '@dimforge/rapier3d-compat';
import { EXEC, flowerLocked } from '../src/auto/executor';
import { FOLLOW } from '../src/auto/follow';
import { PLAN } from '../src/auto/planner';
import { Coach } from '../src/auto/coach';
import { defaultBot, robotConfig } from '../src/setup';
import { DT, NO_INPUT, Sim } from '../src/sim/world';
import { SPECS, type Side } from './exp-specs';

const [id, seedArg] = process.argv.slice(2), spec = SPECS[id], seed = Number(seedArg); if (!spec) throw new Error(`Unknown spec ${id}`);
const g = spec.global ?? {}; if (g.margin !== undefined) PLAN.margin = g.margin; if (g.vMax !== undefined) FOLLOW.vMax = g.vMax; if (g.decel !== undefined) FOLLOW.decel = g.decel; if (g.lookahead !== undefined) FOLLOW.lookahead = g.lookahead; if (g.standoff !== undefined) EXEC.standoff = g.standoff; if (g.kv !== undefined) FOLLOW.kv = g.kv;
await RAPIER.init();
const side = (a: 'red' | 'blue'): Side => spec[a] ?? {};
const sim = new Sim(RAPIER, undefined, 'full', seed, { opponent: true, partners: true, configFor: (a, slot) => { const c = robotConfig(defaultBot((a === 'red' ? 0 : 2) + slot)); side(a).cfg?.(c, slot); return c; } });
const coaches = sim.robots.map(r => { const s = side(r.alliance), c = new Coach(); c.flowerStartSec = s.flowerStart?.[r.slot] ?? 0; c.autoOverride = s.auto?.[r.slot] ?? null; c.scriptTuning = s.tuning ?? {}; return c; });
sim.start(); let stalls = 0; const seen = new Set<string>(); let auto: Record<string, number> | null = null, hopper = 0;
while (sim.phase !== 'post') {
  sim.step(coaches.map((c, i) => (sim.phase === 'auto' && c.autoOverride === 'none' ? NO_INPUT : c.update(sim.view(i), DT))), coaches.map(() => true));
  coaches.forEach((c, i) => { const st = c.executor.stall; if (sim.robots[i].alliance === 'red' && st && !seen.has(`${i}:${st.at}`)) { seen.add(`${i}:${st.at}`); stalls++; } });
  if (!auto && sim.phase === 'transition') { const r = sim.score('red'); auto = { points: r.leave + r.autoPark + r.autoTips, tips: r.autoTips / 20 }; hopper = sim.robots.filter(q => q.alliance === 'red').reduce((n, q) => n + q.carried.length, 0); }
}
const r = sim.score('red'), b = sim.score('blue');
console.log(JSON.stringify({ id, group: spec.group, seed, red: r.total, blue: b.total, margin: r.total - b.total, redTips: sim.hives.red.tips, blueTips: sim.hives.blue.tips, redFlowerPts: r.flower + r.bottomNectar, locked: sim.flowers.filter(f => flowerLocked(sim.view(0), f)).length, redAuto: auto?.points ?? 0, redAutoTips: auto?.tips ?? 0, redHopperAfterAuto: hopper, redPark: r.park, stalls, rp: Object.values(r.rp).filter(Boolean).length + (r.total > b.total ? 3 : r.total === b.total ? 1 : 0) }));
