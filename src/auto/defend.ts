import type { Inputs, Sim } from '../sim/world';
import { NO_INPUT } from '../sim/world';
import { parkGoal, parkLeadSec } from './executor';
import { pursue } from './follow';
import { fieldObstacles, planPath, type Pt } from './planner';

/** How long one contact burst on an opponent lasts, and how long that opponent is then left alone. G421 calls a PIN after a 3 s count, and the count ends after 3 s apart. */
const BURST_SEC = 1.6, REST_SEC = 3.5;

/**
 * Full defense: the robot spends TELEOP on the opponent that has the most to lose. It reads what a human defender reads:
 * which opponent carries a load, and which launch spot that opponent drives to. If it can reach that spot first, it
 * takes the spot. Otherwise it drives into the opponent, which knocks the opponent off its aim. It never holds one
 * opponent for more than `BURST_SEC`, and it parks on time.
 * The only contact rule in the simulator is G421 (PINS). Check the Competition Manual for the contact rules of your game.
 */
export class Defender {
  note = ''; path: Pt[] = [];
  private t = 0; private contact = 0; private target = -1; private restUntil: Record<number, number> = {}; private replanAt = 0; private goalKey = '';

  update(sim: Sim, dt: number): Inputs {
    this.t += dt; const p = sim.robot.translation(), here = { x: p.x, z: p.z }, R = Math.hypot(sim.cfg.length, sim.cfg.width) / 2;
    let goal: Pt, heading: number | null = null, ram = false;
    if (sim.timer <= parkLeadSec(sim)) { goal = parkGoal(sim); this.note = 'park guard'; }
    else {
      const foes = sim.otherRobots().filter(o => o.alliance !== sim.alliance && (this.restUntil[o.slot] ?? 0) <= this.t);
      // The opponent that is about to launch a big load is worth the most. A loaded opponent that still collects comes next.
      const worth = (o: (typeof foes)[number]) => (o.plan.phase === 'launch' ? 2 + o.plan.load : 0.5 * o.carried.length) - 0.3 * Math.hypot(o.x - p.x, o.z - p.z);
      const foe = foes.sort((a, b) => worth(b) - worth(a))[0];
      if (!foe) { goal = { x: (sim.alliance === 'red' ? -1 : 1) * 0.9, z: 0 }; this.note = 'defense: both opponents rest'; this.contact = 0; }
      else {
        if (foe.slot !== this.target) { this.target = foe.slot; this.contact = 0; }
        const spot = foe.plan.phase === 'launch' ? foe.plan.goal : null, mine = spot ? Math.hypot(spot.x - p.x, spot.z - p.z) : Infinity, theirs = spot ? Math.hypot(spot.x - foe.x, spot.z - foe.z) : 0;
        if (spot && mine < theirs - 0.2) { goal = spot; heading = Math.atan2(-(foe.z - p.z), foe.x - p.x); this.note = 'defense: take the launch spot'; }
        else { goal = { x: foe.x, z: foe.z }; ram = true; this.note = 'defense: drive into the opponent'; }
        // A burst of contact, and then this opponent rests, so that no PIN count reaches 3 s.
        this.contact = Math.hypot(foe.x - p.x, foe.z - p.z) < foe.r + R + 0.12 ? this.contact + dt : Math.max(0, this.contact - dt);
        if (this.contact > BURST_SEC) { this.restUntil[foe.slot] = this.t + REST_SEC; this.contact = 0; this.target = -1; }
      }
    }
    const key = `${goal.x.toFixed(1)},${goal.z.toFixed(1)}`;
    if (this.t >= this.replanAt || key !== this.goalKey) { this.path = ram ? [here, goal] : planPath(here, goal, R, fieldObstacles()); this.replanAt = this.t + 0.15; this.goalKey = key; }
    const cmd = pursue(sim, this.path, heading);
    return { ...NO_INPUT, forward: cmd.forward, strafeRight: cmd.strafeRight, turnRight: cmd.turnRight, intake: 'none' };
  }
}
