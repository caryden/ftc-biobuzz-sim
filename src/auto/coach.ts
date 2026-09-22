import { Defender } from './defend';
import { Executor } from './executor';
import { scriptedTeleop } from './policy';
import { AUTO_TREES, AutoProgram, autoFor } from './onboard';
import { NO_INPUT, type Inputs, type Sim } from '../sim/world';

/**
 * Drives one robot for a program: a named AUTO tree (see `AutoProgram`) in AUTO, and the scripted policy
 * (`scriptedTeleop`) in TELEOP. The policy picks a tactic when the running tactic finishes and at least once per second.
 */
export class Coach {
  executor = new Executor();
  autoRoutine = 'cycle_and_park';
  /**
   * The defense policy in TELEOP. `full`: the robot defends for the whole period (see `Defender`). `opportunistic`: the
   * robot plays its normal cycle and bumps an opponent that is lined up to launch next to it. Default: none.
   */
  defense: 'none' | 'full' | 'opportunistic' = 'none'; defender = new Defender();
  /** FLOWER work starts when this many seconds remain in TELEOP. Default: 0, which means TIPS only. */
  flowerStartSec = 0;
  private nextReview = 0; private t = 0;
  /** The running AUTO tree, or null before AUTO. */
  auto: AutoProgram | null = null; private autoName = '';
  /** For experiments: an AUTO tree name that bypasses the partner mapping. */
  autoOverride: string | null = null;

  /** Gets the inputs for one physics step. Call it once per step while a program drives. */
  update(sim: Sim, dt: number): Inputs {
    this.t += dt; const ex = this.executor;
    // AUTO runs a tree in the onboard environment: poses, open-loop shots, and the camera, with no view of the balls or
    // other robots. An unknown name runs cycle_and_park.
    if (sim.phase === 'auto') {
      const name = this.autoOverride ?? autoFor(sim, this.autoRoutine);
      if (!this.auto || this.autoName !== name) { this.autoName = name; this.auto = new AutoProgram(AUTO_TREES[name] ?? AUTO_TREES.cycle_and_park); }
      return this.auto.update(sim, dt);
    }
    // The planner runs only in TELEOP. In the transition the sim ignores every command, so a running executor would
    // see no progress, report a stall, and start TELEOP with its first goals on the skip list.
    if (sim.phase !== 'teleop') return NO_INPUT;
    if (this.defense === 'full') return this.defender.update(sim, dt);
    ex.opportunistic = this.defense === 'opportunistic';
    ex.nectarReserve = sim.timer < 75 ? 1 : 0; // Near the endgame, always keep a NECTAR for a FLOWER cap.
    if (ex.status !== 'in_progress' || this.t >= this.nextReview) { const d = scriptedTeleop(sim, this.flowerStartSec, ex.avoidedFlowers()); ex.setTactic(d.tactic, d.flower); this.nextReview = this.t + 1; }
    return ex.update(sim, dt);
  }
}
