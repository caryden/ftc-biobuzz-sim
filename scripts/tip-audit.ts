// Audits every red TIP in a scripted match: elements launched, CELL load when the HIVE starts to swing, and waste.
// Run: npx tsx scripts/tip-audit.ts [seed] [opponent|none]
import RAPIER from '@dimforge/rapier3d-compat';
import { HIVE, TIP_LOAD } from '../src/sim/config';
import { Coach } from '../src/auto/coach';
import { DT, Sim } from '../src/sim/world';

await RAPIER.init();
const sim = new Sim(RAPIER, undefined, 'full', Number(process.argv[2] ?? 3), { opponent: process.argv[3] !== 'none' }); sim.start();
const coaches = sim.robots.map(() => { const c = new Coach(); c.flowerStartSec = 0; return c; });
let launched = 0, launchedLoad = 0, prevCarried = sim.robots[0].carried.length, swinging = false, lastLoad = 0, lastCount = 0; const ids = new Set(sim.balls.keys());
console.log('phase   clock  launched  load launched  CELL load at swing  in CELL  beyond 7.4  landed elsewhere');
while (sim.phase !== 'post') {
  sim.step(coaches.map((c, i) => c.update(sim.view(i), DT)), sim.robots.map(() => true));
  for (const [id, b] of sim.balls) if (!ids.has(id)) { ids.add(id); // A new airborne ball near the red LOADING ZONE is the HUMAN PLAYER's NECTAR entry, not a launch.
    if (b.airborne && b.kind !== 'nectar_blue' && b.body.translation().x < 0 && b.body.translation().x > -1.2) { launched++; launchedLoad += b.kind === 'pollen' ? 1 : TIP_LOAD.nectar; } }
  const hive = sim.hives.red, moving = Math.abs(Math.abs(hive.phi) - HIVE.tiltLimit) > 0.05;
  if (!moving) { lastLoad = sim.cellLoad('red'); lastCount = sim.cellCount('red'); }
  if (moving && !swinging) {
    const staged = sim.hives.red.tips === 0 ? 3 * TIP_LOAD.nectar : 0; // The first CELL starts with 3 NECTAR.
    console.log(`${sim.phase.padEnd(7)} ${sim.timer.toFixed(0).padStart(4)}s ${String(launched).padStart(8)} ${launchedLoad.toFixed(1).padStart(13)} ${lastLoad.toFixed(1).padStart(18)} ${String(lastCount).padStart(9)} ${(lastLoad - TIP_LOAD.threshold).toFixed(1).padStart(10)} ${(launchedLoad + staged - lastLoad).toFixed(1).padStart(16)}`);
    launched = 0; launchedLoad = 0;
  }
  swinging = moving; prevCarried = sim.robots[0].carried.length;
}
void prevCarried;
