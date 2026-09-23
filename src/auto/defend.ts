import type { Inputs, Sim } from '../sim/world';
import { NO_INPUT } from '../sim/world';
import { parkGoal, parkLeadSec } from './executor';
import { pursue } from './follow';
import { fieldObstacles, planPath, type Pt } from './planner';

/** How long one contact burst on an opponent lasts, and how long that opponent is then left alone. G421 calls a PIN after a 3 s count, and the count ends after 3 s apart. */
const BURST_SEC = 1.6, REST_SEC = 3.5;

/**
 * Full defense: the robot spends TELEOP on the opponent that has the most to lose. It reads what a human defender reads:
 * which opponent carries a load, and which launch spot that opponent drives to. The TELEOP tree's `defend` subtree
 * decides what to do on each step: PARK on time, wait while both opponents rest, take the target's launch spot if this
 * robot gets there first, or drive into the target, which knocks it off its aim. This class picks the target, keeps
 * the bookkeeping, and drives. It never holds one opponent for more than `BURST_SEC`.
 * The only contact rule in the simulator is G421 (PINS). Check the Competition Manual for the contact rules of your game.
 */
export class Defender {
  note = ''; path: Pt[] = [];
  private t = 0; private contact = 0; private target = -1; private restUntil: Record<number, number> = {}; private replanAt = 0; private goalKey = '';

  /**
   * Gets the opponent that is worth defending on the coming step, or null if both opponents rest. The opponent that is
   * about to launch a big load is worth the most, and a loaded opponent that still collects comes next. `mine` and
   * `theirs` are this robot's and the opponent's distances to the opponent's launch spot, or Infinity and 0 if it
   * isn't launching. It changes nothing, so a tree can read it before it decides.
   */
  targetFor(sim: Sim, dt: number): { slot: number; mine: number; theirs: number } | null {
    const t = this.t + dt, p = sim.robot.translation();
    const foes = sim.otherRobots().filter(o => o.alliance !== sim.alliance && (this.restUntil[o.slot] ?? 0) <= t);
    const worth = (o: (typeof foes)[number]) => (o.plan.phase === 'launch' ? 2 + o.plan.load : 0.5 * o.carried.length) - 0.3 * Math.hypot(o.x - p.x, o.z - p.z);
    const foe = foes.sort((a, b) => worth(b) - worth(a))[0];
    if (!foe) return null;
    const spot = foe.plan.phase === 'launch' ? foe.plan.goal : null;
    return { slot: foe.slot, mine: spot ? Math.hypot(spot.x - p.x, spot.z - p.z) : Infinity, theirs: spot ? Math.hypot(spot.x - foe.x, spot.z - foe.z) : 0 };
  }

  /** Drives to the PARK. The TELEOP tree calls it when the clock requires the PARK. */
  park(sim: Sim, dt: number): Inputs { this.t += dt; this.note = 'park guard'; return this.drive(sim, parkGoal(sim), null, false); }

  /** Waits near the FIELD center while both opponents rest. */
  wait(sim: Sim, dt: number): Inputs {
    this.t += dt; this.note = 'defense: both opponents rest'; this.contact = 0;
    return this.drive(sim, { x: (sim.alliance === 'red' ? -1 : 1) * 0.9, z: 0 }, null, false);
  }

  /**
   * Engages the opponent in `slot`: takes its launch spot if `takeSpot`, and otherwise drives into it. A burst of
   * contact longer than `BURST_SEC` makes that opponent rest for `REST_SEC`, so that no PIN count reaches 3 s.
   */
  engage(sim: Sim, dt: number, slot: number, takeSpot: boolean): Inputs {
    this.t += dt;
    const foe = sim.otherRobots().find(o => o.alliance !== sim.alliance && o.slot === slot);
    if (!foe) return this.wait(sim, 0);
    const p = sim.robot.translation(), R = Math.hypot(sim.cfg.length, sim.cfg.width) / 2;
    if (foe.slot !== this.target) { this.target = foe.slot; this.contact = 0; }
    let goal: Pt, heading: number | null = null;
    if (takeSpot && foe.plan.phase === 'launch' && foe.plan.goal) { goal = foe.plan.goal; heading = Math.atan2(-(foe.z - p.z), foe.x - p.x); this.note = 'defense: take the launch spot'; }
    else { goal = { x: foe.x, z: foe.z }; this.note = 'defense: drive into the opponent'; }
    this.contact = Math.hypot(foe.x - p.x, foe.z - p.z) < foe.r + R + 0.12 ? this.contact + dt : Math.max(0, this.contact - dt);
    if (this.contact > BURST_SEC) { this.restUntil[foe.slot] = this.t + REST_SEC; this.contact = 0; this.target = -1; }
    return this.drive(sim, goal, heading, !takeSpot);
  }

  /** Follows a path to `goal`: a straight line when ramming, and a planned path otherwise, replanned every 0.15 s. */
  private drive(sim: Sim, goal: Pt, heading: number | null, ram: boolean): Inputs {
    const p = sim.robot.translation(), here = { x: p.x, z: p.z }, R = Math.hypot(sim.cfg.length, sim.cfg.width) / 2;
    const key = `${goal.x.toFixed(1)},${goal.z.toFixed(1)}`;
    if (this.t >= this.replanAt || key !== this.goalKey) { this.path = ram ? [here, goal] : planPath(here, goal, R, fieldObstacles()); this.replanAt = this.t + 0.15; this.goalKey = key; }
    const cmd = pursue(sim, this.path, heading);
    return { ...NO_INPUT, forward: cmd.forward, strafeRight: cmd.strafeRight, turnRight: cmd.turnRight, intake: 'none' };
  }
}
