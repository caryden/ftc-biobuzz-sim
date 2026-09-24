/**
 * The shooter subsystem's fire control: `canShoot` says whether a launch now enters the raised CELL. The planner asks
 * it before each launch; aiming belongs to the shooter. See the Subsystems section of docs/behavior-trees.md.
 *
 * The robot must be still, and the mean shot preview must enter the CELL. The planner also requires the robot to be at
 * its launch spot, whose distance gives the margin for launch error. A turret robot that fired on the move, as soon as
 * the preview scored, lost points (e82 in experiments/policy-loop.md): on the move the preview disagrees with the
 * launch, so it isn't a fire-control check there.
 */
import type { Sim } from '../sim/world';

export class Shooter {
  /**
   * Checks whether a launch of `kind` now enters the raised CELL of the robot's own HIVE.
   * @param requireCalm If true, the HIVE must be still too: the prediction uses the CELL's pose now, and a CELL that
   *   rocks has moved by the time the element arrives.
   */
  canShoot(sim: Sim, kind: 'pollen' | 'nectar', requireCalm: boolean): boolean {
    const calm = !requireCalm || Math.abs(sim.hives[sim.alliance].body.angvel().x) < 0.35;
    return calm && sim.telemetry.speed < 0.2 && Math.abs(sim.robot.angvel().y) < 0.3 && sim.previewShot(kind).scores;
  }
}
