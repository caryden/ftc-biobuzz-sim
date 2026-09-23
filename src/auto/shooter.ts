/**
 * The shooter subsystem's fire control: `canShoot` says whether a launch now enters the raised CELL. The planner asks
 * it and fires; aiming belongs to the shooter. See the Subsystems section of docs/behavior-trees.md.
 *
 * - A fixed or two-sided shooter aims with the robot's heading. It can shoot when the robot is still and the mean shot
 *   enters the CELL. The planner also requires the robot to be at its launch spot, as before.
 * - A turret aims itself (`ShooterConfig.turret`), so it can shoot from anywhere, on the move. Without the launch spot's
 *   margin, the mean shot isn't enough: the first point on the way in where the mean shot scores is the edge of the
 *   region, where most real shots miss. So a turret can shoot when the mean shot and the six shots one standard
 *   deviation off, in elevation, speed, and azimuth one at a time, all enter the CELL.
 */
import type { Sim } from '../sim/world';

/** How often a turret checks its seven shot predictions, in seconds. Each prediction integrates up to 240 steps. */
const TURRET_CHECK_SEC = 0.05;

export class Shooter {
  private last = { timer: Number.NaN, kind: '', ok: false };

  /**
   * Checks whether a launch of `kind` now enters the raised CELL of the robot's own HIVE.
   * @param requireCalm If true, the HIVE must be still too: the prediction uses the CELL's pose now, and a CELL that
   *   rocks has moved by the time the element arrives.
   */
  canShoot(sim: Sim, kind: 'pollen' | 'nectar', requireCalm: boolean): boolean {
    const calm = !requireCalm || Math.abs(sim.hives[sim.alliance].body.angvel().x) < 0.35;
    if (!sim.cfg.shooter.turret) return calm && sim.telemetry.speed < 0.2 && Math.abs(sim.robot.angvel().y) < 0.3 && sim.previewShot(kind).scores;
    if (!calm) return false;
    // The period clock counts down, so a check is fresh while the clock has moved less than the check period.
    if (this.last.kind === kind && Math.abs(this.last.timer - sim.timer) < TURRET_CHECK_SEC - 1e-9) return this.last.ok;
    const lp = kind === 'pollen' ? sim.cfg.shooter.pollen : sim.cfg.shooter.nectar;
    const offs = [{}, { elevationDeg: lp.elevationDeg.std }, { elevationDeg: -lp.elevationDeg.std }, { speed: lp.speed.std }, { speed: -lp.speed.std }, { yawDeg: lp.yawStdDeg }, { yawDeg: -lp.yawStdDeg }];
    const ok = offs.every(off => sim.previewShot(kind, undefined, off).scores);
    this.last = { timer: sim.timer, kind, ok };
    return ok;
  }
}
